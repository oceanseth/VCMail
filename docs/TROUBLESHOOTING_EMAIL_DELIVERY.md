# Troubleshooting Email Delivery Issues

## Error: "550 5.1.1 Requested action not taken: mailbox unavailable"

This error means the **receiving server** (the domain you're sending TO) is rejecting the email because the mailbox doesn't exist or can't receive mail.

### Common Causes

1. **SES Sandbox Mode** (Most Common)
   - If SES is in sandbox mode, you can only send to verified email addresses
   - The receiving server might reject emails from unverified senders

2. **Mailbox Doesn't Exist**
   - The recipient email address (e.g., `seth@masky.ai`) doesn't exist on the receiving server
   - The receiving server is correctly rejecting non-existent mailboxes

3. **DNS/MX Records Not Configured**
   - If you're trying to RECEIVE emails at masky.ai, MX records must point to SES
   - Run `npx vcmail` to set up MX records

4. **Domain Not Verified in SES**
   - The sending domain must be verified in SES
   - Run `npx vcmail verify` to check verification status

### Solutions

#### If Sending TO masky.ai (Receiving Server Issue)

The error is coming from masky.ai's mail server, not VCMail. To fix:

1. **Check if mailbox exists**: Ensure `seth@masky.ai` exists on masky.ai's mail server
2. **Check SES Sandbox Mode**: If SES is in sandbox, you can only send to verified addresses
   ```bash
   npx vcmail verify
   ```
   Look for "SES is in SANDBOX MODE" warning
3. **Request Production Access**: If in sandbox mode, request production access:
   - Go to AWS SES Console
   - Click "Request production access"
   - Fill out the form (usually approved within 24 hours)

#### If Setting Up VCMail FOR masky.ai (To Receive Emails)

If you want to set up VCMail so that masky.ai can RECEIVE emails:

1. **Run Setup**:
   ```bash
   cd /path/to/masky-ai-project
   npx vcmail
   ```

2. **This will**:
   - Set up SES domain verification for masky.ai
   - Create MX records pointing to SES
   - Deploy Lambda function to process incoming emails
   - Set up API Gateway for email API

3. **Create Mailbox in Firebase**:
   - The user `seth` needs to sign up and set their username to `seth`
   - This creates the mailbox `seth@masky.ai` in Firebase

4. **Verify Setup**:
   ```bash
   npx vcmail verify
   ```

### Verification Checklist

Run `npx vcmail verify` to check:

- ✅ SES Domain Verification
- ✅ SES Sandbox Mode Status
- ✅ DKIM Configuration
- ✅ Lambda Function Deployment
- ✅ API Gateway Configuration
- ✅ DNS Records (MX, SPF, DMARC)

### Common Fixes

#### Fix 1: SES Sandbox Mode

If SES is in sandbox mode:
1. Go to AWS SES Console
2. Click "Request production access"
3. Fill out the form (explain your use case)
4. Wait for approval (usually 24 hours)

#### Fix 2: Domain Not Verified

If domain verification fails:
1. Run `npx vcmail` to set up domain verification
2. Check Route53 for `_amazonses.{domain}` TXT record
3. Wait for DNS propagation (can take up to 48 hours)

#### Fix 3: Lambda Not Deployed

If Lambda function is missing:
1. Run `npx vcmail` to deploy Lambda
2. Check Terraform state: `cd .vcmail-terraform && terraform show`
3. Verify Lambda exists: `aws lambda list-functions --region us-east-1`

#### Fix 4: API Gateway Not Configured

If API Gateway is missing:
1. Run `npx vcmail` to deploy API Gateway
2. Check CloudFront configuration points to API Gateway
3. Verify `/api/*` path is routed correctly

### Testing Email Delivery

After setup, test email delivery:

1. **Send Test Email**:
   - Use the webmail interface at `https://mail.{your-domain}`
   - Send an email to a verified address (if in sandbox mode)
   - Or send to any address (if in production mode)

2. **Check Lambda Logs**:
   ```bash
   aws logs tail /aws/lambda/{project-name}-api --follow
   ```

3. **Check SES Bounce/Complaint**:
   - Go to AWS SES Console
   - Check "Reputation metrics" for bounces/complaints

### Getting Help

If issues persist:

1. Run `npx vcmail verify` and check all items
2. Check Lambda logs for errors
3. Verify DNS records are correct
4. Ensure SES is out of sandbox mode (if sending to external domains)

### Example: Setting Up masky.ai

```bash
# 1. Navigate to masky-ai project
cd /path/to/masky-ai-project

# 2. Run VCMail setup
npx vcmail
# Follow prompts to configure:
# - Domain: masky.ai
# - Firebase project ID: your-firebase-project
# - AWS region: us-east-1

# 3. Verify setup
npx vcmail verify

# 4. Create user mailbox
# User signs up at https://mail.masky.ai
# Sets username to "seth"
# Mailbox seth@masky.ai is now ready

# 5. Test sending email
# Send email to seth@masky.ai from another email service
# Email should arrive in Firebase and be visible in webmail
```



