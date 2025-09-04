#!/bin/bash

# VCMail SSL Certificate Setup Script
# This script sets up SSL certificates for secure email protocols (IMAP, SMTP, POP3)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration variables
DOMAIN=""
EMAIL=""
SSL_DIR="/etc/ssl/vcmail"
NGINX_DIR="/etc/nginx"
CERTBOT_DIR="/etc/letsencrypt"
BACKUP_DIR="/etc/ssl/vcmail/backup"

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

# Function to check if running as root
check_root() {
    if [[ $EUID -ne 0 ]]; then
        print_error "This script must be run as root"
        exit 1
    fi
}

# Function to collect domain information
collect_domain_info() {
    print_status "Collecting domain information..."
    
    read -p "Enter your domain name (e.g., mail.yourdomain.com): " DOMAIN
    read -p "Enter your email address for Let's Encrypt notifications: " EMAIL
    
    if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
        print_error "Domain and email are required"
        exit 1
    fi
    
    print_success "Domain: $DOMAIN"
    print_success "Email: $EMAIL"
}

# Function to install required packages
install_packages() {
    print_status "Installing required packages..."
    
    # Update package list
    apt-get update
    
    # Install required packages
    apt-get install -y \
        certbot \
        python3-certbot-nginx \
        nginx \
        openssl \
        ca-certificates \
        ssl-cert \
        ufw \
        fail2ban
    
    print_success "Required packages installed"
}

# Function to configure firewall
configure_firewall() {
    print_status "Configuring firewall..."
    
    # Allow HTTP and HTTPS
    ufw allow 80/tcp
    ufw allow 443/tcp
    
    # Allow email ports
    ufw allow 25/tcp
    ufw allow 110/tcp
    ufw allow 143/tcp
    ufw allow 465/tcp
    ufw allow 587/tcp
    ufw allow 993/tcp
    ufw allow 995/tcp
    
    # Allow SSH
    ufw allow 22/tcp
    
    # Enable firewall
    ufw --force enable
    
    print_success "Firewall configured"
}

# Function to create SSL directory structure
create_ssl_directories() {
    print_status "Creating SSL directory structure..."
    
    mkdir -p "$SSL_DIR"
    mkdir -p "$BACKUP_DIR"
    mkdir -p "$SSL_DIR/private"
    mkdir -p "$SSL_DIR/certs"
    mkdir -p "$SSL_DIR/ca"
    
    # Set proper permissions
    chmod 700 "$SSL_DIR/private"
    chmod 755 "$SSL_DIR/certs"
    chmod 755 "$SSL_DIR/ca"
    
    print_success "SSL directories created"
}

# Function to generate self-signed certificate (fallback)
generate_self_signed_cert() {
    print_status "Generating self-signed certificate..."
    
    # Generate private key
    openssl genrsa -out "$SSL_DIR/private/$DOMAIN.key" 2048
    
    # Generate certificate signing request
    openssl req -new -key "$SSL_DIR/private/$DOMAIN.key" -out "$SSL_DIR/$DOMAIN.csr" -subj "/C=US/ST=State/L=City/O=Organization/CN=$DOMAIN"
    
    # Generate self-signed certificate
    openssl x509 -req -days 365 -in "$SSL_DIR/$DOMAIN.csr" -signkey "$SSL_DIR/private/$DOMAIN.key" -out "$SSL_DIR/certs/$DOMAIN.crt"
    
    # Set proper permissions
    chmod 600 "$SSL_DIR/private/$DOMAIN.key"
    chmod 644 "$SSL_DIR/certs/$DOMAIN.crt"
    
    print_success "Self-signed certificate generated"
}

# Function to configure Nginx for Let's Encrypt
configure_nginx_for_certbot() {
    print_status "Configuring Nginx for Let's Encrypt..."
    
    # Create temporary Nginx configuration
    cat > "$NGINX_DIR/sites-available/vcmail-temp" << EOF
server {
    listen 80;
    server_name $DOMAIN;
    
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    
    location / {
        return 301 https://\$server_name\$request_uri;
    }
}
EOF
    
    # Enable the site
    ln -sf "$NGINX_DIR/sites-available/vcmail-temp" "$NGINX_DIR/sites-enabled/"
    
    # Test Nginx configuration
    nginx -t
    
    # Reload Nginx
    systemctl reload nginx
    
    print_success "Nginx configured for Let's Encrypt"
}

# Function to obtain Let's Encrypt certificate
obtain_letsencrypt_cert() {
    print_status "Obtaining Let's Encrypt certificate..."
    
    # Stop any existing services that might use port 80
    systemctl stop nginx
    
    # Obtain certificate using standalone mode
    certbot certonly \
        --standalone \
        --non-interactive \
        --agree-tos \
        --email "$EMAIL" \
        --domains "$DOMAIN" \
        --pre-hook "systemctl stop nginx" \
        --post-hook "systemctl start nginx"
    
    if [[ $? -eq 0 ]]; then
        print_success "Let's Encrypt certificate obtained"
        
        # Copy certificates to our SSL directory
        cp "$CERTBOT_DIR/live/$DOMAIN/fullchain.pem" "$SSL_DIR/certs/$DOMAIN.crt"
        cp "$CERTBOT_DIR/live/$DOMAIN/privkey.pem" "$SSL_DIR/private/$DOMAIN.key"
        
        # Set proper permissions
        chmod 644 "$SSL_DIR/certs/$DOMAIN.crt"
        chmod 600 "$SSL_DIR/private/$DOMAIN.key"
        
        return 0
    else
        print_warning "Failed to obtain Let's Encrypt certificate, using self-signed"
        generate_self_signed_cert
        return 1
    fi
}

# Function to configure Nginx with SSL
configure_nginx_ssl() {
    print_status "Configuring Nginx with SSL..."
    
    # Create SSL Nginx configuration
    cat > "$NGINX_DIR/sites-available/vcmail-ssl" << EOF
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN;
    
    # SSL Configuration
    ssl_certificate $SSL_DIR/certs/$DOMAIN.crt;
    ssl_certificate_key $SSL_DIR/private/$DOMAIN.key;
    
    # SSL Security Settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512:ECDHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    ssl_session_tickets off;
    
    # HSTS
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    
    # Security Headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    
    # Root directory
    root /var/www/html;
    index index.html index.htm;
    
    # Health check endpoint
    location /health {
        access_log off;
        return 200 "healthy\n";
        add_header Content-Type text/plain;
    }
    
    # Let's Encrypt challenge
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    
    # Default location
    location / {
        try_files \$uri \$uri/ =404;
    }
}
EOF
    
    # Remove temporary configuration
    rm -f "$NGINX_DIR/sites-enabled/vcmail-temp"
    
    # Enable SSL site
    ln -sf "$NGINX_DIR/sites-available/vcmail-ssl" "$NGINX_DIR/sites-enabled/"
    
    # Test Nginx configuration
    nginx -t
    
    # Reload Nginx
    systemctl reload nginx
    
    print_success "Nginx configured with SSL"
}

# Function to configure Postfix with SSL
configure_postfix_ssl() {
    print_status "Configuring Postfix with SSL..."
    
    # Backup original configuration
    cp /etc/postfix/main.cf "$BACKUP_DIR/postfix-main.cf.backup"
    
    # Update Postfix configuration
    cat >> /etc/postfix/main.cf << EOF

# SSL Configuration
smtpd_use_tls = yes
smtpd_tls_cert_file = $SSL_DIR/certs/$DOMAIN.crt
smtpd_tls_key_file = $SSL_DIR/private/$DOMAIN.key
smtpd_tls_security_level = may
smtpd_tls_auth_only = no
smtpd_tls_loglevel = 1
smtpd_tls_received_header = yes
smtpd_tls_session_cache_timeout = 3600s
tls_random_source = dev:/dev/urandom

# SMTP over SSL
smtp_use_tls = yes
smtp_tls_security_level = may
smtp_tls_cert_file = $SSL_DIR/certs/$DOMAIN.crt
smtp_tls_key_file = $SSL_DIR/private/$DOMAIN.key

# TLS Configuration
smtpd_tls_protocols = !SSLv2, !SSLv3
smtpd_tls_ciphers = high
smtpd_tls_mandatory_protocols = !SSLv2, !SSLv3
smtpd_tls_mandatory_ciphers = high
EOF
    
    # Restart Postfix
    systemctl restart postfix
    
    print_success "Postfix configured with SSL"
}

# Function to configure Dovecot with SSL
configure_dovecot_ssl() {
    print_status "Configuring Dovecot with SSL..."
    
    # Backup original configuration
    cp /etc/dovecot/dovecot.conf "$BACKUP_DIR/dovecot.conf.backup"
    
    # Update Dovecot configuration
    cat >> /etc/dovecot/dovecot.conf << EOF

# SSL Configuration
ssl = yes
ssl_cert = <$SSL_DIR/certs/$DOMAIN.crt
ssl_key = <$SSL_DIR/private/$DOMAIN.key
ssl_protocols = !SSLv2 !SSLv3
ssl_cipher_list = ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256
ssl_prefer_server_ciphers = yes
ssl_min_protocol = TLSv1.2
ssl_dh_parameters_length = 2048

# IMAP SSL
protocol imap {
    ssl = yes
    ssl_cert = <$SSL_DIR/certs/$DOMAIN.crt
    ssl_key = <$SSL_DIR/private/$DOMAIN.key
}

# POP3 SSL
protocol pop3 {
    ssl = yes
    ssl_cert = <$SSL_DIR/certs/$DOMAIN.crt
    ssl_key = <$SSL_DIR/private/$DOMAIN.key
}

# LMTP SSL
protocol lmtp {
    ssl = yes
    ssl_cert = <$SSL_DIR/certs/$DOMAIN.crt
    ssl_key = <$SSL_DIR/private/$DOMAIN.key
}
EOF
    
    # Restart Dovecot
    systemctl restart dovecot
    
    print_success "Dovecot configured with SSL"
}

# Function to configure VCMail server with SSL
configure_vcmail_ssl() {
    print_status "Configuring VCMail server with SSL..."
    
    # Create SSL configuration for VCMail
    cat > "$SSL_DIR/vcmail-ssl.conf" << EOF
# VCMail SSL Configuration
ssl_cert_file = $SSL_DIR/certs/$DOMAIN.crt
ssl_key_file = $SSL_DIR/private/$DOMAIN.key
ssl_ca_file = $SSL_DIR/certs/$DOMAIN.crt

# SSL Options
ssl_protocols = TLSv1.2 TLSv1.3
ssl_ciphers = ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512:ECDHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES256-GCM-SHA384
ssl_prefer_server_ciphers = on
ssl_session_cache = shared:SSL:10m
ssl_session_timeout = 10m
EOF
    
    # Update VCMail server configuration
    if [[ -f "/opt/vcmail-mail-server/.env" ]]; then
        cat >> "/opt/vcmail-mail-server/.env" << EOF

# SSL Configuration
SSL_CERT_FILE=$SSL_DIR/certs/$DOMAIN.crt
SSL_KEY_FILE=$SSL_DIR/private/$DOMAIN.key
SSL_CA_FILE=$SSL_DIR/certs/$DOMAIN.crt
EOF
    fi
    
    print_success "VCMail server configured with SSL"
}

# Function to set up certificate renewal
setup_certificate_renewal() {
    print_status "Setting up certificate renewal..."
    
    # Create renewal script
    cat > "/usr/local/bin/vcmail-cert-renewal.sh" << 'EOF'
#!/bin/bash

# VCMail Certificate Renewal Script
SSL_DIR="/etc/ssl/vcmail"
DOMAIN=""

# Get domain from SSL directory
if [[ -f "$SSL_DIR/domain.txt" ]]; then
    DOMAIN=$(cat "$SSL_DIR/domain.txt")
fi

if [[ -z "$DOMAIN" ]]; then
    echo "Error: Domain not found"
    exit 1
fi

# Renew certificate
certbot renew --quiet

# Copy renewed certificates
if [[ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
    cp "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$SSL_DIR/certs/$DOMAIN.crt"
    cp "/etc/letsencrypt/live/$DOMAIN/privkey.pem" "$SSL_DIR/private/$DOMAIN.key"
    
    # Set proper permissions
    chmod 644 "$SSL_DIR/certs/$DOMAIN.crt"
    chmod 600 "$SSL_DIR/private/$DOMAIN.key"
    
    # Restart services
    systemctl reload nginx
    systemctl restart postfix
    systemctl restart dovecot
    systemctl restart vcmail-mail-server
    
    echo "Certificate renewed successfully"
else
    echo "Error: Certificate renewal failed"
    exit 1
fi
EOF
    
    # Make script executable
    chmod +x "/usr/local/bin/vcmail-cert-renewal.sh"
    
    # Save domain for renewal script
    echo "$DOMAIN" > "$SSL_DIR/domain.txt"
    
    # Add cron job for automatic renewal
    (crontab -l 2>/dev/null; echo "0 2 * * * /usr/local/bin/vcmail-cert-renewal.sh") | crontab -
    
    print_success "Certificate renewal configured"
}

# Function to test SSL configuration
test_ssl_configuration() {
    print_status "Testing SSL configuration..."
    
    # Test SSL certificate
    if [[ -f "$SSL_DIR/certs/$DOMAIN.crt" ]]; then
        print_success "SSL certificate file exists"
        
        # Check certificate validity
        openssl x509 -in "$SSL_DIR/certs/$DOMAIN.crt" -text -noout | grep -E "(Subject:|Not Before:|Not After:)"
    else
        print_error "SSL certificate file not found"
    fi
    
    # Test SSL key
    if [[ -f "$SSL_DIR/private/$DOMAIN.key" ]]; then
        print_success "SSL key file exists"
    else
        print_error "SSL key file not found"
    fi
    
    # Test SSL connection
    print_status "Testing SSL connection to $DOMAIN:993..."
    if timeout 10 openssl s_client -connect "$DOMAIN:993" -servername "$DOMAIN" </dev/null 2>/dev/null | grep -q "CONNECTED"; then
        print_success "SSL connection to IMAP port successful"
    else
        print_warning "SSL connection to IMAP port failed"
    fi
    
    # Test SMTP SSL connection
    print_status "Testing SSL connection to $DOMAIN:587..."
    if timeout 10 openssl s_client -connect "$DOMAIN:587" -starttls smtp -servername "$DOMAIN" </dev/null 2>/dev/null | grep -q "CONNECTED"; then
        print_success "SSL connection to SMTP port successful"
    else
        print_warning "SSL connection to SMTP port failed"
    fi
}

# Function to display configuration summary
display_summary() {
    print_success "SSL Configuration Complete!"
    echo
    print_status "SSL Configuration Summary:"
    echo "  Domain: $DOMAIN"
    echo "  SSL Certificate: $SSL_DIR/certs/$DOMAIN.crt"
    echo "  SSL Private Key: $SSL_DIR/private/$DOMAIN.key"
    echo "  SSL Directory: $SSL_DIR"
    echo
    print_status "SSL Ports:"
    echo "  IMAP SSL: $DOMAIN:993"
    echo "  SMTP SSL: $DOMAIN:465"
    echo "  SMTP STARTTLS: $DOMAIN:587"
    echo "  POP3 SSL: $DOMAIN:995"
    echo
    print_status "Services Configured:"
    echo "  Nginx: SSL enabled"
    echo "  Postfix: SSL enabled"
    echo "  Dovecot: SSL enabled"
    echo "  VCMail Server: SSL enabled"
    echo
    print_status "Certificate Renewal:"
    echo "  Automatic renewal: Enabled"
    echo "  Renewal script: /usr/local/bin/vcmail-cert-renewal.sh"
    echo "  Cron job: Daily at 2 AM"
    echo
    print_warning "Important:"
    echo "  - Ensure your DNS records point to this server"
    echo "  - Test email client connections"
    echo "  - Monitor certificate expiration"
    echo "  - Check logs for any SSL errors"
}

# Main execution
main() {
    print_status "VCMail SSL Certificate Setup"
    print_status "============================="
    echo
    
    # Check if running as root
    check_root
    
    # Collect domain information
    collect_domain_info
    
    # Install required packages
    install_packages
    
    # Configure firewall
    configure_firewall
    
    # Create SSL directories
    create_ssl_directories
    
    # Try to obtain Let's Encrypt certificate
    if ! obtain_letsencrypt_cert; then
        print_warning "Using self-signed certificate"
    fi
    
    # Configure services with SSL
    configure_nginx_ssl
    configure_postfix_ssl
    configure_dovecot_ssl
    configure_vcmail_ssl
    
    # Set up certificate renewal
    setup_certificate_renewal
    
    # Test SSL configuration
    test_ssl_configuration
    
    # Display summary
    display_summary
    
    print_success "SSL setup completed successfully!"
}

# Run main function
main "$@"
