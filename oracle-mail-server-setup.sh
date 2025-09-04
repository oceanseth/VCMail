#!/bin/bash

# VCMail Oracle Cloud Mail Server Setup Script
# This script sets up an Oracle Cloud server with custom IMAP/SMTP protocols
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
        --display-name "VCMail-Server" \
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

# Function to install mail server on Oracle instance
install_mail_server() {
    print_status "Installing custom mail server on Oracle instance..."
    
    # Create installation script
    cat > "$SCRIPT_DIR/install-mail-server.sh" << 'EOF'
#!/bin/bash

# VCMail Custom Mail Server Installation Script
# This script installs a custom IMAP/SMTP server that integrates with Firebase

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

# Install required packages
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
mkdir -p /opt/vcmail-mail-server
cd /opt/vcmail-mail-server

# Initialize Node.js project
print_status "Initializing Node.js project..."
npm init -y

# Install required npm packages
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

# Create mail server application
print_status "Creating mail server application..."
cat > server.js << 'EOL'
const express = require('express');
const { createServer } = require('http');
const { Server } = require('smtp-server');
const ImapServer = require('imap');
const admin = require('firebase-admin');
const mysql = require('mysql2/promise');
const redis = require('redis');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const winston = require('winston');
const cron = require('node-cron');

// Initialize Firebase Admin
const serviceAccount = require('./firebase-service-account.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
});

// Initialize database connection
const db = mysql.createPool({
    host: 'localhost',
    user: 'vcmail',
    password: process.env.MYSQL_PASSWORD,
    database: 'vcmail_mail',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Initialize Redis
const redisClient = redis.createClient({
    host: 'localhost',
    port: 6379
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
        new winston.transports.Console()
    ]
});

// Create Express app
const app = express();
app.use(helmet());
app.use(cors());
app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));
app.use(express.json());

// SMTP Server
const smtpServer = new Server({
    name: 'vcmail-server',
    banner: 'VCMail SMTP Server',
    authMethods: ['PLAIN', 'LOGIN'],
    onAuth: async (auth, session, callback) => {
        try {
            // Authenticate against Firebase
            const user = await admin.auth().getUserByEmail(auth.username);
            if (user) {
                callback(null, { user: auth.username });
            } else {
                callback(new Error('Invalid credentials'));
            }
        } catch (error) {
            callback(new Error('Authentication failed'));
        }
    },
    onMailFrom: async (address, session, callback) => {
        // Validate sender
        callback();
    },
    onRcptTo: async (address, session, callback) => {
        // Validate recipient
        callback();
    },
    onData: async (stream, session, callback) => {
        let data = '';
        stream.on('data', chunk => {
            data += chunk.toString();
        });
        stream.on('end', async () => {
            try {
                // Store email in Firebase
                await storeEmailInFirebase(data, session);
                callback();
            } catch (error) {
                logger.error('Error storing email:', error);
                callback(new Error('Failed to store email'));
            }
        });
    }
});

// IMAP Server
const imapServer = new ImapServer({
    user: 'vcmail',
    password: process.env.IMAP_PASSWORD,
    host: 'localhost',
    port: 143,
    tls: false,
    tlsOptions: { rejectUnauthorized: false }
});

// Store email in Firebase
async function storeEmailInFirebase(emailData, session) {
    try {
        const db = admin.database();
        const emailRef = db.ref('emails').push();
        
        await emailRef.set({
            from: session.envelope.mailFrom.address,
            to: session.envelope.rcptTo.map(rcpt => rcpt.address),
            subject: extractSubject(emailData),
            body: emailData,
            timestamp: Date.now(),
            size: emailData.length
        });
        
        logger.info('Email stored in Firebase successfully');
    } catch (error) {
        logger.error('Error storing email in Firebase:', error);
        throw error;
    }
}

// Extract subject from email data
function extractSubject(emailData) {
    const subjectMatch = emailData.match(/^Subject:\s*(.+)$/m);
    return subjectMatch ? subjectMatch[1] : 'No Subject';
}

// Sync emails from Firebase to local database
async function syncEmailsFromFirebase() {
    try {
        const db = admin.database();
        const emailsRef = db.ref('emails');
        const snapshot = await emailsRef.once('value');
        const emails = snapshot.val();
        
        if (emails) {
            for (const [emailId, email] of Object.entries(emails)) {
                // Store in local MySQL database for IMAP access
                await db.execute(
                    'INSERT IGNORE INTO emails (id, from_address, to_address, subject, body, timestamp, size) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [emailId, email.from, JSON.stringify(email.to), email.subject, email.body, email.timestamp, email.size]
                );
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

smtpServer.listen(25, () => {
    logger.info('SMTP server running on port 25');
});

imapServer.listen(143, () => {
    logger.info('IMAP server running on port 143');
});

// Schedule email sync every 5 minutes
cron.schedule('*/5 * * * *', () => {
    syncEmailsFromFirebase();
});

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully');
    httpServer.close(() => {
        smtpServer.close();
        imapServer.close();
        process.exit(0);
    });
});

module.exports = app;
EOL

# Create systemd service
print_status "Creating systemd service..."
cat > /etc/systemd/system/vcmail-mail-server.service << 'EOF'
[Unit]
Description=VCMail Mail Server
After=network.target mysql.service redis.service

[Service]
Type=simple
User=vcmail
WorkingDirectory=/opt/vcmail-mail-server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=MYSQL_PASSWORD=your_mysql_password
Environment=IMAP_PASSWORD=your_imap_password
Environment=FIREBASE_DATABASE_URL=your_firebase_database_url

[Install]
WantedBy=multi-user.target
EOF

# Create log directory
print_status "Creating log directory..."
mkdir -p /var/log/vcmail
chown vcmail:vcmail /var/log/vcmail

# Set up MySQL database
print_status "Setting up MySQL database..."
mysql -u root -e "CREATE DATABASE IF NOT EXISTS vcmail_mail;"
mysql -u root -e "CREATE USER IF NOT EXISTS 'vcmail'@'localhost' IDENTIFIED BY 'your_mysql_password';"
mysql -u root -e "GRANT ALL PRIVILEGES ON vcmail_mail.* TO 'vcmail'@'localhost';"
mysql -u root -e "FLUSH PRIVILEGES;"

# Create email table
mysql -u vcmail -p'your_mysql_password' vcmail_mail << 'EOF'
CREATE TABLE IF NOT EXISTS emails (
    id VARCHAR(255) PRIMARY KEY,
    from_address VARCHAR(255) NOT NULL,
    to_address TEXT NOT NULL,
    subject VARCHAR(500),
    body LONGTEXT,
    timestamp BIGINT,
    size INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_timestamp ON emails(timestamp);
CREATE INDEX idx_from_address ON emails(from_address);
EOF

# Configure Postfix
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

# Configure Dovecot
print_status "Configuring Dovecot..."
cat > /etc/dovecot/dovecot.conf << 'EOF'
# Dovecot configuration for VCMail
protocols = imap pop3 lmtp sieve
listen = *, ::
base_dir = /var/run/dovecot/
instance_name = dovecot
login_greeting = VCMail IMAP Server Ready
mail_location = maildir:~/Maildir
namespace inbox {
    inbox = yes
}
passdb {
    driver = passwd-file
    args = /etc/dovecot/passwd
}
userdb {
    driver = passwd-file
    args = /etc/dovecot/passwd
}
service imap-login {
    inet_listener imap {
        port = 143
    }
}
service pop3-login {
    inet_listener pop3 {
        port = 110
    }
}
service lmtp {
    unix_listener /var/spool/postfix/private/dovecot-lmtp {
        mode = 0600
        user = postfix
        group = postfix
    }
}
service auth {
    unix_listener /var/spool/postfix/private/auth {
        mode = 0666
        user = postfix
        group = postfix
    }
    unix_listener auth-userdb {
        mode = 0600
        user = vcmail
        group = vcmail
    }
}
service auth-worker {
    user = vcmail
}
service dict {
    unix_listener dict {
        mode = 0600
        user = vcmail
        group = vcmail
    }
}
EOF

# Create Dovecot password file
print_status "Creating Dovecot password file..."
cat > /etc/dovecot/passwd << 'EOF'
vcmail:{PLAIN}your_imap_password
EOF

# Configure firewall
print_status "Configuring firewall..."
ufw allow 22/tcp
ufw allow 25/tcp
ufw allow 110/tcp
ufw allow 143/tcp
ufw allow 465/tcp
ufw allow 587/tcp
ufw allow 993/tcp
ufw allow 995/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Start services
print_status "Starting services..."
systemctl enable vcmail-mail-server
systemctl start vcmail-mail-server
systemctl enable postfix
systemctl start postfix
systemctl enable dovecot
systemctl start dovecot
systemctl enable mysql
systemctl start mysql
systemctl enable redis-server
systemctl start redis-server

print_success "Mail server installation completed!"
print_status "Next steps:"
print_status "1. Configure SSL certificates with Let's Encrypt"
print_status "2. Update DNS records to point to this server"
print_status "3. Configure Outlook/Gmail to use this server"
EOF

    chmod +x "$SCRIPT_DIR/install-mail-server.sh"
    
    # Copy files to Oracle instance
    print_status "Copying files to Oracle instance..."
    scp -i ~/.ssh/oracle_mail_server_key -o StrictHostKeyChecking=no "$SCRIPT_DIR/install-mail-server.sh" ubuntu@"$ORACLE_PUBLIC_IP":/tmp/
    scp -i ~/.ssh/oracle_mail_server_key -o StrictHostKeyChecking=no "$FIREBASE_CONFIG_FILE" ubuntu@"$ORACLE_PUBLIC_IP":/tmp/firebase-config.json
    
    # Run installation script on Oracle instance
    print_status "Running installation script on Oracle instance..."
    ssh -i ~/.ssh/oracle_mail_server_key -o StrictHostKeyChecking=no ubuntu@"$ORACLE_PUBLIC_IP" "sudo /tmp/install-mail-server.sh"
    
    print_success "Mail server installation completed!"
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
    print_success "VCMail Oracle Cloud Mail Server Setup Complete!"
    echo
    print_status "Server Details:"
    echo "  Instance ID: $ORACLE_INSTANCE_ID"
    echo "  Public IP: $ORACLE_PUBLIC_IP"
    echo "  Domain: $DOMAIN_NAME"
    echo
    print_status "Mail Server Configuration:"
    echo "  SMTP Server: $DOMAIN_NAME:587 (STARTTLS) or $DOMAIN_NAME:465 (SSL)"
    echo "  IMAP Server: $DOMAIN_NAME:993 (SSL) or $DOMAIN_NAME:143 (STARTTLS)"
    echo "  POP3 Server: $DOMAIN_NAME:995 (SSL) or $DOMAIN_NAME:110 (STARTTLS)"
    echo
    print_status "Outlook Configuration:"
    echo "  Incoming Mail Server: $DOMAIN_NAME"
    echo "  Outgoing Mail Server: $DOMAIN_NAME"
    echo "  Port: 993 (IMAP) / 587 (SMTP)"
    echo "  Encryption: SSL/TLS"
    echo
    print_status "Gmail Configuration:"
    echo "  Incoming Mail Server: $DOMAIN_NAME"
    echo "  Outgoing Mail Server: $DOMAIN_NAME"
    echo "  Port: 993 (IMAP) / 587 (SMTP)"
    echo "  Encryption: SSL/TLS"
    echo
    print_warning "Important: Update your DNS records to point to $ORACLE_PUBLIC_IP"
    print_warning "Required DNS records:"
    echo "  A record: $DOMAIN_NAME -> $ORACLE_PUBLIC_IP"
    echo "  MX record: $DOMAIN_NAME -> $DOMAIN_NAME"
    echo "  SPF record: v=spf1 mx ~all"
    echo "  DKIM record: (configure in your DNS provider)"
    echo
    print_status "Configuration files saved to:"
    echo "  Oracle config: $CONFIG_FILE"
    echo "  Firebase config: $FIREBASE_CONFIG_FILE"
    echo "  Server IP: $SCRIPT_DIR/oracle-ip.txt"
}

# Main execution
main() {
    print_status "VCMail Oracle Cloud Mail Server Setup"
    print_status "======================================"
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
    
    # Install mail server
    install_mail_server
    
    # Configure SSL
    configure_ssl
    
    # Display summary
    display_summary
    
    print_success "Setup completed successfully!"
}

# Run main function
main "$@"
