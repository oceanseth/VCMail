#!/usr/bin/env node
/**
 * VCMail SES Setup Verification Script
 * Checks SES domain verification, sandbox mode, and related infrastructure
 */

const AWS = require('aws-sdk');
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
  const ses = new AWS.SES({ region });
  
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
    const sendingQuota = await ses.getSendQuota().promise();
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
    const domainIdentity = await ses.getIdentityVerificationAttributes({
      Identities: [config.domain]
    }).promise();
    
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
    const dkim = await ses.getIdentityDkimAttributes({
      Identities: [config.domain]
    }).promise();
    
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
    const lambda = new AWS.Lambda({ region });
    const functionName = `${config.projectName || config.domain.replace(/\./g, '-')}-api`;
    
    try {
      const func = await lambda.getFunction({ FunctionName: functionName }).promise();
      console.log(`   ✅ Lambda function "${functionName}" exists`);
      console.log(`   Runtime: ${func.Configuration.Runtime}`);
      console.log(`   Last Modified: ${func.Configuration.LastModified}`);
      
      // Check environment variables
      if (func.Configuration.Environment && func.Configuration.Environment.Variables) {
        const env = func.Configuration.Environment.Variables;
        console.log(`   Environment Variables:`);
        console.log(`      - Domain: ${env.VCMAIL_CONFIG ? JSON.parse(env.VCMAIL_CONFIG).domain : 'N/A'}`);
        console.log(`      - Firebase Config: ${env.FIREBASE_CONFIG ? '✅ Set' : '❌ Missing'}`);
      }
    } catch (error) {
      if (error.code === 'ResourceNotFoundException') {
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
    const apigateway = new AWS.APIGateway({ region });
    const apiName = `${config.projectName || config.domain.replace(/\./g, '-')}-api`;
    
    const apis = await apigateway.getRestApis({ limit: 500 }).promise();
    const api = apis.items.find(a => a.name === apiName);
    
    if (api) {
      console.log(`   ✅ API Gateway "${apiName}" exists`);
      console.log(`   ID: ${api.id}`);
      
      // Check stages
      const stages = await apigateway.getStages({ restApiId: api.id }).promise();
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
    const route53 = new AWS.Route53();
    
    // Get hosted zone
    const zones = await route53.listHostedZonesByName({ DNSName: config.domain }).promise();
    const zone = zones.HostedZones.find(z => z.Name === `${config.domain}.`);
    
    if (zone) {
      console.log(`   ✅ Hosted zone found: ${zone.Name}`);
      
      // Check MX record
      const records = await route53.listResourceRecordSets({
        HostedZoneId: zone.Id
      }).promise();
      
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

