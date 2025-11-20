# VCMail NPM Package - Deployment Guide

## Overview

This guide explains how to convert VCMail into an npm package and deploy it so others can use it.

## Changes Made

### 1. Package Configuration (`package.json`)
- ✅ Changed name from `voicecert-scripts` to `vcmail`
- ✅ Added `bin` entry pointing to `bin/vcmail.js`
- ✅ Added CLI dependencies (inquirer, chalk, ora, execa)
- ✅ Added scripts for running the CLI
- ✅ Updated metadata and keywords

### 2. CLI Entry Point (`bin/vcmail.js`)
- ✅ Created main CLI script that:
  - Checks prerequisites (AWS CLI, Terraform, Node.js)
  - Verifies AWS credentials
  - Runs the setup wizard

### 3. Setup Wizard (`lib/setup.js`)
- ✅ Interactive prompts for configuration
- ✅ Generates `.vcmailrc` config file
- ✅ Initializes Terraform
- ✅ Runs Terraform plan and apply
- ✅ Deploys Lambda functions
- ✅ Deploys webmail client to S3/CloudFront

### 4. Terraform Configuration (`lib/terraform/`)
- ✅ Created `main.tf` with complete AWS infrastructure:
  - Route53 DNS records
  - SES domain verification and DKIM
  - S3 buckets (email inbox + webmail client)
  - CloudFront distribution
  - Lambda function for email processing
  - API Gateway
  - ACM certificates
  - IAM roles and policies
- ✅ Created `variables.tf` for configuration
- ✅ Created `outputs.tf` for deployment outputs

### 5. Serverless Template (`templates/serverless.yml.template`)
- ✅ Template with dynamic values (no hardcoded "voicecert")
- ✅ Uses variables for all resource names

## What Still Needs to Be Done

### 1. Fix Hardcoded Values in Existing Files

#### `api/api.js`
- [ ] Replace hardcoded `voicecert.com` domain references with dynamic values
- [ ] Update S3 bucket names to use config
- [ ] Update SSM parameter paths

#### `firebaseInit.js`
- [ ] Make SSM parameter path configurable
- [ ] Use config file values

#### `src/email.js`
- [ ] Replace hardcoded Firebase config with dynamic config
- [ ] Update API endpoint URLs

#### `index.html`
- [ ] Replace hardcoded domain references
- [ ] Make Firebase config dynamic

### 2. Complete Terraform Implementation

- [ ] Fix Lambda function packaging (need to handle dependencies)
- [ ] Add Terraform backend configuration (S3 state)
- [ ] Add support for existing Route53 hosted zones
- [ ] Handle ACM certificate validation properly
- [ ] Add error handling and retries

### 3. Deployment Scripts

- [ ] Complete Firebase configuration setup
- [ ] Create script to upload Firebase service account to SSM
- [ ] Create script to build and deploy webmail client
- [ ] Add deployment verification steps

### 4. Testing

- [ ] Test full setup flow locally
- [ ] Test Terraform apply/destroy cycles
- [ ] Test Lambda function deployment
- [ ] Test webmail client deployment

### 5. Documentation

- [ ] Update README.md with npm package usage
- [ ] Create setup guide for end users
- [ ] Document configuration options
- [ ] Add troubleshooting guide

## How to Publish to npm

1. **Prepare the package:**
   ```bash
   # Ensure all files are ready
   npm install
   npm run build  # If you add a build step
   ```

2. **Create .npmignore:**
   ```bash
   # Create .npmignore file
   echo "node_modules/
   .git/
   *.log
   .env
   .vcmailrc
   terraform/
   *.tfstate
   *.tfstate.backup
   .terraform/
   " > .npmignore
   ```

3. **Test locally:**
   ```bash
   # Test as a local package
   npm link
   # In another directory
   npm link vcmail
   npx vcmail
   ```

4. **Publish:**
   ```bash
   npm login
   npm publish
   ```

## How Users Will Use It

1. **Install:**
   ```bash
   npm install vcmail
   ```

2. **Run setup:**
   ```bash
   npm run vcmail
   # or
   npx vcmail
   ```

3. **Follow prompts:**
   - Enter domain name
   - Enter project name
   - Enter AWS region
   - Enter Firebase project details
   - Wait for Terraform to set up infrastructure

4. **Access webmail:**
   - Navigate to `https://mail.yourdomain.com`

## Important Notes

1. **Prerequisites:** Users must have:
   - AWS CLI installed and configured
   - Terraform installed
   - Node.js 18+
   - AWS account with appropriate permissions
   - Domain name with Route53 hosted zone

2. **Costs:** This setup creates AWS resources that incur costs:
   - Route53: ~$0.50/month per hosted zone
   - SES: Free tier available, then pay-per-use
   - Lambda: Free tier available
   - S3: Minimal storage costs
   - CloudFront: Pay-per-use (free tier available)

3. **Security:** 
   - Firebase service account must be uploaded to AWS SSM
   - SSL certificates are automatically provisioned via ACM
   - IAM roles follow least-privilege principle

## Next Steps

1. Complete the hardcoded value replacements
2. Test the full deployment flow
3. Fix any Terraform issues
4. Add error handling and user feedback
5. Create comprehensive documentation
6. Publish to npm


