const express = require('express');
const { createServer } = require('http');
const { SMTPServer } = require('smtp-server');
const admin = require('firebase-admin');
const redis = require('redis');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const winston = require('winston');
const cron = require('node-cron');
const net = require('net');
const { parse } = require('mailparser');

// Initialize Firebase Admin
const serviceAccount = require('./firebase-service-account.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
});

// Initialize Redis for session management
const redisClient = redis.createClient({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379
});

redisClient.on('error', (err) => {
    console.error('Redis Client Error:', err);
});

// Initialize logger
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: '/var/log/vcmail/error.log', level: 'error' }),
        new winston.transports.File({ filename: '/var/log/vcmail/combined.log' }),
        new winston.transports.Console({
            format: winston.format.simple()
        })
    ]
});

// Create Express app
const app = express();
app.use(helmet());
app.use(cors());
app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));
app.use(express.json());

// Custom POP3 Server Implementation
class VCMailPop3Server {
    constructor() {
        this.server = null;
        this.connections = new Map();
        this.port = process.env.POP3_PORT || 110;
        this.sslPort = process.env.POP3_SSL_PORT || 995;
    }

    async start() {
        // Start non-SSL POP3 server
        this.server = net.createServer((socket) => {
            this.handleConnection(socket);
        });

        this.server.listen(this.port, () => {
            logger.info(`POP3 server running on port ${this.port}`);
        });

        // Start SSL POP3 server if SSL certificates are available
        if (process.env.SSL_CERT_FILE && process.env.SSL_KEY_FILE) {
            const tls = require('tls');
            const fs = require('fs');
            
            const sslServer = tls.createServer({
                cert: fs.readFileSync(process.env.SSL_CERT_FILE),
                key: fs.readFileSync(process.env.SSL_KEY_FILE)
            }, (socket) => {
                this.handleConnection(socket);
            });

            sslServer.listen(this.sslPort, () => {
                logger.info(`POP3 SSL server running on port ${this.sslPort}`);
            });
        }
    }

    handleConnection(socket) {
        const connectionId = this.generateConnectionId();
        const connection = {
            id: connectionId,
            socket: socket,
            state: 'AUTHORIZATION',
            user: null,
            uid: null,
            lastCheckTime: null,
            authenticated: false
        };

        this.connections.set(connectionId, connection);

        // Send welcome message
        socket.write('+OK VCMail POP3 Server Ready\r\n');

        socket.on('data', (data) => {
            this.handleCommand(connection, data.toString().trim());
        });

        socket.on('close', () => {
            this.connections.delete(connectionId);
            logger.info(`POP3 connection ${connectionId} closed`);
        });

        socket.on('error', (error) => {
            logger.error(`POP3 connection ${connectionId} error:`, error);
            this.connections.delete(connectionId);
        });

        logger.info(`New POP3 connection ${connectionId} from ${socket.remoteAddress}`);
    }

    async handleCommand(connection, command) {
        const parts = command.split(' ');
        const cmd = parts[0].toUpperCase();

        try {
            switch (connection.state) {
                case 'AUTHORIZATION':
                    await this.handleAuthorizationCommand(connection, cmd, parts);
                    break;
                case 'TRANSACTION':
                    await this.handleTransactionCommand(connection, cmd, parts);
                    break;
                case 'UPDATE':
                    await this.handleUpdateCommand(connection, cmd, parts);
                    break;
                default:
                    connection.socket.write('-ERR Unknown state\r\n');
            }
        } catch (error) {
            logger.error(`Error handling POP3 command ${cmd}:`, error);
            connection.socket.write('-ERR Internal server error\r\n');
        }
    }

    async handleAuthorizationCommand(connection, cmd, parts) {
        switch (cmd) {
            case 'USER':
                if (parts.length < 2) {
                    connection.socket.write('-ERR USER command requires username\r\n');
                    return;
                }
                connection.user = parts[1];
                connection.socket.write('+OK Username accepted\r\n');
                break;

            case 'PASS':
                if (parts.length < 2) {
                    connection.socket.write('-ERR PASS command requires password\r\n');
                    return;
                }
                if (!connection.user) {
                    connection.socket.write('-ERR USER command required first\r\n');
                    return;
                }
                
                const authenticated = await this.authenticateUser(connection.user, parts[1]);
                if (authenticated.success) {
                    connection.uid = authenticated.uid;
                    connection.authenticated = true;
                    connection.state = 'TRANSACTION';
                    connection.socket.write('+OK User authenticated\r\n');
                    logger.info(`POP3 user ${connection.user} authenticated successfully`);
                } else {
                    connection.socket.write('-ERR Authentication failed\r\n');
                    logger.warn(`POP3 authentication failed for user ${connection.user}`);
                }
                break;

            case 'QUIT':
                connection.socket.write('+OK Goodbye\r\n');
                connection.socket.end();
                break;

            default:
                connection.socket.write('-ERR Unknown command in AUTHORIZATION state\r\n');
        }
    }

    async handleTransactionCommand(connection, cmd, parts) {
        if (!connection.authenticated) {
            connection.socket.write('-ERR Not authenticated\r\n');
            return;
        }

        switch (cmd) {
            case 'STAT':
                await this.handleStat(connection);
                break;

            case 'LIST':
                await this.handleList(connection, parts);
                break;

            case 'RETR':
                await this.handleRetr(connection, parts);
                break;

            case 'DELE':
                // VCMail doesn't allow deletes - emails persist on server
                connection.socket.write('-ERR VCMail does not support email deletion\r\n');
                break;

            case 'NOOP':
                connection.socket.write('+OK No operation\r\n');
                break;

            case 'RSET':
                // Reset any pending deletes (none in our case)
                connection.socket.write('+OK Reset\r\n');
                break;

            case 'QUIT':
                connection.state = 'UPDATE';
                connection.socket.write('+OK Goodbye\r\n');
                connection.socket.end();
                break;

            default:
                connection.socket.write('-ERR Unknown command in TRANSACTION state\r\n');
        }
    }

    async handleUpdateCommand(connection, cmd, parts) {
        // In UPDATE state, only QUIT is allowed
        if (cmd === 'QUIT') {
            connection.socket.write('+OK Goodbye\r\n');
            connection.socket.end();
        } else {
            connection.socket.write('-ERR Session terminated\r\n');
        }
    }

    async authenticateUser(username, password) {
        try {
            // Authenticate against Firebase
            const user = await admin.auth().getUserByEmail(username);
            if (user) {
                return { success: true, uid: user.uid };
            }
            return { success: false, error: 'User not found' };
        } catch (error) {
            logger.error('POP3 authentication error:', error);
            return { success: false, error: 'Authentication failed' };
        }
    }

    async handleStat(connection) {
        try {
            const emails = await this.getUserEmails(connection.uid);
            const totalSize = emails.reduce((sum, email) => sum + (email.size || 0), 0);
            
            connection.socket.write(`+OK ${emails.length} ${totalSize}\r\n`);
        } catch (error) {
            logger.error('Error in STAT command:', error);
            connection.socket.write('-ERR Failed to get mailbox statistics\r\n');
        }
    }

    async handleList(connection, parts) {
        try {
            const emails = await this.getUserEmails(connection.uid);
            
            if (parts.length > 1) {
                // LIST with specific message number
                const messageNum = parseInt(parts[1]);
                if (messageNum > 0 && messageNum <= emails.length) {
                    const email = emails[messageNum - 1];
                    connection.socket.write(`+OK ${messageNum} ${email.size || 0}\r\n`);
                } else {
                    connection.socket.write('-ERR No such message\r\n');
                }
            } else {
                // LIST all messages
                connection.socket.write(`+OK ${emails.length} messages\r\n`);
                emails.forEach((email, index) => {
                    connection.socket.write(`${index + 1} ${email.size || 0}\r\n`);
                });
                connection.socket.write('.\r\n');
            }
        } catch (error) {
            logger.error('Error in LIST command:', error);
            connection.socket.write('-ERR Failed to list messages\r\n');
        }
    }

    async handleRetr(connection, parts) {
        try {
            if (parts.length < 2) {
                connection.socket.write('-ERR RETR command requires message number\r\n');
                return;
            }

            const messageNum = parseInt(parts[1]);
            const emails = await this.getUserEmails(connection.uid);
            
            if (messageNum > 0 && messageNum <= emails.length) {
                const email = emails[messageNum - 1];
                const emailContent = await this.getEmailContent(connection.uid, email.id);
                
                connection.socket.write(`+OK ${email.size || 0} octets\r\n`);
                connection.socket.write(emailContent);
                connection.socket.write('\r\n.\r\n');
                
                // Update last check time for this user
                await this.updateLastCheckTime(connection.uid);
            } else {
                connection.socket.write('-ERR No such message\r\n');
            }
        } catch (error) {
            logger.error('Error in RETR command:', error);
            connection.socket.write('-ERR Failed to retrieve message\r\n');
        }
    }

    async getUserEmails(uid) {
        try {
            const db = admin.database();
            const emailsRef = db.ref(`emails/${uid}`).orderByChild('timestamp');
            const snapshot = await emailsRef.once('value');
            const emails = snapshot.val() || {};
            
            // Convert to array and sort by timestamp (oldest first for POP3)
            const emailArray = Object.entries(emails).map(([id, email]) => ({
                id,
                ...email
            })).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            
            return emailArray;
        } catch (error) {
            logger.error('Error getting user emails:', error);
            return [];
        }
    }

    async getEmailContent(uid, emailId) {
        try {
            const db = admin.database();
            const emailRef = db.ref(`emails/${uid}/${emailId}`);
            const snapshot = await emailRef.once('value');
            const email = snapshot.val();
            
            if (!email) {
                throw new Error('Email not found');
            }
            
            // Format email in RFC 2822 format
            const emailContent = this.formatEmailForPOP3(email);
            return emailContent;
        } catch (error) {
            logger.error('Error getting email content:', error);
            throw error;
        }
    }

    formatEmailForPOP3(email) {
        const headers = [];
        
        // Required headers
        headers.push(`From: ${email.from || 'unknown@example.com'}`);
        headers.push(`To: ${email.to || 'unknown@example.com'}`);
        headers.push(`Subject: ${email.subject || 'No Subject'}`);
        headers.push(`Date: ${new Date(email.timestamp || Date.now()).toUTCString()}`);
        headers.push(`Message-ID: <${email.messageId || email.id}@vcmail.local>`);
        
        // Content headers
        if (email.contentType) {
            headers.push(`Content-Type: ${email.contentType}`);
        } else {
            headers.push('Content-Type: text/plain; charset=utf-8');
        }
        
        // Additional headers from original email
        if (email.headers) {
            Object.entries(email.headers).forEach(([key, value]) => {
                if (!['from', 'to', 'subject', 'date', 'message-id', 'content-type'].includes(key.toLowerCase())) {
                    headers.push(`${key}: ${value}`);
                }
            });
        }
        
        // Combine headers and body
        const emailContent = headers.join('\r\n') + '\r\n\r\n' + (email.content || email.body || '');
        
        return emailContent;
    }

    async updateLastCheckTime(uid) {
        try {
            const db = admin.database();
            const lastCheckRef = db.ref(`users/${uid}/lastPop3Check`);
            await lastCheckRef.set(Date.now());
        } catch (error) {
            logger.error('Error updating last check time:', error);
        }
    }

    generateConnectionId() {
        return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }

    stop() {
        if (this.server) {
            this.server.close();
            logger.info('POP3 server stopped');
        }
    }
}

// Custom SMTP Server Implementation (simplified)
class VCMailSmtpServer {
    constructor() {
        this.server = new SMTPServer({
            name: 'vcmail-server',
            banner: 'VCMail SMTP Server Ready',
            authMethods: ['PLAIN', 'LOGIN'],
            onAuth: this.handleAuth.bind(this),
            onMailFrom: this.handleMailFrom.bind(this),
            onRcptTo: this.handleRcptTo.bind(this),
            onData: this.handleData.bind(this)
        });
    }

    async handleAuth(auth, session, callback) {
        try {
            // Authenticate against Firebase
            const user = await admin.auth().getUserByEmail(auth.username);
            if (user) {
                session.user = {
                    username: auth.username,
                    uid: user.uid
                };
                callback(null, { user: auth.username });
            } else {
                callback(new Error('Invalid credentials'));
            }
        } catch (error) {
            logger.error('SMTP Authentication error:', error);
            callback(new Error('Authentication failed'));
        }
    }

    async handleMailFrom(address, session, callback) {
        try {
            // Validate sender
            if (!session.user) {
                callback(new Error('Not authenticated'));
                return;
            }

            // Check if sender email matches user's email
            const userEmail = `${session.user.username}@voicecert.com`;
            if (address.address !== userEmail) {
                callback(new Error('Sender email does not match authenticated user'));
                return;
            }

            session.envelope = session.envelope || {};
            session.envelope.mailFrom = address;
            callback();
        } catch (error) {
            logger.error('Error handling mail from:', error);
            callback(new Error('Invalid sender'));
        }
    }

    async handleRcptTo(address, session, callback) {
        try {
            // Validate recipient
            if (!session.envelope) {
                callback(new Error('No sender specified'));
                return;
            }

            session.envelope.rcptTo = session.envelope.rcptTo || [];
            session.envelope.rcptTo.push(address);
            callback();
        } catch (error) {
            logger.error('Error handling recipient:', error);
            callback(new Error('Invalid recipient'));
        }
    }

    async handleData(stream, session, callback) {
        let data = '';
        stream.on('data', chunk => {
            data += chunk.toString();
        });
        
        stream.on('end', async () => {
            try {
                // Parse email data
                const parsed = await parse(data);
                
                // Store email in Firebase
                await this.storeEmailInFirebase(parsed, session);
                
                logger.info('Email stored successfully');
                callback();
            } catch (error) {
                logger.error('Error storing email:', error);
                callback(new Error('Failed to store email'));
            }
        });
    }

    async storeEmailInFirebase(parsed, session) {
        try {
            const db = admin.database();
            const emailRef = db.ref('emails').push();
            
            const emailData = {
                messageId: parsed.messageId,
                from: parsed.from?.text || session.envelope.mailFrom.address,
                to: parsed.to?.text || session.envelope.rcptTo.map(rcpt => rcpt.address).join(', '),
                subject: parsed.subject || 'No Subject',
                content: parsed.html || parsed.text || '',
                contentType: parsed.html ? 'text/html' : 'text/plain',
                timestamp: Date.now(),
                size: parsed.size || 0,
                headers: parsed.headers,
                attachments: parsed.attachments || []
            };

            await emailRef.set(emailData);
            
            // Store in user's sent folder
            const sentRef = db.ref(`sent/${session.user.uid}`).push();
            await sentRef.set(emailData);
            
            logger.info('Email stored in Firebase successfully');
        } catch (error) {
            logger.error('Error storing email in Firebase:', error);
            throw error;
        }
    }

    listen(port) {
        this.server.listen(port, () => {
            logger.info(`SMTP server running on port ${port}`);
        });
    }
}

// Initialize servers
const pop3Server = new VCMailPop3Server();
const smtpServer = new VCMailSmtpServer();

// API Routes for health check and monitoring
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        services: {
            firebase: 'connected',
            redis: 'connected',
            pop3: 'running',
            smtp: 'running'
        }
    });
});

// Start servers
const httpServer = createServer(app);
const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
    logger.info(`HTTP server running on port ${PORT}`);
});

// Start POP3 and SMTP servers
pop3Server.start();
smtpServer.listen(25);

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully');
    httpServer.close(() => {
        pop3Server.stop();
        smtpServer.server.close();
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down gracefully');
    httpServer.close(() => {
        pop3Server.stop();
        smtpServer.server.close();
        process.exit(0);
    });
});

module.exports = { app, pop3Server, smtpServer };
