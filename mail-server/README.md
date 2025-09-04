# VCMail Custom IMAP/SMTP Server

This is a custom IMAP/SMTP server implementation that integrates with Firebase to provide email services compatible with Outlook and Gmail clients.

## Features

- **Custom IMAP Server**: Provides IMAP protocol support for email clients
- **Custom SMTP Server**: Handles outgoing email with Firebase integration
- **Firebase Integration**: Stores and retrieves emails from Firebase Realtime Database
- **MySQL Caching**: Local database for improved performance
- **Redis Caching**: Session and temporary data storage
- **SSL/TLS Support**: Secure email transmission
- **Authentication**: Firebase-based user authentication
- **Real-time Sync**: Automatic synchronization with Firebase

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Email Client  │───▶│  VCMail Server  │───▶│   Firebase DB   │
│  (Outlook/Gmail)│    │  (IMAP/SMTP)    │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                │
                                ▼
                       ┌─────────────────┐
                       │   MySQL Cache   │
                       │                 │
                       │  (Local Storage)│
                       └─────────────────┘
                                │
                                ▼
                       ┌─────────────────┐
                       │   Redis Cache   │
                       │                 │
                       │  (Session Data) │
                       └─────────────────┘
```

## Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/yourusername/VCMail.git
   cd VCMail/mail-server
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment variables**:
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. **Set up Firebase service account**:
   ```bash
   # Place your Firebase service account JSON file as firebase-service-account.json
   ```

5. **Start the server**:
   ```bash
   npm start
   ```

## Configuration

### Environment Variables

Create a `.env` file with the following variables:

```env
# Server Configuration
PORT=3000
NODE_ENV=production
LOG_LEVEL=info

# Firebase Configuration
FIREBASE_DATABASE_URL=https://your-project.firebaseio.com

# MySQL Configuration
MYSQL_HOST=localhost
MYSQL_USER=vcmail
MYSQL_PASSWORD=your_mysql_password
MYSQL_DATABASE=vcmail_mail

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379

# SMTP Configuration
SMTP_PORT=25
SMTP_HOST=0.0.0.0

# IMAP Configuration
IMAP_PORT=143
IMAP_HOST=0.0.0.0
```

### Firebase Service Account

1. Go to Firebase Console > Project Settings > Service Accounts
2. Generate a new private key
3. Save the JSON file as `firebase-service-account.json` in the mail-server directory

## API Endpoints

### Authentication
- `POST /api/imap/authenticate` - Authenticate user with Firebase

### Mailboxes
- `GET /api/imap/mailboxes/:sessionId` - Get user mailboxes

### Messages
- `GET /api/imap/messages/:sessionId/:mailboxName` - Get messages from mailbox
- `GET /api/imap/message/:sessionId/:mailboxName/:messageId` - Get specific message
- `POST /api/imap/mark-read/:sessionId/:mailboxName/:messageId` - Mark message as read
- `DELETE /api/imap/message/:sessionId/:mailboxName/:messageId` - Delete message

### Health Check
- `GET /health` - Server health status

## Email Client Configuration

### Outlook Configuration

1. **Add Account**:
   - Go to File > Account Settings > New
   - Choose "Manual setup or additional server types"
   - Select "POP or IMAP"

2. **Server Settings**:
   - **Incoming Mail Server**: `your-domain.com`
   - **Port**: `993` (SSL) or `143` (STARTTLS)
   - **Encryption**: SSL/TLS
   - **Outgoing Mail Server**: `your-domain.com`
   - **Port**: `587` (STARTTLS) or `465` (SSL)
   - **Encryption**: SSL/TLS

3. **Authentication**:
   - **Username**: Your Firebase email
   - **Password**: Your Firebase password

### Gmail Configuration

1. **Add Account**:
   - Go to Settings > Accounts and Import > Add a mail account
   - Choose "Import emails from my other account (POP3)"

2. **Server Settings**:
   - **POP Server**: `your-domain.com`
   - **Port**: `995` (SSL) or `110` (STARTTLS)
   - **Username**: Your Firebase email
   - **Password**: Your Firebase password

## Database Schema

### MySQL Tables

```sql
CREATE TABLE emails (
    id INT AUTO_INCREMENT PRIMARY KEY,
    message_id VARCHAR(255) UNIQUE,
    from_address VARCHAR(255) NOT NULL,
    to_address TEXT NOT NULL,
    subject VARCHAR(500),
    body LONGTEXT,
    content_type VARCHAR(100),
    timestamp BIGINT,
    size INT,
    headers JSON,
    attachments JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_timestamp ON emails(timestamp);
CREATE INDEX idx_from_address ON emails(from_address);
CREATE INDEX idx_message_id ON emails(message_id);
```

## Firebase Data Structure

```json
{
  "emails": {
    "userId": {
      "emailId": {
        "messageId": "unique-message-id",
        "from": "sender@example.com",
        "to": "recipient@example.com",
        "subject": "Email Subject",
        "content": "Email body content",
        "contentType": "text/html",
        "timestamp": 1234567890,
        "size": 1024,
        "headers": {},
        "attachments": []
      }
    }
  },
  "sent": {
    "userId": {
      "emailId": {
        // Same structure as emails
      }
    }
  },
  "users": {
    "userId": {
      "mailboxes": {
        "mailboxName": {
          "messages": {
            "messageId": {
              // Message data
            }
          }
        }
      }
    }
  }
}
```

## Security Features

- **Firebase Authentication**: Secure user authentication
- **SSL/TLS Encryption**: Encrypted email transmission
- **Input Validation**: Sanitized email data
- **Rate Limiting**: Protection against abuse
- **CORS Protection**: Cross-origin request security
- **Helmet Security**: HTTP security headers

## Monitoring and Logging

- **Winston Logging**: Structured logging with multiple transports
- **Health Checks**: Server status monitoring
- **Error Tracking**: Comprehensive error logging
- **Performance Metrics**: Request timing and statistics

## Development

### Running in Development Mode

```bash
npm run dev
```

### Running Tests

```bash
npm test
```

### Linting

```bash
npm run lint
npm run lint:fix
```

## Troubleshooting

### Common Issues

1. **Firebase Connection Error**:
   - Check Firebase service account JSON file
   - Verify Firebase database URL
   - Ensure Firebase rules allow access

2. **MySQL Connection Error**:
   - Check MySQL server status
   - Verify database credentials
   - Ensure database exists

3. **Redis Connection Error**:
   - Check Redis server status
   - Verify Redis configuration
   - Check network connectivity

4. **Email Client Connection Issues**:
   - Verify SSL certificates
   - Check firewall settings
   - Confirm port accessibility

### Logs

Check the following log files:
- `/var/log/vcmail/error.log` - Error logs
- `/var/log/vcmail/combined.log` - All logs
- Console output - Development logs

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

This project is licensed under the MIT License - see the [LICENSE](../LICENSE) file for details.

## Support

For support and questions:
- Create an issue on GitHub
- Check the documentation
- Review the troubleshooting guide
