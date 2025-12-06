# Multi-Domain Setup Troubleshooting

## Problem: Emails Not Delivered for One of Two Domains

If you have two domains set up with VCMail but emails for one domain aren't being delivered, this guide will help you diagnose and fix the issue.

## Root Cause

Each Lambda function's `VCMAIL_CONFIG.domain` environment variable is set to **only ONE domain** (the domain for that project). This is by design - **projects are independent and don't need to know about each other**.

When SES receives an email:
1. SES matches the email against receipt rules in the active rule set
2. Each rule matches emails for its specific domain and routes them to its Lambda
3. The Lambda checks if the email is for its configured domain:

```javascript
if (recipient.endsWith(`@${emailDomain}`)) {
  // Process email for this Lambda's domain
} else {
  // Email is for another domain - log info and return success
  // The correct Lambda for that domain should process it
}
```

**Important**: If an email for domain B somehow reaches Lambda A (which shouldn't happen if SES rules are configured correctly), Lambda A will:
- Log an informational message (not an error)
- Return success (so SES doesn't retry)
- Not process the email (the correct Lambda should handle it)

This ensures projects remain independent - each Lambda only processes emails for its own domain.

## Diagnosis

Run the multi-domain checker:

```bash
npx vcmail check-domains
```

This will show:
1. Which domain is configured in the Lambda function
2. Which domains have SES receipt rules
3. Whether MX records are configured correctly
4. Domain verification status

## Common Scenarios

### Scenario 1: Lambda Configured for Domain A, Email Sent to Domain B

**Symptoms:**
- Emails to domain A work fine
- Emails to domain B are received by SES but not processed
- Lambda logs show: `[ERROR] Recipient not @domainA: user@domainB`

**Solution:**
You have two options:

#### Option A: Separate Lambda Functions (Recommended)
Run `npx vcmail` in separate project directories for each domain. Each will have its own Lambda function configured for that domain.

#### Option B: Update Lambda to Support Multiple Domains
Modify the Lambda function to check against multiple domains. This requires code changes.

### Scenario 2: SES Receipt Rule Missing for One Domain

**Symptoms:**
- `npx vcmail check-domains` shows one domain has a rule, the other doesn't
- Emails to the domain without a rule bounce or aren't received

**Solution:**
Run `npx vcmail` in the project directory for the domain that's missing the rule.

### Scenario 3: Both Domains Share Same Lambda, But Lambda Only Processes One

**Symptoms:**
- Both domains have SES receipt rules pointing to the same Lambda
- Lambda environment variable `VCMAIL_CONFIG.domain` is set to only one domain
- Emails for the other domain are logged but not processed

**Solution:**
Update the Lambda to support multiple domains (see below).

## Fix: Support Multiple Domains in Lambda

To make the Lambda process emails for multiple domains, you need to:

1. **Update Lambda Environment Variable** to include all domains:

```json
{
  "VCMAIL_CONFIG": {
    "domain": "domain1.com",
    "domains": ["domain1.com", "domain2.com"],
    "s3BucketName": "...",
    "awsRegion": "us-east-1"
  }
}
```

2. **Update Lambda Code** to check against multiple domains:

```javascript
// In api/api.js, around line 448
const emailDomains = config.domains || [config.domain || 'example.com'];
const emailDomain = config.domain || 'example.com';

for (const recipient of ses.mail.destination) {
  console.log('Checking recipient:', recipient);
  
  // Check if recipient matches any configured domain
  const matchingDomain = emailDomains.find(domain => recipient.endsWith(`@${domain}`));
  
  if (matchingDomain) {
    const username = recipient.split('@')[0];
    console.log(`[OK] Found @${matchingDomain} recipient:`, username);
    await storeEmailForUser(username, ses.mail.messageId, emailData);
    processedCount++;
  } else {
    console.log(`[ERROR] Recipient not matching any configured domain:`, recipient);
    console.log(`[ERROR] Configured domains:`, emailDomains.join(', '));
  }
}
```

3. **Update Terraform** to set multiple domains in Lambda environment:

```hcl
environment {
  variables = {
    VCMAIL_CONFIG = jsonencode({
      domain             = var.domain
      domains            = var.domains  # Add this
      s3BucketName       = var.s3_bucket_name
      awsRegion          = var.aws_region
      configurationSetName = "${var.project_name}-email-config"
    })
  }
}
```

## Quick Check: Which Domain is Lambda Configured For?

Check Lambda CloudWatch logs for the domain check:

```bash
aws logs tail /aws/lambda/{project-name}-api --follow
```

Look for lines like:
- `[OK] Found @domain1.com recipient: username` ✅ (working)
- `[ERROR] Recipient not @domain1.com: user@domain2.com` ❌ (not working)

## Recommended Setup for Multiple Domains

**Best Practice:** Use separate project directories and Lambda functions for each domain:

```
project-domain1/
  ├── vcmail.config.json  (domain: domain1.com)
  └── .vcmail-terraform/

project-domain2/
  ├── vcmail.config.json  (domain: domain2.com)
  └── .vcmail-terraform/
```

Each project:
- Has its own Lambda function configured for that domain
- Shares the same SES rule set (automatically detected)
- Has its own SES receipt rule for that domain

This keeps configurations separate and makes troubleshooting easier.

## Verification Checklist

After fixing, verify:

1. ✅ Run `npx vcmail check-domains` - should show both domains
2. ✅ Check Lambda environment: `VCMAIL_CONFIG.domain` matches the domain you're testing
3. ✅ Check SES receipt rules: Both domains have rules
4. ✅ Check MX records: Both domains point to SES
5. ✅ Send test email to each domain
6. ✅ Check Lambda logs: Should show `[OK] Found @domain recipient` for both

## Getting Help

If issues persist:

1. Run `npx vcmail check-domains` and share the output
2. Check Lambda CloudWatch logs for the domain mismatch errors
3. Verify SES receipt rules exist for both domains
4. Ensure MX records are correct for both domains

