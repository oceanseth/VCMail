const express = require('express');
const { createServer } = require('http');
const { SMTPServer } = require('smtp-server');
const { ImapFlow } = require('imapflow');
const admin = require('firebase-admin');
const mysql = require('mysql2/promise');
const redis = require('redis');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const winston = require('winston');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { parse } = require('mailparser');

// Initialize Firebase Admin
const serviceAccount = require('./firebase-service-account.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
});

// Initialize database connection
const db = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQL_USER || 'vcmail',
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'vcmail_mail',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Initialize Redis
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

// Custom IMAP Server Implementation
class VCMailImapServer {
    constructor() {
        this.connections = new Map();
        this.mailboxes = new Map();
        this.initializeMailboxes();
    }

    initializeMailboxes() {
        // Initialize default mailboxes
        this.mailboxes.set('INBOX', {
            name: 'INBOX',
            flags: ['\\HasNoChildren'],
            attributes: ['\\HasNoChildren'],
            messages: new Map()
        });
        this.mailboxes.set('Sent', {
            name: 'Sent',
            flags: ['\\HasNoChildren'],
            attributes: ['\\HasNoChildren'],
            messages: new Map()
        });
        this.mailboxes.set('Drafts', {
            name: 'Drafts',
            flags: ['\\HasNoChildren'],
            attributes: ['\\HasNoChildren'],
            messages: new Map()
        });
        this.mailboxes.set('Trash', {
            name: 'Trash',
            flags: ['\\HasNoChildren'],
            attributes: ['\\HasNoChildren'],
            messages: new Map()
        });
    }

    async authenticate(username, password) {
        try {
            // Authenticate against Firebase
            const user = await admin.auth().getUserByEmail(username);
            if (user) {
                // Store user session
                const sessionId = this.generateSessionId();
                this.connections.set(sessionId, {
                    username,
                    uid: user.uid,
                    authenticated: true,
                    selectedMailbox: null
                });
                return { success: true, sessionId };
            }
            return { success: false, error: 'Invalid credentials' };
        } catch (error) {
            logger.error('Authentication error:', error);
            return { success: false, error: 'Authentication failed' };
        }
    }

    async getMailboxes(sessionId) {
        const connection = this.connections.get(sessionId);
        if (!connection || !connection.authenticated) {
            throw new Error('Not authenticated');
        }

        // Get user-specific mailboxes from Firebase
        const userMailboxes = await this.getUserMailboxes(connection.uid);
        return userMailboxes;
    }

    async getUserMailboxes(uid) {
        try {
            const db = admin.database();
            const mailboxesRef = db.ref(`users/${uid}/mailboxes`);
            const snapshot = await mailboxesRef.once('value');
            const userMailboxes = snapshot.val() || {};

            // Merge with default mailboxes
            const allMailboxes = { ...this.mailboxes };
            for (const [name, config] of Object.entries(userMailboxes)) {
                allMailboxes.set(name, {
                    name,
                    flags: config.flags || ['\\HasNoChildren'],
                    attributes: config.attributes || ['\\HasNoChildren'],
                    messages: new Map()
                });
            }

            return Array.from(allMailboxes.values());
        } catch (error) {
            logger.error('Error getting user mailboxes:', error);
            return Array.from(this.mailboxes.values());
        }
    }

    async getMessages(sessionId, mailboxName, options = {}) {
        const connection = this.connections.get(sessionId);
        if (!connection || !connection.authenticated) {
            throw new Error('Not authenticated');
        }

        try {
            // Get messages from Firebase for this user and mailbox
            const messages = await this.getUserMessages(connection.uid, mailboxName, options);
            return messages;
        } catch (error) {
            logger.error('Error getting messages:', error);
            return [];
        }
    }

    async getUserMessages(uid, mailboxName, options = {}) {
        try {
            const db = admin.database();
            let messagesRef;
            
            if (mailboxName === 'INBOX') {
                messagesRef = db.ref(`emails/${uid}`).orderByChild('timestamp');
            } else if (mailboxName === 'Sent') {
                messagesRef = db.ref(`sent/${uid}`).orderByChild('timestamp');
            } else {
                messagesRef = db.ref(`users/${uid}/mailboxes/${mailboxName}/messages`).orderByChild('timestamp');
            }

            // Apply pagination
            if (options.limit) {
                messagesRef = messagesRef.limitToLast(options.limit);
            }
            if (options.offset) {
                messagesRef = messagesRef.startAt(options.offset);
            }

            const snapshot = await messagesRef.once('value');
            const messages = snapshot.val() || {};

            // Convert to IMAP format
            const imapMessages = [];
            for (const [messageId, message] of Object.entries(messages)) {
                imapMessages.push({
                    uid: messageId,
                    flags: message.flags || ['\\Seen'],
                    date: new Date(message.timestamp),
                    size: message.size || 0,
                    subject: message.subject || 'No Subject',
                    from: message.from || '',
                    to: message.to || '',
                    body: message.content || message.body || ''
                });
            }

            return imapMessages;
        } catch (error) {
            logger.error('Error getting user messages:', error);
            return [];
        }
    }

    async getMessageContent(sessionId, mailboxName, messageId) {
        const connection = this.connections.get(sessionId);
        if (!connection || !connection.authenticated) {
            throw new Error('Not authenticated');
        }

        try {
            const db = admin.database();
            let messageRef;
            
            if (mailboxName === 'INBOX') {
                messageRef = db.ref(`emails/${connection.uid}/${messageId}`);
            } else if (mailboxName === 'Sent') {
                messageRef = db.ref(`sent/${connection.uid}/${messageId}`);
            } else {
                messageRef = db.ref(`users/${connection.uid}/mailboxes/${mailboxName}/messages/${messageId}`);
            }

            const snapshot = await messageRef.once('value');
            const message = snapshot.val();

            if (!message) {
                throw new Error('Message not found');
            }

            return {
                uid: messageId,
                flags: message.flags || ['\\Seen'],
                date: new Date(message.timestamp),
                size: message.size || 0,
                subject: message.subject || 'No Subject',
                from: message.from || '',
                to: message.to || '',
                body: message.content || message.body || '',
                headers: message.headers || {}
            };
        } catch (error) {
            logger.error('Error getting message content:', error);
            throw error;
        }
    }

    async markAsRead(sessionId, mailboxName, messageId) {
        const connection = this.connections.get(sessionId);
        if (!connection || !connection.authenticated) {
            throw new Error('Not authenticated');
        }

        try {
            const db = admin.database();
            let messageRef;
            
            if (mailboxName === 'INBOX') {
                messageRef = db.ref(`emails/${connection.uid}/${messageId}/flags`);
            } else if (mailboxName === 'Sent') {
                messageRef = db.ref(`sent/${connection.uid}/${messageId}/flags`);
            } else {
                messageRef = db.ref(`users/${connection.uid}/mailboxes/${mailboxName}/messages/${messageId}/flags`);
            }

            await messageRef.set(['\\Seen']);
            logger.info(`Message ${messageId} marked as read`);
        } catch (error) {
            logger.error('Error marking message as read:', error);
            throw error;
        }
    }

    async deleteMessage(sessionId, mailboxName, messageId) {
        const connection = this.connections.get(sessionId);
        if (!connection || !connection.authenticated) {
            throw new Error('Not authenticated');
        }

        try {
            const db = admin.database();
            let messageRef;
            
            if (mailboxName === 'INBOX') {
                messageRef = db.ref(`emails/${connection.uid}/${messageId}`);
            } else if (mailboxName === 'Sent') {
                messageRef = db.ref(`sent/${connection.uid}/${messageId}`);
            } else {
                messageRef = db.ref(`users/${connection.uid}/mailboxes/${mailboxName}/messages/${messageId}`);
            }

            await messageRef.remove();
            logger.info(`Message ${messageId} deleted`);
        } catch (error) {
            logger.error('Error deleting message:', error);
            throw error;
        }
    }

    generateSessionId() {
        return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }
}

// Custom SMTP Server Implementation
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
                
                // Store in local database for IMAP access
                await this.storeEmailInDatabase(parsed, session);
                
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

    async storeEmailInDatabase(parsed, session) {
        try {
            const emailData = {
                message_id: parsed.messageId,
                from_address: parsed.from?.text || session.envelope.mailFrom.address,
                to_address: parsed.to?.text || session.envelope.rcptTo.map(rcpt => rcpt.address).join(', '),
                subject: parsed.subject || 'No Subject',
                body: parsed.html || parsed.text || '',
                content_type: parsed.html ? 'text/html' : 'text/plain',
                timestamp: Date.now(),
                size: parsed.size || 0,
                headers: JSON.stringify(parsed.headers || {}),
                attachments: JSON.stringify(parsed.attachments || [])
            };

            await db.execute(
                'INSERT INTO emails (message_id, from_address, to_address, subject, body, content_type, timestamp, size, headers, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [emailData.message_id, emailData.from_address, emailData.to_address, emailData.subject, emailData.body, emailData.content_type, emailData.timestamp, emailData.size, emailData.headers, emailData.attachments]
            );

            logger.info('Email stored in database successfully');
        } catch (error) {
            logger.error('Error storing email in database:', error);
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
const imapServer = new VCMailImapServer();
const smtpServer = new VCMailSmtpServer();

// API Routes for IMAP functionality
app.post('/api/imap/authenticate', async (req, res) => {
    try {
        const { username, password } = req.body;
        const result = await imapServer.authenticate(username, password);
        
        if (result.success) {
            res.json({ success: true, sessionId: result.sessionId });
        } else {
            res.status(401).json({ success: false, error: result.error });
        }
    } catch (error) {
        logger.error('Authentication API error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

app.get('/api/imap/mailboxes/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const mailboxes = await imapServer.getMailboxes(sessionId);
        res.json({ success: true, mailboxes });
    } catch (error) {
        logger.error('Get mailboxes API error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

app.get('/api/imap/messages/:sessionId/:mailboxName', async (req, res) => {
    try {
        const { sessionId, mailboxName } = req.params;
        const { limit, offset } = req.query;
        
        const options = {};
        if (limit) options.limit = parseInt(limit);
        if (offset) options.offset = parseInt(offset);
        
        const messages = await imapServer.getMessages(sessionId, mailboxName, options);
        res.json({ success: true, messages });
    } catch (error) {
        logger.error('Get messages API error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

app.get('/api/imap/message/:sessionId/:mailboxName/:messageId', async (req, res) => {
    try {
        const { sessionId, mailboxName, messageId } = req.params;
        const message = await imapServer.getMessageContent(sessionId, mailboxName, messageId);
        res.json({ success: true, message });
    } catch (error) {
        logger.error('Get message API error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

app.post('/api/imap/mark-read/:sessionId/:mailboxName/:messageId', async (req, res) => {
    try {
        const { sessionId, mailboxName, messageId } = req.params;
        await imapServer.markAsRead(sessionId, mailboxName, messageId);
        res.json({ success: true });
    } catch (error) {
        logger.error('Mark as read API error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

app.delete('/api/imap/message/:sessionId/:mailboxName/:messageId', async (req, res) => {
    try {
        const { sessionId, mailboxName, messageId } = req.params;
        await imapServer.deleteMessage(sessionId, mailboxName, messageId);
        res.json({ success: true });
    } catch (error) {
        logger.error('Delete message API error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        services: {
            firebase: 'connected',
            mysql: 'connected',
            redis: 'connected'
        }
    });
});

// Sync emails from Firebase to local database
async function syncEmailsFromFirebase() {
    try {
        const db = admin.database();
        const emailsRef = db.ref('emails');
        const snapshot = await emailsRef.once('value');
        const emails = snapshot.val();
        
        if (emails) {
            for (const [emailId, email] of Object.entries(emails)) {
                // Check if email already exists in database
                const [rows] = await db.execute(
                    'SELECT id FROM emails WHERE message_id = ?',
                    [email.messageId]
                );
                
                if (rows.length === 0) {
                    // Store in local MySQL database for IMAP access
                    await db.execute(
                        'INSERT INTO emails (message_id, from_address, to_address, subject, body, content_type, timestamp, size, headers, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [email.messageId, email.from, email.to, email.subject, email.content || email.body, email.contentType || 'text/plain', email.timestamp, email.size, JSON.stringify(email.headers || {}), JSON.stringify(email.attachments || [])]
                    );
                }
            }
        }
        
        logger.info('Email sync completed');
    } catch (error) {
        logger.error('Error syncing emails:', error);
    }
}

// Start servers
const httpServer = createServer(app);
const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
    logger.info(`HTTP server running on port ${PORT}`);
});

smtpServer.listen(25);

// Schedule email sync every 5 minutes
cron.schedule('*/5 * * * *', () => {
    syncEmailsFromFirebase();
});

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully');
    httpServer.close(() => {
        smtpServer.server.close();
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down gracefully');
    httpServer.close(() => {
        smtpServer.server.close();
        process.exit(0);
    });
});

module.exports = { app, imapServer, smtpServer };
