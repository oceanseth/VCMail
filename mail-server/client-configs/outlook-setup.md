# Outlook Configuration for VCMail (POP3)

This guide will help you configure Microsoft Outlook to work with your VCMail POP3 server.

## Prerequisites

- VCMail POP3 server is running and accessible
- SSL certificates are properly configured
- Your Firebase account is set up
- You have your VCMail email address (username@voicecert.com)

## Configuration Steps

### Method 1: Automatic Setup (Recommended)

1. **Open Outlook** and go to **File > Add Account**

2. **Enter your email address**:
   ```
   yourusername@voicecert.com
   ```

3. **Click "Advanced options"** and check "Let me set up my account manually"

4. **Select "POP"** as the account type

5. **Enter server settings**:
   - **Incoming mail server**: `your-domain.com` (e.g., `mail.voicecert.com`)
   - **Port**: `995`
   - **Encryption method**: `SSL/TLS`
   - **Outgoing mail server**: `your-domain.com`
   - **Port**: `587`
   - **Encryption method**: `STARTTLS`

6. **Enter your credentials**:
   - **Username**: `yourusername@voicecert.com`
   - **Password**: Your Firebase password

7. **Click "Connect"** and wait for Outlook to verify the settings

### Method 2: Manual Setup

1. **Open Outlook** and go to **File > Account Settings > Account Settings**

2. **Click "New"** and select "Email Account"

3. **Choose "Manual setup or additional server types"**

4. **Select "POP or IMAP"**

5. **Fill in the account information**:
   ```
   Your Name: Your Full Name
   Email Address: yourusername@voicecert.com
   Account Type: POP3
   Incoming mail server: your-domain.com
   Outgoing mail server (SMTP): your-domain.com
   User Name: yourusername@voicecert.com
   Password: Your Firebase password
   ```

6. **Click "More Settings"** and configure:

   **Outgoing Server Tab**:
   - Check "My outgoing server (SMTP) requires authentication"
   - Select "Use same settings as my incoming mail server"

   **Advanced Tab**:
   - **Incoming server (POP3)**: `995`
   - **Use the following type of encrypted connection**: `SSL/TLS`
   - **Outgoing server (SMTP)**: `587`
   - **Use the following type of encrypted connection**: `STARTTLS`
   - **Leave a copy of messages on the server**: Check this box (VCMail doesn't delete emails)

7. **Click "OK"** and then "Next" to test the connection

## Troubleshooting

### Common Issues

1. **"Cannot connect to server" error**:
   - Check if your VCMail server is running
   - Verify the server address and port numbers
   - Check firewall settings

2. **"Authentication failed" error**:
   - Verify your Firebase credentials
   - Check if your account is properly set up in Firebase
   - Ensure you're using the correct email format

3. **"SSL/TLS connection failed" error**:
   - Verify SSL certificates are properly configured
   - Check if the server supports the encryption method
   - Try using different port numbers (143 for IMAP, 25 for SMTP)

4. **"Server not responding" error**:
   - Check network connectivity
   - Verify server is accessible from your network
   - Check if the server is overloaded

### Advanced Configuration

#### Custom Port Configuration

If you need to use custom ports:

```
IMAP: 143 (STARTTLS) or 993 (SSL)
SMTP: 587 (STARTTLS) or 465 (SSL)
```

#### Proxy Configuration

If you're behind a corporate firewall:

1. Go to **File > Account Settings > Account Settings**
2. Select your VCMail account
3. Click "Change"
4. Click "More Settings"
5. Go to "Connection" tab
6. Configure proxy settings as needed

#### Offline Access

To enable offline access:

1. Go to **File > Account Settings > Account Settings**
2. Select your VCMail account
3. Click "Change"
4. Click "More Settings"
5. Go to "Advanced" tab
6. Check "Download shared folders"
7. Set "Download items for offline use" to "All"

## Security Best Practices

1. **Use strong passwords** for your Firebase account
2. **Enable two-factor authentication** if available
3. **Keep Outlook updated** to the latest version
4. **Use SSL/TLS encryption** for all connections
5. **Regularly check for security updates**

## Performance Optimization

1. **Limit folder synchronization** to essential folders only
2. **Set appropriate sync intervals** (e.g., every 15 minutes)
3. **Use cached mode** for better performance
4. **Archive old emails** to reduce server load
5. **Monitor storage usage** regularly

## Support

If you encounter issues:

1. Check the VCMail server logs
2. Verify your network connectivity
3. Test with a different email client
4. Contact your system administrator
5. Check the VCMail documentation

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

Your VCMail server should now be fully integrated with Outlook!
