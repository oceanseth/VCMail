# Universal Email Client Configuration for VCMail (POP3)

This guide provides universal configuration instructions for any email client to work with your VCMail POP3 server.

## Quick Setup Summary

```
Account Type: POP3
Incoming Server: your-domain.com
Incoming Port: 995 (SSL) or 110 (STARTTLS)
Outgoing Server: your-domain.com
Outgoing Port: 587 (STARTTLS) or 465 (SSL)
Username: yourusername@voicecert.com
Password: Your Firebase password
Encryption: SSL/TLS for POP3, STARTTLS for SMTP
Leave messages on server: Yes (VCMail doesn't delete emails)
```

## Supported Email Clients

### Desktop Clients
- **Microsoft Outlook** (2016, 2019, 2021, 365)
- **Mozilla Thunderbird**
- **Apple Mail** (macOS)
- **Mailbird**
- **eM Client**
- **Postbox**
- **The Bat!**

### Mobile Clients
- **Gmail** (Android/iOS)
- **Apple Mail** (iOS)
- **Outlook** (Android/iOS)
- **Blue Mail**
- **K-9 Mail** (Android)
- **FairEmail** (Android)

### Web Clients
- **Gmail Web Interface**
- **Outlook Web App**
- **Roundcube**
- **SquirrelMail**

## Universal Configuration Steps

### Step 1: Basic Account Information

```
Full Name: Your Full Name
Email Address: yourusername@voicecert.com
Username: yourusername@voicecert.com
Password: Your Firebase password
```

### Step 2: Incoming Mail Server (POP3)

```
Server Type: POP3
Server Address: your-domain.com
Port: 995
Encryption: SSL/TLS
Authentication: Username and Password
Leave messages on server: Yes
```

**Alternative POP3 Settings:**
```
Port: 110
Encryption: STARTTLS
```

### Step 3: Outgoing Mail Server (SMTP)

```
Server Type: SMTP
Server Address: your-domain.com
Port: 587
Encryption: STARTTLS
Authentication: Username and Password
```

**Alternative SMTP Settings:**
```
Port: 465
Encryption: SSL/TLS
```

### Step 4: Advanced Settings

#### Authentication
- **Username**: `yourusername@voicecert.com`
- **Password**: Your Firebase password
- **Authentication Method**: Username and Password

#### Security
- **Use SSL/TLS**: Yes
- **Verify SSL Certificate**: Yes
- **Allow Insecure Authentication**: No

#### Folders
- **Root Folder**: `/` (or leave blank)
- **Sent Items Folder**: `Sent`
- **Drafts Folder**: `Drafts`
- **Trash Folder**: `Trash`

## Client-Specific Instructions

### Microsoft Outlook

1. **File > Account Settings > New**
2. **Manual setup or additional server types**
3. **POP or IMAP**
4. Use the universal settings above

### Mozilla Thunderbird

1. **Tools > Account Settings > Account Actions > Add Mail Account**
2. **Configure manually**
3. Use the universal settings above

### Apple Mail (macOS)

1. **Mail > Preferences > Accounts > +**
2. **Other Mail Account**
3. Use the universal settings above

### Gmail (Web)

1. **Settings > Accounts and Import > Add a mail account**
2. **Import emails from my other account (POP3)**
3. Use POP3 settings:
   ```
   POP Server: your-domain.com
   Port: 995
   SSL: Yes
   ```

### Mobile Apps

#### Gmail (Mobile)
1. **Settings > Add account > Other**
2. **Personal (IMAP)**
3. Use the universal settings above

#### Outlook (Mobile)
1. **Settings > Add account > Add email account**
2. **Advanced setup**
3. Use the universal settings above

#### Apple Mail (iOS)
1. **Settings > Mail > Accounts > Add Account > Other**
2. **Add Mail Account**
3. Use the universal settings above

## Troubleshooting Common Issues

### Connection Issues

1. **Check server status**:
   ```bash
   ping your-domain.com
   telnet your-domain.com 993
   telnet your-domain.com 587
   ```

2. **Verify SSL certificate**:
   ```bash
   openssl s_client -connect your-domain.com:993 -servername your-domain.com
   ```

3. **Check firewall settings**:
   - Ensure ports 993, 587, 143, and 465 are open
   - Check if your network blocks these ports

### Authentication Issues

1. **Verify credentials**:
   - Check your Firebase email and password
   - Ensure your account is properly set up
   - Try logging into Firebase Console

2. **Check authentication method**:
   - Use "Username and Password" authentication
   - Avoid OAuth or other advanced methods

3. **Test with different clients**:
   - Try a simple email client first
   - Use web-based clients for testing

### SSL/TLS Issues

1. **Check certificate validity**:
   - Verify the SSL certificate is valid
   - Check if the certificate matches your domain

2. **Try different encryption methods**:
   - SSL/TLS for IMAP (port 993)
   - STARTTLS for SMTP (port 587)
   - Alternative ports if available

3. **Disable certificate verification** (temporary):
   - Only for testing purposes
   - Re-enable after confirming connection works

### Performance Issues

1. **Optimize sync settings**:
   - Reduce sync frequency
   - Limit folder synchronization
   - Use cached mode when available

2. **Check server resources**:
   - Monitor server CPU and memory usage
   - Check database performance
   - Review server logs

3. **Network optimization**:
   - Use stable internet connection
   - Avoid VPN if possible
   - Check for network latency

## Security Considerations

### Best Practices

1. **Use strong passwords**:
   - Minimum 12 characters
   - Mix of letters, numbers, and symbols
   - Avoid common passwords

2. **Enable two-factor authentication**:
   - Use Firebase 2FA if available
   - Consider app-based authenticators

3. **Keep clients updated**:
   - Regular security updates
   - Latest version of email clients

4. **Use secure networks**:
   - Avoid public Wi-Fi for email
   - Use VPN when necessary

### Security Settings

1. **Encryption**:
   - Always use SSL/TLS
   - Verify certificate validity
   - Avoid unencrypted connections

2. **Authentication**:
   - Use strong passwords
   - Enable 2FA when available
   - Regular password changes

3. **Access Control**:
   - Limit account access
   - Monitor login attempts
   - Use secure devices only

## Testing Your Configuration

### Basic Tests

1. **Send test email**:
   - Send email to yourself
   - Send email to external address
   - Check delivery status

2. **Receive test email**:
   - Send email from external address
   - Check if email appears in inbox
   - Verify email content

3. **Folder operations**:
   - Create new folder
   - Move emails between folders
   - Delete emails

4. **Attachment handling**:
   - Send email with attachment
   - Receive email with attachment
   - Verify attachment integrity

### Advanced Tests

1. **Search functionality**:
   - Search by subject
   - Search by sender
   - Search by content

2. **Offline access**:
   - Disconnect from internet
   - Check cached emails
   - Reconnect and sync

3. **Multiple device sync**:
   - Configure on multiple devices
   - Send email from one device
   - Check if it appears on other devices

## Support and Resources

### Documentation
- [VCMail Server Documentation](../README.md)
- [Firebase Authentication Guide](https://firebase.google.com/docs/auth)
- [IMAP Protocol Specification](https://tools.ietf.org/html/rfc3501)
- [SMTP Protocol Specification](https://tools.ietf.org/html/rfc5321)

### Getting Help

1. **Check server logs**:
   ```bash
   tail -f /var/log/vcmail/error.log
   tail -f /var/log/vcmail/combined.log
   ```

2. **Test connectivity**:
   ```bash
   # Test IMAP
   telnet your-domain.com 993
   
   # Test SMTP
   telnet your-domain.com 587
   ```

3. **Verify configuration**:
   - Double-check all settings
   - Compare with working configurations
   - Test with different clients

4. **Contact support**:
   - Create GitHub issue
   - Check documentation
   - Review troubleshooting guides

## Configuration Templates

### POP3 Settings Template
```
Server: your-domain.com
Port: 995
Encryption: SSL/TLS
Authentication: Username and Password
Username: yourusername@voicecert.com
Password: [Your Firebase Password]
Leave messages on server: Yes
```

### SMTP Settings Template
```
Server: your-domain.com
Port: 587
Encryption: STARTTLS
Authentication: Username and Password
Username: yourusername@voicecert.com
Password: [Your Firebase Password]
```

### POP3 Settings Template (Alternative)
```
Server: your-domain.com
Port: 995
Encryption: SSL/TLS
Authentication: Username and Password
Username: yourusername@voicecert.com
Password: [Your Firebase Password]
```

Your VCMail server should now work with any email client using these universal configuration settings!
