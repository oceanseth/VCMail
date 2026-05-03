#!/usr/bin/env node
/**
 * VCMail SES Setup Verification Script
 * Checks SES domain verification, sandbox mode, and related infrastructure
 */

const {
  SESClient,
  GetSendQuotaCommand,
  GetIdentityVerificationAttributesCommand,
  GetIdentityDkimAttributesCommand,
  DescribeActiveReceiptRuleSetCommand
} = require('@aws-sdk/client-ses');
const { LambdaClient, GetFunctionCommand } = require('@aws-sdk/client-lambda');
const { APIGatewayClient, GetRestApisCommand, GetStagesCommand } = require('@aws-sdk/client-api-gateway');
const { Route53Client, ListHostedZonesByNameCommand, ListResourceRecordSetsCommand } = require('@aws-sdk/client-route-53');
const { S3Client, HeadBucketCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getConfigWithDefaults } = require('../lib/config');
const fs = require('fs-extra');
const path = require('path');
const CONFIG_FILE = require('../lib/config').CONFIG_FILE;

async function verifySESSetup() {
  console.log('🔍 VCMail SES Setup Verification\n');
  
  // Load config
  const configPath = path.join(process.cwd(), CONFIG_FILE);
  if (!await fs.pathExists(configPath)) {
    console.error('❌ Configuration file not found. Please run "npx vcmail" first.');
    process.exit(1);
  }
  
  const config = getConfigWithDefaults(await fs.readJson(configPath));
  const region = config.awsRegion || 'us-east-1';
  const ses = new SESClient({ region });
  
  console.log(`📧 Domain: ${config.domain}`);
  console.log(`🌍 AWS Region: ${region}\n`);
  
  // 1. Check SES Sandbox Mode
  console.log('1️⃣ Checking SES Sandbox Mode...');
  try {
    const execaModule = await import('execa');
    const execa = execaModule.default || execaModule;
    const { stdout } = await execa('aws', [
      'ses', 'get-account-sending-enabled',
      '--region', region,
      '--output', 'json'
    ]);
    
    const accountInfo = JSON.parse(stdout);
    console.log(`   Account Sending Enabled: ${accountInfo.Enabled ? '✅ Yes' : '❌ No'}`);
    
    // Check sandbox mode by trying to get sending quota
    const sendingQuota = await ses.send(new GetSendQuotaCommand({}));
    console.log(`   Max Send Rate: ${sendingQuota.MaxSendRate} emails/second`);
    console.log(`   Max 24 Hour Send: ${sendingQuota.Max24HourSend} emails`);
    
    if (sendingQuota.Max24HourSend === 200) {
      console.log('   ⚠️  SES is in SANDBOX MODE - can only send to verified email addresses!');
      console.log('   📝 To request production access:');
      console.log('      https://console.aws.amazon.com/ses/home?region=' + region + '#/account');
      console.log('      Click "Request production access"');
    } else {
      console.log('   ✅ SES is in PRODUCTION MODE');
    }
  } catch (error) {
    console.log(`   ⚠️  Could not check sandbox mode: ${error.message}`);
  }
  
  // 2. Check Domain Verification
  console.log('\n2️⃣ Checking Domain Verification...');
  try {
    const domainIdentity = await ses.send(new GetIdentityVerificationAttributesCommand({
      Identities: [config.domain]
    }));
    
    const verification = domainIdentity.VerificationAttributes[config.domain];
    if (verification) {
      if (verification.VerificationStatus === 'Success') {
        console.log(`   ✅ Domain ${config.domain} is VERIFIED`);
      } else {
        console.log(`   ❌ Domain ${config.domain} is NOT VERIFIED`);
        console.log(`   Status: ${verification.VerificationStatus}`);
        console.log(`   Token: ${verification.VerificationToken}`);
        console.log('   📝 Add this TXT record to Route53:');
        console.log(`      Name: _amazonses.${config.domain}`);
        console.log(`      Value: ${verification.VerificationToken}`);
      }
    } else {
      console.log(`   ⚠️  Domain ${config.domain} not found in SES`);
      console.log('   📝 Run "npx vcmail" to set up domain verification');
    }
  } catch (error) {
    console.log(`   ⚠️  Error checking domain verification: ${error.message}`);
  }
  
  // 3. Check DKIM
  console.log('\n3️⃣ Checking DKIM Configuration...');
  try {
    const dkim = await ses.send(new GetIdentityDkimAttributesCommand({
      Identities: [config.domain]
    }));
    
    const dkimAttrs = dkim.DkimAttributes[config.domain];
    if (dkimAttrs) {
      if (dkimAttrs.DkimEnabled) {
        console.log(`   ✅ DKIM is ENABLED for ${config.domain}`);
        if (dkimAttrs.DkimTokens && dkimAttrs.DkimTokens.length > 0) {
          console.log(`   Tokens: ${dkimAttrs.DkimTokens.join(', ')}`);
        }
      } else {
        console.log(`   ⚠️  DKIM is DISABLED for ${config.domain}`);
        console.log('   📝 Run "npx vcmail" to enable DKIM');
      }
    } else {
      console.log(`   ⚠️  DKIM not configured for ${config.domain}`);
    }
  } catch (error) {
    console.log(`   ⚠️  Error checking DKIM: ${error.message}`);
  }
  
  // 4. Check Lambda Function
  console.log('\n4️⃣ Checking Lambda Function...');
  try {
    const lambda = new LambdaClient({ region });
    const functionName = 'VCMail-api';  // Shared Lambda name for all projects
    
    try {
      const func = await lambda.send(new GetFunctionCommand({ FunctionName: functionName }));
      console.log(`   ✅ Lambda function "${functionName}" exists`);
      console.log(`   Runtime: ${func.Configuration.Runtime}`);
      console.log(`   Last Modified: ${func.Configuration.LastModified}`);
      console.log(`   📝 Note: This is a shared Lambda function that loads domain-specific config from SSM`);
      
      // Check environment variables (should be minimal since config is loaded from SSM)
      if (func.Configuration.Environment && func.Configuration.Environment.Variables) {
        const env = func.Configuration.Environment.Variables;
        console.log(`   Environment Variables:`);
        console.log(`      - AWS_REGION: ${env.AWS_REGION || 'Auto-detected by Lambda'}`);
        console.log(`      - Domain-specific config loaded from SSM at runtime`);
      }
    } catch (error) {
      if (error.name === 'ResourceNotFoundException' || error.code === 'ResourceNotFoundException') {
        console.log(`   ❌ Lambda function "${functionName}" NOT FOUND`);
        console.log('   📝 Run "npx vcmail" to deploy Lambda function');
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.log(`   ⚠️  Error checking Lambda: ${error.message}`);
  }
  
  // 5. Check API Gateway
  console.log('\n5️⃣ Checking API Gateway...');
  try {
    const apigateway = new APIGatewayClient({ region });
    const apiName = `${config.projectName || config.domain.replace(/\./g, '-')}-api`;
    
    const apis = await apigateway.send(new GetRestApisCommand({ limit: 500 }));
    const api = apis.items.find(a => a.name === apiName);
    
    if (api) {
      console.log(`   ✅ API Gateway "${apiName}" exists`);
      console.log(`   ID: ${api.id}`);
      
      // Check stages
      const stages = await apigateway.send(new GetStagesCommand({ restApiId: api.id }));
      if (stages.item && stages.item.length > 0) {
        const prodStage = stages.item.find(s => s.stageName === 'prod');
        if (prodStage) {
          console.log(`   ✅ Stage "prod" exists`);
          console.log(`   Endpoint: https://${api.id}.execute-api.${region}.amazonaws.com/prod/api`);
        } else {
          console.log(`   ⚠️  Stage "prod" not found`);
        }
      }
    } else {
      console.log(`   ❌ API Gateway "${apiName}" NOT FOUND`);
      console.log('   📝 Run "npx vcmail" to deploy API Gateway');
    }
  } catch (error) {
    console.log(`   ⚠️  Error checking API Gateway: ${error.message}`);
  }
  
  // 6. Check DNS Records (Route53)
  console.log('\n6️⃣ Checking DNS Records...');
  try {
    const route53 = new Route53Client({});
    
    // Get hosted zone
    const zones = await route53.send(new ListHostedZonesByNameCommand({ DNSName: config.domain }));
    const zone = zones.HostedZones.find(z => z.Name === `${config.domain}.`);
    
    if (zone) {
      console.log(`   ✅ Hosted zone found: ${zone.Name}`);
      
      // Check MX record
      const records = await route53.send(new ListResourceRecordSetsCommand({
        HostedZoneId: zone.Id
      }));
      
      const mxRecord = records.ResourceRecordSets.find(r => 
        r.Name === `${config.domain}.` && r.Type === 'MX'
      );
      
      if (mxRecord) {
        const mxValues = mxRecord.ResourceRecords.map(r => r.Value).join(', ');
        console.log(`   ✅ MX record exists: ${mxValues}`);
        
        // Check if it points to SES inbound endpoint
        const pointsToSES = mxRecord.ResourceRecords.some(r => 
          r.Value.includes('inbound-smtp.') || 
          r.Value.includes('amazonaws.com')
        );
        if (pointsToSES) {
          console.log(`   ✅ MX record correctly points to SES inbound endpoint`);
        } else {
          console.log(`   ⚠️  MX record does not point to SES inbound endpoint`);
          console.log(`   Expected: inbound-smtp.{region}.amazonaws.com`);
        }
      } else {
        console.log(`   ⚠️  MX record NOT FOUND`);
        console.log('   📝 Run "npx vcmail" to create MX record');
      }
      
      // Check SPF record
      const spfRecord = records.ResourceRecordSets.find(r => 
        r.Name === `${config.domain}.` && r.Type === 'TXT' &&
        r.ResourceRecords.some(rr => rr.Value.includes('spf1'))
      );
      
      if (spfRecord) {
        console.log(`   ✅ SPF record exists`);
      } else {
        console.log(`   ⚠️  SPF record NOT FOUND`);
      }
      
      // Check DMARC record
      const dmarcRecord = records.ResourceRecordSets.find(r => 
        r.Name === `_dmarc.${config.domain}.` && r.Type === 'TXT' &&
        r.ResourceRecords.some(rr => rr.Value.includes('DMARC1'))
      );
      
      if (dmarcRecord) {
        console.log(`   ✅ DMARC record exists`);
      } else {
        console.log(`   ⚠️  DMARC record NOT FOUND`);
      }
    } else {
      console.log(`   ⚠️  Hosted zone NOT FOUND for ${config.domain}`);
      console.log('   📝 Ensure domain is managed by Route53 or add it manually');
    }
  } catch (error) {
    console.log(`   ⚠️  Error checking DNS records: ${error.message}`);
  }

  // 7. Check inbox S3 bucket (where SES stores incoming emails)
  console.log('\n7️⃣ Checking inbox S3 bucket (incoming emails)...');
  try {
    const s3 = new S3Client({ region });

    // First, try to discover the bucket SES is actually writing to from the active rule set
    let sesInboxBucket = null;
    try {
      const activeRuleSet = await ses.send(new DescribeActiveReceiptRuleSetCommand({}));
      const rules = activeRuleSet?.Rules || [];
      const ruleForDomain = rules.find(r =>
        Array.isArray(r.Recipients) && r.Recipients.includes(config.domain)
      );

      if (ruleForDomain) {
        const s3Action = (ruleForDomain.Actions || []).find(a => a.S3Action);
        if (s3Action && s3Action.S3Action && s3Action.S3Action.BucketName) {
          sesInboxBucket = s3Action.S3Action.BucketName;
          console.log(`   Inbox bucket from SES receipt rule: ${sesInboxBucket}`);
        } else {
          console.log('   ⚠️  SES rule for this domain has no S3 action configured');
        }
      } else {
        console.log('   ⚠️  No SES receipt rule found for this domain in the active rule set');
      }
    } catch (ruleError) {
      console.log(`   ⚠️  Could not inspect SES receipt rules for inbox bucket: ${ruleError.message}`);
    }

    // Also compute the expected bucket name from config/terraform defaults
    const derivedInboxBucket = config.s3BucketName;
    console.log(`   Inbox bucket derived from config: ${derivedInboxBucket}`);

    if (sesInboxBucket && sesInboxBucket !== derivedInboxBucket) {
      console.log('   ⚠️  MISMATCH: SES is configured to write to a different bucket than the derived one above.');
    }

    // Prefer the SES-configured bucket if available, otherwise fall back to derived name
    const inboxBucket = sesInboxBucket || derivedInboxBucket;

    // Verify the chosen bucket exists
    await s3.send(new HeadBucketCommand({ Bucket: inboxBucket }));
    console.log(`   ✅ Bucket exists: ${inboxBucket}`);

    // List a few recent objects to help debug incoming mail
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: inboxBucket,
      MaxKeys: 50
    }));

    if (!listed.Contents || listed.Contents.length === 0) {
      console.log('   ⚠️  Bucket is currently empty (no stored emails found)');
    } else {
      // Sort by LastModified descending to find latest object
      const sorted = listed.Contents.slice().sort(
        (a, b) => new Date(b.LastModified) - new Date(a.LastModified)
      );
      const latest = sorted[0];

      console.log('   ✅ Found stored emails in inbox bucket');
      console.log(`   Latest email object key: ${latest.Key}`);
      console.log(`   Last modified (UTC): ${latest.LastModified}`);
      console.log('   ℹ️  To inspect this email with AWS CLI:');
      console.log(`      aws s3 cp "s3://${inboxBucket}/${latest.Key}" -`);
    }
  } catch (error) {
    console.log(`   ⚠️  Error checking inbox S3 bucket: ${error.message}`);
  }
  
  console.log('\n✅ Verification complete!');
  console.log('\n💡 If issues were found, run "npx vcmail" to fix them.');
  console.log('\n💡 If you have multiple domains, run "npx vcmail check-domains" to check multi-domain setup.');
}

if (require.main === module) {
  verifySESSetup().catch(error => {
    console.error('❌ Verification failed:', error);
    process.exit(1);
  });
}

module.exports = { verifySESSetup };

