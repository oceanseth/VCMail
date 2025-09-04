# Gmail Configuration for VCMail (POP3)

This guide will help you configure Gmail to work with your VCMail POP3 server.

## Prerequisites

- VCMail POP3 server is running and accessible
- SSL certificates are properly configured
- Your Firebase account is set up
- You have your VCMail email address (username@voicecert.com)

## Configuration Steps

### Method 1: Gmail Web Interface

1. **Open Gmail** in your web browser

2. **Go to Settings** (gear icon) > **See all settings**

3. **Click on "Accounts and Import" tab**

4. **In the "Check mail from other accounts" section**, click **"Add a mail account"**

5. **Enter your VCMail email address**:
   ```
   yourusername@voicecert.com
   ```

6. **Click "Next"** and select **"Import emails from my other account (POP3)"**

7. **Enter server settings**:
   ```
   Username: yourusername@voicecert.com
   Password: Your Firebase password
   POP Server: your-domain.com
   Port: 995
   Leave a copy of retrieved message on the server: Yes (VCMail doesn't delete emails)
   Always use a secure connection (SSL) when retrieving mail: Yes
   ```

8. **Click "Add Account"**

9. **For outgoing mail**, select **"Yes, I want to be able to send mail as yourusername@voicecert.com"**

10. **Enter SMTP settings**:
    ```
    SMTP Server: your-domain.com
    Port: 587
    Username: yourusername@voicecert.com
    Password: Your Firebase password
    Secured connection using TLS: Yes
    ```

11. **Click "Add Account"**

12. **Verify your email address** by clicking the verification link sent to your VCMail account

### Method 2: Gmail Mobile App

1. **Open Gmail app** on your mobile device

2. **Tap the menu** (three lines) and select **"Settings"**

3. **Tap "Add account"**

4. **Select "Other"**

5. **Enter your email address**:
   ```
   yourusername@voicecert.com
   ```

6. **Select "Personal (POP3)"**

7. **Enter server settings**:
   ```
   Incoming server: your-domain.com
   Port: 995
   Security type: SSL/TLS
   Username: yourusername@voicecert.com
   Password: Your Firebase password
   ```

8. **Enter outgoing server settings**:
   ```
   SMTP server: your-domain.com
   Port: 587
   Security type: STARTTLS
   Username: yourusername@voicecert.com
   Password: Your Firebase password
   ```

9. **Tap "Next"** and wait for verification

### Method 3: Third-party Email Clients

#### Thunderbird Configuration

1. **Open Thunderbird** and go to **Tools > Account Settings**

2. **Click "Account Actions" > "Add Mail Account"**

3. **Enter your details**:
   ```
   Your name: Your Full Name
   Email address: yourusername@voicecert.com
   Password: Your Firebase password
   ```

4. **Click "Configure manually"**

5. **Enter server settings**:
   ```
   Incoming: IMAP
   Server hostname: your-domain.com
   Port: 993
   SSL: SSL/TLS
   Authentication: Normal password
   
   Outgoing: SMTP
   Server hostname: your-domain.com
   Port: 587
   SSL: STARTTLS
   Authentication: Normal password
   ```

#### Apple Mail Configuration

1. **Open Mail** and go to **Mail > Preferences**

2. **Click the "+" button** to add a new account

3. **Select "Other Mail Account"**

4. **Enter your details**:
   ```
   Full Name: Your Full Name
   Email Address: yourusername@voicecert.com
   Password: Your Firebase password
   ```

5. **Click "Sign In"**

6. **Enter server settings**:
   ```
   Incoming Mail Server: your-domain.com
   Port: 993
   Use SSL: Yes
   
   Outgoing Mail Server: your-domain.com
   Port: 587
   Use SSL: Yes
   Authentication: Password
   ```

## Advanced Configuration

### Custom Port Configuration

If you need to use custom ports:

```
IMAP: 143 (STARTTLS) or 993 (SSL)
SMTP: 587 (STARTTLS) or 465 (SSL)
POP3: 110 (STARTTLS) or 995 (SSL)
```

### Authentication Methods

VCMail supports the following authentication methods:

- **PLAIN**: Standard username/password authentication
- **LOGIN**: Base64 encoded authentication
- **CRAM-MD5**: Challenge-response authentication (if enabled)

### SSL/TLS Configuration

Ensure your VCMail server has proper SSL certificates:

1. **Check certificate validity**:
   ```bash
   openssl s_client -connect your-domain.com:993 -servername your-domain.com
   ```

2. **Verify certificate chain**:
   ```bash
   openssl verify -CAfile ca-bundle.crt your-domain.com.crt
   ```

## Troubleshooting

### Common Issues

1. **"Cannot connect to server" error**:
   - Check if your VCMail server is running
   - Verify the server address and port numbers
   - Check firewall settings
   - Test network connectivity

2. **"Authentication failed" error**:
   - Verify your Firebase credentials
   - Check if your account is properly set up in Firebase
   - Ensure you're using the correct email format
   - Try resetting your password

3. **"SSL/TLS connection failed" error**:
   - Verify SSL certificates are properly configured
   - Check if the server supports the encryption method
   - Try using different port numbers
   - Check certificate validity

4. **"Server not responding" error**:
   - Check network connectivity
   - Verify server is accessible from your network
   - Check if the server is overloaded
   - Test with a different email client

5. **"Folder synchronization failed" error**:
   - Check Firebase database connectivity
   - Verify user permissions
   - Check server logs for errors
   - Try re-authenticating

### Debugging Steps

1. **Check server logs**:
   ```bash
   tail -f /var/log/vcmail/error.log
   tail -f /var/log/vcmail/combined.log
   ```

2. **Test IMAP connection**:
   ```bash
   telnet your-domain.com 143
   ```

3. **Test SMTP connection**:
   ```bash
   telnet your-domain.com 587
   ```

4. **Check Firebase connectivity**:
   ```bash
   curl -X GET "https://your-project.firebaseio.com/.json"
   ```

## Security Best Practices

1. **Use strong passwords** for your Firebase account
2. **Enable two-factor authentication** if available
3. **Use SSL/TLS encryption** for all connections
4. **Regularly update your email client**
5. **Monitor for suspicious activity**
6. **Use secure networks** when possible

## Performance Optimization

1. **Limit folder synchronization** to essential folders only
2. **Set appropriate sync intervals** (e.g., every 15 minutes)
3. **Use cached mode** for better performance
4. **Archive old emails** to reduce server load
5. **Monitor storage usage** regularly
6. **Optimize attachment handling**

## Configuration Summary

```
Account Type: POP3
Incoming Server: your-domain.com:995 (SSL)
Outgoing Server: your-domain.com:587 (STARTTLS)
Username: yourusername@voicecert.com
Password: Your Firebase password
Encryption: SSL/TLS for POP3, STARTTLS for SMTP
Leave messages on server: Yes (VCMail doesn't delete emails)
```

## Testing Your Configuration

After setup, test your configuration by:

1. **Sending a test email** to yourself
2. **Receiving emails** from external senders
3. **Checking folder synchronization**
4. **Verifying attachment handling**
5. **Testing offline access**
6. **Checking email search functionality**

## Support

If you encounter issues:

1. Check the VCMail server logs
2. Verify your network connectivity
3. Test with a different email client
4. Contact your system administrator
5. Check the VCMail documentation
6. Review the troubleshooting guide

## Additional Resources

- [VCMail Server Documentation](../README.md)
- [Firebase Authentication Guide](https://firebase.google.com/docs/auth)
- [IMAP Protocol Specification](https://tools.ietf.org/html/rfc3501)
- [SMTP Protocol Specification](https://tools.ietf.org/html/rfc5321)

Your VCMail server should now be fully integrated with Gmail and other email clients!
