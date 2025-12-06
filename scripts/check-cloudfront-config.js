/**
 * Check CloudFront configuration and detect issues with API Gateway integration
 * This script compares the actual CloudFront distribution with expected Terraform configuration
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function runCommand(command) {
  try {
    return JSON.parse(execSync(command, { encoding: 'utf-8', stdio: 'pipe' }));
  } catch (error) {
    console.error(`Error running command: ${command}`);
    console.error(error.message);
    return null;
  }
}

function checkCloudFrontConfig(domain, apiGatewayId, stageName = 'prod') {
  console.log(`\n🔍 Checking CloudFront configuration for ${domain}...\n`);
  
  // Find CloudFront distribution by domain alias
  const distributions = runCommand(
    `aws cloudfront list-distributions --query "DistributionList.Items[*].{Id:Id,Aliases:Aliases.Items,DomainName:DomainName}" --output json`
  );
  
  if (!distributions || distributions.length === 0) {
    console.error('❌ No CloudFront distributions found');
    return false;
  }
  
  const distribution = distributions.find(dist => 
    dist.Aliases && dist.Aliases.includes(domain)
  );
  
  if (!distribution) {
    console.error(`❌ No CloudFront distribution found for domain: ${domain}`);
    return false;
  }
  
  console.log(`✓ Found CloudFront distribution: ${distribution.Id}`);
  console.log(`  Domain: ${distribution.DomainName}\n`);
  
  // Get full distribution config
  const distConfig = runCommand(
    `aws cloudfront get-distribution-config --id ${distribution.Id} --query "DistributionConfig" --output json`
  );
  
  if (!distConfig) {
    console.error('❌ Failed to get distribution configuration');
    return false;
  }
  
  // Check origins
  console.log('📋 Checking Origins:');
  const apiOriginId = `API-${apiGatewayId}`;
  const apiOrigin = distConfig.Origins.Items.find(origin => origin.Id === apiOriginId);
  
  if (!apiOrigin) {
    console.error(`❌ API Gateway origin not found! Expected origin ID: ${apiOriginId}`);
    console.log(`\nFound origins:`);
    distConfig.Origins.Items.forEach(origin => {
      console.log(`  - ${origin.Id}: ${origin.DomainName}`);
    });
    return false;
  }
  
  console.log(`✓ API Gateway origin found: ${apiOriginId}`);
  console.log(`  Domain: ${apiOrigin.DomainName}`);
  console.log(`  Origin Path: ${apiOrigin.OriginPath || '(none)'}`);
  
  const expectedOriginPath = `/${stageName}`;
  if (apiOrigin.OriginPath !== expectedOriginPath) {
    console.error(`\n❌ Origin Path mismatch!`);
    console.error(`  Expected: ${expectedOriginPath}`);
    console.error(`  Actual: ${apiOrigin.OriginPath || '(none)'}`);
    console.error(`\n  This will cause API Gateway to receive incorrect paths!`);
    return false;
  }
  
  console.log(`✓ Origin Path is correct: ${expectedOriginPath}\n`);
  
  // Check cache behaviors
  console.log('📋 Checking Cache Behaviors:');
  const apiCacheBehavior = distConfig.CacheBehaviors?.Items?.find(
    behavior => behavior.PathPattern === '/api/*'
  );
  
  if (!apiCacheBehavior) {
    console.error(`❌ Cache behavior for /api/* not found!`);
    if (distConfig.CacheBehaviors?.Items) {
      console.log(`\nFound cache behaviors:`);
      distConfig.CacheBehaviors.Items.forEach(behavior => {
        console.log(`  - ${behavior.PathPattern}: ${behavior.TargetOriginId}`);
      });
    }
    return false;
  }
  
  console.log(`✓ Cache behavior for /api/* found`);
  console.log(`  Target Origin: ${apiCacheBehavior.TargetOriginId}`);
  
  if (apiCacheBehavior.TargetOriginId !== apiOriginId) {
    console.error(`\n❌ Cache behavior targets wrong origin!`);
    console.error(`  Expected: ${apiOriginId}`);
    console.error(`  Actual: ${apiCacheBehavior.TargetOriginId}`);
    return false;
  }
  
  console.log(`✓ Cache behavior targets correct origin\n`);
  
  // Check forwarded headers
  console.log('📋 Checking Forwarded Headers:');
  const forwardedHeaders = apiCacheBehavior.ForwardedValues?.Headers?.Items || [];
  const requiredHeaders = ['Authorization', 'Content-Type', 'X-Requested-With'];
  const missingHeaders = requiredHeaders.filter(h => !forwardedHeaders.includes(h));
  
  if (missingHeaders.length > 0) {
    console.error(`❌ Missing forwarded headers: ${missingHeaders.join(', ')}`);
    return false;
  }
  
  console.log(`✓ All required headers are forwarded: ${forwardedHeaders.join(', ')}\n`);
  
  // Test API Gateway directly
  console.log('🧪 Testing API Gateway directly...');
  const apiGatewayUrl = `https://${apiGatewayId}.execute-api.us-east-1.amazonaws.com/${stageName}/api/test`;
  try {
    const response = execSync(
      `curl -s -X POST "${apiGatewayUrl}" -H "Content-Type: application/json"`,
      { encoding: 'utf-8', stdio: 'pipe', timeout: 10000 }
    );
    const result = JSON.parse(response);
    if (result.status === 'ok') {
      console.log(`✓ API Gateway test endpoint works: ${result.message}`);
    } else {
      console.error(`❌ API Gateway returned unexpected response:`, result);
    }
  } catch (error) {
    console.error(`❌ Failed to test API Gateway: ${error.message}`);
  }
  
  // Summary
  console.log(`\n✅ CloudFront configuration looks correct!`);
  console.log(`\nIf API calls are still failing, check:`);
  console.log(`  1. CloudFront distribution status (should be "Deployed")`);
  console.log(`  2. CloudFront cache invalidation (may need to invalidate /*)`);
  console.log(`  3. Lambda function logs in CloudWatch`);
  console.log(`  4. API Gateway stage deployment`);
  
  return true;
}

// Main execution
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node check-cloudfront-config.js <domain> <api-gateway-id> [stage-name]');
    console.error('Example: node check-cloudfront-config.js mail.masky.ai vgv1rnzmhi prod');
    process.exit(1);
  }
  
  const domain = args[0];
  const apiGatewayId = args[1];
  const stageName = args[2] || 'prod';
  
  const success = checkCloudFrontConfig(domain, apiGatewayId, stageName);
  process.exit(success ? 0 : 1);
}

module.exports = { checkCloudFrontConfig };


