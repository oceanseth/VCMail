#!/usr/bin/env node
/**
 * VCMail Multi-Domain Setup Checker
 * Checks SES receipt rules and Lambda configuration for multiple domains
 */

const {
  SESClient,
  DescribeActiveReceiptRuleSetCommand,
  ListIdentitiesCommand,
  GetIdentityVerificationAttributesCommand
} = require('@aws-sdk/client-ses');
const { LambdaClient, GetFunctionCommand } = require('@aws-sdk/client-lambda');
const { Route53Client, ListHostedZonesByNameCommand, ListResourceRecordSetsCommand } = require('@aws-sdk/client-route-53');
const { getConfigWithDefaults } = require('../lib/config');
const fs = require('fs-extra');
const path = require('path');
const CONFIG_FILE = require('../lib/config').CONFIG_FILE;

async function checkMultiDomainSetup() {
  console.log('🔍 VCMail Multi-Domain Setup Checker\n');
  
  // Load config
  const configPath = path.join(process.cwd(), CONFIG_FILE);
  if (!await fs.pathExists(configPath)) {
    console.error('❌ Configuration file not found. Please run "npx vcmail" first.');
    process.exit(1);
  }
  
  const config = getConfigWithDefaults(await fs.readJson(configPath));
  const region = config.awsRegion || 'us-east-1';
  const ses = new SESClient({ region });
  const lambda = new LambdaClient({ region });
  
  console.log(`📧 Configured Domain: ${config.domain}`);
  console.log(`🌍 AWS Region: ${region}\n`);
  
  // 1. Check Lambda Environment Variables
  console.log('1️⃣ Checking Lambda Configuration...');
  try {
    const functionName = 'VCMail-api';  // Shared Lambda name for all projects
    const func = await lambda.send(new GetFunctionCommand({ FunctionName: functionName }));
    
    console.log(`   ✅ Shared Lambda function "${functionName}" exists`);
    console.log(`   📝 This Lambda loads domain-specific config from SSM at runtime`);
    console.log(`   📝 Domain: ${config.domain} (config loaded from SSM prefix: ${config.ssmPrefix || 'derived from domain'})`);
    
    if (func.Configuration.Environment && func.Configuration.Environment.Variables) {
      const env = func.Configuration.Environment.Variables;
      console.log(`   Environment Variables:`);
      console.log(`      - AWS_REGION: ${env.AWS_REGION || 'Auto-detected by Lambda'}`);
      console.log(`      - Domain-specific config: Loaded from SSM at runtime`);
    }
  } catch (error) {
    if (error.name === 'ResourceNotFoundException' || error.code === 'ResourceNotFoundException') {
      console.log(`   ❌ Shared Lambda function "VCMail-api" NOT FOUND`);
      console.log(`   📝 Run "npx vcmail" to deploy the shared Lambda function`);
    } else {
      console.log(`   ⚠️  Error checking Lambda: ${error.message}`);
    }
  }
  
  // 2. Check Active SES Rule Set
  console.log('\n2️⃣ Checking Active SES Rule Set...');
  try {
    const activeRuleSet = await ses.send(new DescribeActiveReceiptRuleSetCommand({}));
    
    if (activeRuleSet.Metadata) {
      console.log(`   ✅ Active Rule Set: ${activeRuleSet.Metadata.Name}`);
      
      // 3. Check All Rules in Active Rule Set
      console.log('\n3️⃣ Checking SES Receipt Rules...');
      if (activeRuleSet.Rules && activeRuleSet.Rules.length > 0) {
        console.log(`   Found ${activeRuleSet.Rules.length} rule(s):\n`);
        
        let domainsFound = [];
        
        for (const rule of activeRuleSet.Rules) {
          console.log(`   Rule: ${rule.Name}`);
          console.log(`   Enabled: ${rule.Enabled ? '✅' : '❌'}`);
          
          if (rule.Recipients && rule.Recipients.length > 0) {
            console.log(`   Recipients (domains): ${rule.Recipients.join(', ')}`);
            domainsFound.push(...rule.Recipients);
            
            // Check if this rule matches the configured domain
            if (rule.Recipients.includes(config.domain)) {
              console.log(`   ✅ This rule matches configured domain: ${config.domain}`);
            } else {
              console.log(`   ⚠️  This rule does NOT match configured domain: ${config.domain}`);
            }
          } else {
            console.log(`   ⚠️  No recipients configured (matches all domains)`);
          }
          
          // Check Lambda action
          const lambdaAction = rule.Actions?.find(a => a.LambdaAction);
          if (lambdaAction) {
            console.log(`   Lambda Function: ${lambdaAction.LambdaAction.FunctionArn}`);
            
            // Extract function name from ARN
            const functionNameMatch = lambdaAction.LambdaAction.FunctionArn.match(/function:(.+?)(?::|$)/);
            if (functionNameMatch) {
              const functionName = functionNameMatch[1];
              console.log(`   Lambda Function Name: ${functionName}`);
              
              // Check if this matches the expected function
              const expectedFunctionName = `${config.projectName || config.domain.replace(/\./g, '-')}-api`;
              if (functionName === expectedFunctionName) {
                console.log(`   ✅ Lambda function matches expected name`);
              } else {
                console.log(`   ⚠️  Lambda function name doesn't match expected: ${expectedFunctionName}`);
              }
            }
          } else {
            console.log(`   ❌ No Lambda action configured`);
          }
          
          // Check S3 action
          const s3Action = rule.Actions?.find(a => a.S3Action);
          if (s3Action) {
            console.log(`   S3 Bucket: ${s3Action.S3Action.BucketName}`);
          }
          
          console.log(''); // Empty line between rules
        }
        
        // Summary
        console.log(`\n📊 Summary:`);
        console.log(`   Domains with SES rules: ${[...new Set(domainsFound)].join(', ')}`);
        
        if (!domainsFound.includes(config.domain)) {
          console.log(`   ⚠️  WARNING: Configured domain "${config.domain}" does NOT have an SES receipt rule!`);
          console.log(`   📝 You need to create an SES receipt rule for ${config.domain}`);
          console.log(`   Run: npx vcmail (in the project directory for ${config.domain})`);
        }
        
        // Check for multiple domains
        const uniqueDomains = [...new Set(domainsFound)];
        if (uniqueDomains.length > 1) {
          console.log(`\n   ℹ️  Multiple domains detected: ${uniqueDomains.join(', ')}`);
          console.log(`   ⚠️  IMPORTANT: Lambda function only processes emails for ONE domain`);
          console.log(`   Current Lambda domain: ${config.domain}`);
          console.log(`   If emails for other domains aren't being processed, the Lambda needs to be updated`);
        }
        
      } else {
        console.log(`   ⚠️  No rules found in active rule set`);
      }
    } else {
      console.log(`   ⚠️  No active rule set found`);
    }
  } catch (error) {
    if (error.name === 'RuleSetDoesNotExist' || error.code === 'RuleSetDoesNotExist') {
      console.log(`   ❌ No active rule set found`);
      console.log(`   📝 Run "npx vcmail" to create a rule set`);
    } else {
      console.log(`   ⚠️  Error checking rule set: ${error.message}`);
    }
  }
  
  // 4. Check Domain Verification for All Domains
  console.log('\n4️⃣ Checking Domain Verification...');
  try {
    // Get all verified identities
    const identities = await ses.send(new ListIdentitiesCommand({ IdentityType: 'Domain' }));
    
    if (identities.Identities && identities.Identities.length > 0) {
      console.log(`   Found ${identities.Identities.length} verified domain(s):\n`);
      
      const verificationAttrs = await ses.send(new GetIdentityVerificationAttributesCommand({
        Identities: identities.Identities
      }));
      
      for (const domain of identities.Identities) {
        const verification = verificationAttrs.VerificationAttributes[domain];
        if (verification) {
          const status = verification.VerificationStatus === 'Success' ? '✅ Verified' : '❌ Not Verified';
          console.log(`   ${domain}: ${status}`);
          
          if (domain === config.domain && verification.VerificationStatus !== 'Success') {
            console.log(`      ⚠️  Configured domain is not verified!`);
          }
        }
      }
    } else {
      console.log(`   ⚠️  No verified domains found`);
    }
  } catch (error) {
    console.log(`   ⚠️  Error checking domain verification: ${error.message}`);
  }
  
  // 5. Check MX Records
  console.log('\n5️⃣ Checking MX Records...');
  try {
    const route53 = new Route53Client({});
    const zones = await route53.send(new ListHostedZonesByNameCommand({ DNSName: config.domain }));
    const zone = zones.HostedZones.find(z => z.Name === `${config.domain}.`);
    
    if (zone) {
      const records = await route53.send(new ListResourceRecordSetsCommand({
        HostedZoneId: zone.Id
      }));
      
      const mxRecords = records.ResourceRecordSets.filter(r => r.Type === 'MX');
      
      if (mxRecords.length > 0) {
        console.log(`   Found ${mxRecords.length} MX record(s):\n`);
        for (const record of mxRecords) {
          console.log(`   ${record.Name} -> ${record.ResourceRecords.map(r => r.Value).join(', ')}`);
          
          // Check if it points to SES (inbound endpoint for receiving emails)
          const pointsToSES = record.ResourceRecords.some(r => 
            r.Value.includes('inbound-smtp.') || 
            r.Value.includes('amazonses.com') ||
            r.Value.includes('amazonaws.com')
          );
          if (pointsToSES) {
            console.log(`      ✅ Points to SES`);
          } else {
            console.log(`      ⚠️  Does NOT point to SES`);
            console.log(`      Expected: inbound-smtp.{region}.amazonaws.com`);
          }
        }
      } else {
        console.log(`   ⚠️  No MX records found`);
      }
    } else {
      console.log(`   ⚠️  Hosted zone not found for ${config.domain}`);
    }
  } catch (error) {
    console.log(`   ⚠️  Error checking MX records: ${error.message}`);
  }
  
  console.log('\n✅ Multi-domain check complete!');
  console.log('\n💡 If issues were found:');
  console.log('   1. Ensure each domain has its own SES receipt rule');
  console.log('   2. Check Lambda environment variables match the domain you want to process');
  console.log('   3. Verify MX records point to SES for each domain');
}

if (require.main === module) {
  checkMultiDomainSetup().catch(error => {
    console.error('❌ Check failed:', error);
    process.exit(1);
  });
}

module.exports = { checkMultiDomainSetup };

