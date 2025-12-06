# CloudFront API Gateway Integration Debugging Guide

## Issue Summary

CloudFront serves S3 webmail content correctly at `https://mail.masky.ai`, but API calls to `/api/*` fail with `{"message": "Internal server error"}`.

## Findings

### ✅ What's Working
1. **CloudFront Configuration**: Correctly configured with:
   - API Gateway origin: `API-vgv1rnzmhi`
   - Origin path: `/prod` ✓
   - Cache behavior for `/api/*` targeting API Gateway ✓
   - Required headers forwarded (Authorization, Content-Type, X-Requested-With) ✓

2. **API Gateway → Lambda**: Test-invoke works perfectly, returns health endpoint response

3. **Lambda Function**: Health endpoint code is deployed and working

### ❌ What's Failing
- CloudFront → API Gateway calls return `{"message": "Internal server error"}`
- Direct API Gateway calls (bypassing CloudFront) also fail with same error
- This suggests the issue is API Gateway → Lambda, not CloudFront routing

## Debugging Steps

### 1. Enable CloudFront Logging

CloudFront logging is currently disabled. To enable it:

```bash
# Create S3 bucket for logs (if needed)
aws s3 mb s3://masky-ai-cloudfront-logs

# Update CloudFront distribution to enable logging
# This must be done via Terraform - add logging config to main.tf
```

### 2. Check CloudWatch Logs

```bash
# Check Lambda logs for recent errors
aws logs tail /aws/lambda/masky-ai-mail-api --since 1h --format short

# Filter for errors
aws logs filter-log-events \
  --log-group-name /aws/lambda/masky-ai-mail-api \
  --filter-pattern "error" \
  --start-time $(date -d '1 hour ago' +%s)000
```

### 3. Test API Gateway Directly

```bash
# Test health endpoint via API Gateway (bypassing CloudFront)
curl -X POST https://vgv1rnzmhi.execute-api.us-east-1.amazonaws.com/prod/api/test \
  -H "Content-Type: application/json"

# Test via CloudFront
curl -X POST https://mail.masky.ai/api/test \
  -H "Content-Type: application/json"
```

### 4. Verify CloudFront Distribution Status

```bash
# Check if distribution is fully deployed
aws cloudfront get-distribution --id E2NP40VCZZ8OU0 \
  --query "Distribution.Status"

# Should return "Deployed"
```

### 5. Check for Configuration Drift

Run the verification script:
```bash
node scripts/check-cloudfront-config.js mail.masky.ai vgv1rnzmhi prod
```

## Common Issues

### Issue: CloudFront Cache
**Symptom**: Changes not reflected, old errors cached
**Solution**: Invalidate CloudFront cache
```bash
aws cloudfront create-invalidation \
  --distribution-id E2NP40VCZZ8OU0 \
  --paths "/*"
```

### Issue: API Gateway Stage Not Deployed
**Symptom**: API Gateway changes not active
**Solution**: Ensure Terraform creates/updates API Gateway deployment
```bash
cd .vcmail-terraform
terraform plan  # Check if API Gateway deployment needs update
terraform apply
```

### Issue: Lambda Function Not Updated
**Symptom**: Old Lambda code running
**Solution**: Redeploy Lambda package
```bash
# From masky-ai project directory
npx vcmail  # This will prepare and deploy Lambda
```

### Issue: Origin Path Mismatch
**Symptom**: API Gateway receives wrong path
**Solution**: Verify CloudFront origin path matches API Gateway stage
- Expected: `/prod`
- Check: `aws cloudfront get-distribution-config --id E2NP40VCZZ8OU0`

## Automated Detection

The `npx vcmail` setup now includes automatic CloudFront configuration verification:

1. After Terraform apply, it checks:
   - API Gateway origin exists
   - Origin path matches stage name
   - Cache behavior targets correct origin
   - Required headers are forwarded

2. Warnings are displayed if configuration drift is detected

## Next Steps

1. **Enable CloudFront Logging** - Add logging config to Terraform
2. **Check Recent Lambda Logs** - Look for actual error messages
3. **Verify API Gateway Deployment** - Ensure latest deployment is active
4. **Test with CloudFront Cache Cleared** - Invalidate and retry

## Scripts

- `scripts/check-cloudfront-config.js` - Verifies CloudFront configuration
- Run from VCMail package directory: `node scripts/check-cloudfront-config.js <domain> <api-gateway-id> [stage]`


