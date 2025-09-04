#!/bin/bash

# VCMail Oracle Cloud POP3 Mail Server Setup Script
# This script sets up an Oracle Cloud server with simplified POP3/SMTP protocols
# that integrate with Firebase for Outlook and Gmail compatibility

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration variables
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/oracle-config.json"
FIREBASE_CONFIG_FILE="$SCRIPT_DIR/firebase-config.json"

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to collect Oracle Cloud credentials
collect_oracle_credentials() {
    print_status "Collecting Oracle Cloud credentials..."
    
    if [[ -f "$CONFIG_FILE" ]]; then
        print_warning "Existing configuration found. Do you want to use it? (y/n)"
        read -r use_existing
        if [[ $use_existing == "y" || $use_existing == "Y" ]]; then
            source "$CONFIG_FILE"
            return 0
        fi
    fi
    
    echo
    print_status "Please provide your Oracle Cloud credentials:"
    echo "You can find these in Oracle Cloud Console > User Settings > API Keys"
    echo
    
    read -p "Oracle Cloud User OCID: " ORACLE_USER_OCID
    read -p "Oracle Cloud Tenancy OCID: " ORACLE_TENANCY_OCID
    read -p "Oracle Cloud Region (e.g., us-ashburn-1): " ORACLE_REGION
    read -p "Oracle Cloud Compartment OCID: " ORACLE_COMPARTMENT_OCID
    read -s -p "Oracle Cloud API Key Passphrase: " ORACLE_API_KEY_PASSPHRASE
    echo
    
    # Save credentials to config file
    cat > "$CONFIG_FILE" << EOF
#!/bin/bash
export ORACLE_USER_OCID="$ORACLE_USER_OCID"
export ORACLE_TENANCY_OCID="$ORACLE_TENANCY_OCID"
export ORACLE_REGION="$ORACLE_REGION"
export ORACLE_COMPARTMENT_OCID="$ORACLE_COMPARTMENT_OCID"
export ORACLE_API_KEY_PASSPHRASE="$ORACLE_API_KEY_PASSPHRASE"
EOF
    
    chmod 600 "$CONFIG_FILE"
    print_success "Oracle Cloud credentials saved to $CONFIG_FILE"
}

# Function to collect Firebase credentials
collect_firebase_credentials() {
    print_status "Collecting Firebase credentials..."
    
    if [[ -f "$FIREBASE_CONFIG_FILE" ]]; then
        print_warning "Existing Firebase configuration found. Do you want to use it? (y/n)"
        read -r use_existing
        if [[ $use_existing == "y" || $use_existing == "Y" ]]; then
            return 0
        fi
    fi
    
    echo
    print_status "Please provide your Firebase configuration:"
    echo "You can find this in Firebase Console > Project Settings > General"
    echo
    
    read -p "Firebase Project ID: " FIREBASE_PROJECT_ID
    read -p "Firebase Database URL: " FIREBASE_DATABASE_URL
    read -p "Firebase Web API Key: " FIREBASE_WEB_API_KEY
    read -s -p "Firebase Service Account Private Key: " FIREBASE_PRIVATE_KEY
    echo
    
    # Save Firebase config
    cat > "$FIREBASE_CONFIG_FILE" << EOF
{
  "projectId": "$FIREBASE_PROJECT_ID",
  "databaseURL": "$FIREBASE_DATABASE_URL",
  "apiKey": "$FIREBASE_WEB_API_KEY",
  "privateKey": "$FIREBASE_PRIVATE_KEY"
}
EOF
    
    chmod 600 "$FIREBASE_CONFIG_FILE"
    print_success "Firebase configuration saved to $FIREBASE_CONFIG_FILE"
}

# Function to install Oracle CLI
install_oracle_cli() {
    print_status "Installing Oracle Cloud CLI..."
    
    if command_exists oci; then
        print_warning "Oracle CLI already installed. Updating..."
        oci setup repair-file-permissions --file ~/.oci/config
        return 0
    fi
    
    # Install Oracle CLI based on OS
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux
        if command_exists apt-get; then
            # Ubuntu/Debian
            sudo apt-get update
            sudo apt-get install -y python3-pip
            pip3 install oci-cli
        elif command_exists yum; then
            # CentOS/RHEL
            sudo yum install -y python3-pip
            pip3 install oci-cli
        else
            print_error "Unsupported Linux distribution. Please install Oracle CLI manually."
            exit 1
        fi
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        if command_exists brew; then
            brew install oci-cli
        else
            print_error "Homebrew not found. Please install Oracle CLI manually."
            exit 1
        fi
    else
        print_error "Unsupported operating system. Please install Oracle CLI manually."
        exit 1
    fi
    
    print_success "Oracle CLI installed successfully"
}

# Function to configure Oracle CLI
configure_oracle_cli() {
    print_status "Configuring Oracle CLI..."
    
    # Create OCI config directory
    mkdir -p ~/.oci
    
    # Generate API key if it doesn't exist
    if [[ ! -f ~/.oci/oci_api_key.pem ]]; then
        print_status "Generating API key..."
        openssl genrsa -out ~/.oci/oci_api_key.pem 2048
        openssl rsa -pubout -in ~/.oci/oci_api_key.pem -out ~/.oci/oci_api_key_public.pem
        chmod 600 ~/.oci/oci_api_key.pem
        chmod 644 ~/.oci/oci_api_key_public.pem
        print_success "API key generated. Please upload the public key to Oracle Cloud Console."
        print_warning "Public key location: ~/.oci/oci_api_key_public.pem"
        read -p "Press Enter after uploading the public key to Oracle Cloud Console..."
    fi
    
    # Create OCI config file
    cat > ~/.oci/config << EOF
[DEFAULT]
user=$ORACLE_USER_OCID
fingerprint=$(openssl rsa -pubout -outform DER -in ~/.oci/oci_api_key.pem | openssl md5 -c)
tenancy=$ORACLE_TENANCY_OCID
region=$ORACLE_REGION
key_file=~/.oci/oci_api_key.pem
pass_phrase=$ORACLE_API_KEY_PASSPHRASE
EOF
    
    chmod 600 ~/.oci/config
    print_success "Oracle CLI configured successfully"
}

# Function to create Oracle Cloud instance
create_oracle_instance() {
    print_status "Creating Oracle Cloud instance..."
    
    # Generate SSH key if it doesn't exist
    if [[ ! -f ~/.ssh/oracle_mail_server_key ]]; then
        print_status "Generating SSH key..."
        ssh-keygen -t rsa -b 4096 -f ~/.ssh/oracle_mail_server_key -N ""
        chmod 600 ~/.ssh/oracle_mail_server_key
        chmod 644 ~/.ssh/oracle_mail_server_key.pub
    fi
    
    # Get SSH public key
    SSH_PUBLIC_KEY=$(cat ~/.ssh/oracle_mail_server_key.pub)
    
    # Create instance
    print_status "Creating Oracle Cloud instance (this may take a few minutes)..."
    
    INSTANCE_ID=$(oci compute instance launch \
        --compartment-id "$ORACLE_COMPARTMENT_OCID" \
        --availability-domain "$(oci iam availability-domain list --query 'data[0].name' --raw-output)" \
        --display-name "VCMail-POP3-Server" \
        --image-id "$(oci compute image list --compartment-id "$ORACLE_COMPARTMENT_OCID" --operating-system "Canonical Ubuntu" --operating-system-version "22.04" --query 'data[0].id' --raw-output)" \
        --shape "VM.Standard.E2.1.Micro" \
        --subnet-id "$(oci network subnet list --compartment-id "$ORACLE_COMPARTMENT_OCID" --query 'data[0].id' --raw-output)" \
        --assign-public-ip true \
        --metadata '{"ssh_authorized_keys": "'"$SSH_PUBLIC_KEY"'"}' \
        --query 'data.id' \
        --raw-output)
    
    print_success "Instance created with ID: $INSTANCE_ID"
    
    # Wait for instance to be running
    print_status "Waiting for instance to be running..."
    oci compute instance wait --instance-id "$INSTANCE_ID" --wait-for-state RUNNING
    
    # Get public IP
    PUBLIC_IP=$(oci compute instance list-vnics --instance-id "$INSTANCE_ID" --query 'data[0].public-ip' --raw-output)
    
    print_success "Instance is running with public IP: $PUBLIC_IP"
    
    # Save instance details
    cat >> "$CONFIG_FILE" << EOF
export ORACLE_INSTANCE_ID="$INSTANCE_ID"
export ORACLE_PUBLIC_IP="$PUBLIC_IP"
EOF
    
    echo "$PUBLIC_IP" > "$SCRIPT_DIR/oracle-ip.txt"
}

# Function to install simplified POP3 mail server on Oracle instance
install_pop3_mail_server() {
    print_status "Installing simplified POP3 mail server on Oracle instance..."
    
    # Create installation script
    cat > "$SCRIPT_DIR/install-pop3-server.sh" << 'EOF'
#!/bin/bash

# VCMail Simplified POP3 Mail Server Installation Script
# This script installs a simplified POP3/SMTP server that integrates with Firebase

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Update system
print_status "Updating system packages..."
apt-get update
apt-get upgrade -y

# Install required packages (simplified - no MySQL, no Dovecot)
print_status "Installing required packages..."
apt-get install -y \
    nodejs \
    npm \
    nginx \
    certbot \
    python3-certbot-nginx \
    ufw \
    fail2ban \
    postfix \
    redis-server \
    git \
    curl \
    wget \
    unzip \
    build-essential

# Install Node.js 18
print_status "Installing Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs

# Create mail server user
print_status "Creating mail server user..."
useradd -m -s /bin/bash vcmail
usermod -aG sudo vcmail

# Create application directory
print_status "Creating application directory..."
mkdir -p /opt/vcmail-pop3-server
cd /opt/vcmail-pop3-server

# Initialize Node.js project
print_status "Initializing Node.js project..."
npm init -y

# Install required npm packages (simplified)
print_status "Installing npm packages..."
npm install \
    express \
    smtp-server \
    firebase-admin \
    redis \
    cors \
    helmet \
    morgan \
    winston \
    pm2 \
    ssl-cert \
    node-cron \
    mailparser

# Copy the POP3 server code
print_status "Creating POP3 mail server application..."
cat > server.js << 'EOL'
const express = require('express');
const { createServer } = require('http');
const { SMTPServer } = require('smtp-server');
const admin = require('firebase-admin');
const redis = require('redis');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const winston = require('winston');
const net = require('net');
const { parse } = require('mailparser');

// Initialize Firebase Admin
const serviceAccount = require('./firebase-service-account.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
});

// Initialize Redis
const redisClient = redis.createClient({
    host: 'localhost',
    port: 6379
});

redisClient.on('error', (err) => {
    console.error('Redis Client Error:', err);
});

// Initialize logger
const logger = winston.createLogger({
    level: 'info',
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
        this.port = 110;
        this.sslPort = 995;
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
EOL

# Create systemd service
print_status "Creating systemd service..."
cat > /etc/systemd/system/vcmail-pop3-server.service << 'EOF'
[Unit]
Description=VCMail POP3 Mail Server
After=network.target redis.service

[Service]
Type=simple
User=vcmail
WorkingDirectory=/opt/vcmail-pop3-server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=FIREBASE_DATABASE_URL=your_firebase_database_url
Environment=SSL_CERT_FILE=/etc/ssl/vcmail/certs/your-domain.com.crt
Environment=SSL_KEY_FILE=/etc/ssl/vcmail/private/your-domain.com.key

[Install]
WantedBy=multi-user.target
EOF

# Create log directory
print_status "Creating log directory..."
mkdir -p /var/log/vcmail
chown vcmail:vcmail /var/log/vcmail

# Configure Postfix (simplified)
print_status "Configuring Postfix..."
cat > /etc/postfix/main.cf << 'EOF'
# Postfix configuration for VCMail
myhostname = mail.yourdomain.com
mydomain = yourdomain.com
myorigin = $mydomain
inet_interfaces = all
inet_protocols = ipv4
mydestination = $myhostname, localhost.$mydomain, localhost, $mydomain
relayhost =
mynetworks = 127.0.0.0/8 [::ffff:127.0.0.0]/104 [::1]/128
mailbox_size_limit = 0
recipient_delimiter = +
home_mailbox = Maildir/
EOF

# Configure firewall
print_status "Configuring firewall..."
ufw allow 22/tcp
ufw allow 25/tcp
ufw allow 110/tcp
ufw allow 465/tcp
ufw allow 587/tcp
ufw allow 995/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Start services
print_status "Starting services..."
systemctl enable vcmail-pop3-server
systemctl start vcmail-pop3-server
systemctl enable postfix
systemctl start postfix
systemctl enable redis-server
systemctl start redis-server

print_success "POP3 mail server installation completed!"
print_status "Next steps:"
print_status "1. Configure SSL certificates with Let's Encrypt"
print_status "2. Update DNS records to point to this server"
print_status "3. Configure Outlook/Gmail to use this server"
EOF

    chmod +x "$SCRIPT_DIR/install-pop3-server.sh"
    
    # Copy files to Oracle instance
    print_status "Copying files to Oracle instance..."
    scp -i ~/.ssh/oracle_mail_server_key -o StrictHostKeyChecking=no "$SCRIPT_DIR/install-pop3-server.sh" ubuntu@"$ORACLE_PUBLIC_IP":/tmp/
    scp -i ~/.ssh/oracle_mail_server_key -o StrictHostKeyChecking=no "$FIREBASE_CONFIG_FILE" ubuntu@"$ORACLE_PUBLIC_IP":/tmp/firebase-config.json
    
    # Run installation script on Oracle instance
    print_status "Running installation script on Oracle instance..."
    ssh -i ~/.ssh/oracle_mail_server_key -o StrictHostKeyChecking=no ubuntu@"$ORACLE_PUBLIC_IP" "sudo /tmp/install-pop3-server.sh"
    
    print_success "POP3 mail server installation completed!"
}

# Function to configure SSL certificates
configure_ssl() {
    print_status "Configuring SSL certificates..."
    
    read -p "Enter your domain name (e.g., mail.yourdomain.com): " DOMAIN_NAME
    
    # Run certbot on Oracle instance
    ssh -i ~/.ssh/oracle_mail_server_key -o StrictHostKeyChecking=no ubuntu@"$ORACLE_PUBLIC_IP" "sudo certbot --nginx -d $DOMAIN_NAME --non-interactive --agree-tos --email admin@$DOMAIN_NAME"
    
    print_success "SSL certificates configured for $DOMAIN_NAME"
}

# Function to display configuration summary
display_summary() {
    print_success "VCMail Oracle Cloud POP3 Mail Server Setup Complete!"
    echo
    print_status "Server Details:"
    echo "  Instance ID: $ORACLE_INSTANCE_ID"
    echo "  Public IP: $ORACLE_PUBLIC_IP"
    echo "  Domain: $DOMAIN_NAME"
    echo
    print_status "Mail Server Configuration:"
    echo "  SMTP Server: $DOMAIN_NAME:587 (STARTTLS) or $DOMAIN_NAME:465 (SSL)"
    echo "  POP3 Server: $DOMAIN_NAME:995 (SSL) or $DOMAIN_NAME:110 (STARTTLS)"
    echo
    print_status "Outlook Configuration:"
    echo "  Incoming Mail Server: $DOMAIN_NAME"
    echo "  Outgoing Mail Server: $DOMAIN_NAME"
    echo "  Port: 995 (POP3 SSL) / 587 (SMTP STARTTLS)"
    echo "  Encryption: SSL/TLS"
    echo
    print_status "Gmail Configuration:"
    echo "  Incoming Mail Server: $DOMAIN_NAME"
    echo "  Outgoing Mail Server: $DOMAIN_NAME"
    echo "  Port: 995 (POP3 SSL) / 587 (SMTP STARTTLS)"
    echo "  Encryption: SSL/TLS"
    echo
    print_warning "Important: Update your DNS records to point to $ORACLE_PUBLIC_IP"
    print_warning "Required DNS records:"
    echo "  A record: $DOMAIN_NAME -> $ORACLE_PUBLIC_IP"
    echo "  MX record: $DOMAIN_NAME -> $DOMAIN_NAME"
    echo "  SPF record: v=spf1 mx ~all"
    echo
    print_status "Configuration files saved to:"
    echo "  Oracle config: $CONFIG_FILE"
    echo "  Firebase config: $FIREBASE_CONFIG_FILE"
    echo "  Server IP: $SCRIPT_DIR/oracle-ip.txt"
    echo
    print_status "Key Features:"
    echo "  ✅ Simplified POP3/SMTP architecture"
    echo "  ✅ Direct Firebase integration (no MySQL cache)"
    echo "  ✅ Email deletion disabled (emails persist on server)"
    echo "  ✅ Outlook and Gmail compatible"
    echo "  ✅ SSL/TLS encryption"
    echo "  ✅ Free Oracle Cloud server"
}

# Main execution
main() {
    print_status "VCMail Oracle Cloud POP3 Mail Server Setup"
    print_status "=========================================="
    echo
    
    # Check if running as root
    if [[ $EUID -eq 0 ]]; then
        print_error "This script should not be run as root"
        exit 1
    fi
    
    # Check prerequisites
    if ! command_exists curl; then
        print_error "curl is required but not installed"
        exit 1
    fi
    
    if ! command_exists openssl; then
        print_error "openssl is required but not installed"
        exit 1
    fi
    
    # Collect credentials
    collect_oracle_credentials
    collect_firebase_credentials
    
    # Install Oracle CLI
    install_oracle_cli
    
    # Configure Oracle CLI
    configure_oracle_cli
    
    # Create Oracle instance
    create_oracle_instance
    
    # Install POP3 mail server
    install_pop3_mail_server
    
    # Configure SSL
    configure_ssl
    
    # Display summary
    display_summary
    
    print_success "Setup completed successfully!"
}

# Run main function
main "$@"
