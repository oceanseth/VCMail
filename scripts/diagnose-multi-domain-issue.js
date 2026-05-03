#!/usr/bin/env node
/**
 * VCMail Multi-Domain Issue Diagnostic Tool
 * Diagnoses why emails aren't being delivered for a specific domain
 */

const {
  SESClient,
  DescribeActiveReceiptRuleSetCommand,
  GetIdentityVerificationAttributesCommand
} = require('@aws-sdk/client-ses');
const { LambdaClient, ListFunctionsCommand, GetFunctionCommand } = require('@aws-sdk/client-lambda');
const {
  CloudWatchLogsClient,
  DescribeLogStreamsCommand,
  GetLogEventsCommand
} = require('@aws-sdk/client-cloudwatch-logs');
const { Route53Client, ListHostedZonesByNameCommand, ListResourceRecordSetsCommand } = require('@aws-sdk/client-route-53');
const execa = require('execa');
const { getConfigWithDefaults } = require('../lib/config');
const fs = require('fs-extra');
const path = require('path');
const CONFIG_FILE = require('../lib/config').CONFIG_FILE;

async function diagnoseMultiDomainIssue() {
  console.log('🔍 VCMail Multi-Domain Issue Diagnostic\n');
  
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
  const cloudwatchlogs = new CloudWatchLogsClient({ region });
  
  console.log(`📧 Configured Domain: ${config.domain}`);
  console.log(`🌍 AWS Region: ${region}\n`);
  
  // Step 1: List ALL Lambda functions that match VCMail pattern
  console.log('1️⃣ Checking ALL VCMail Lambda Functions...\n');
  try {
    const allFunctions = await lambda.send(new ListFunctionsCommand({ MaxItems: 1000 }));
    const vcmailFunctions = allFunctions.Functions.filter(f => 
      f.FunctionName.includes('-api') || 
      f.FunctionName.includes('vcmail') ||
      f.FunctionName.includes('email-processor')
    );
    
    if (vcmailFunctions.length === 0) {
      console.log('   ⚠️  No VCMail Lambda functions found');
    } else {
      console.log(`   Found ${vcmailFunctions.length} VCMail Lambda function(s):\n`);
      
      for (const func of vcmailFunctions) {
        console.log(`   Function: ${func.FunctionName}`);
        console.log(`   ARN: ${func.FunctionArn}`);
        
        // Get detailed configuration
        try {
          const funcDetails = await lambda.send(new GetFunctionCommand({ FunctionName: func.FunctionName }));
          const env = funcDetails.Configuration.Environment?.Variables || {};
          
          // New architecture: shared Lambda "VCMail-api" loads config from SSM based on domain,
          // so VCMAIL_CONFIG is optional and usually not present.
          if (env.VCMAIL_CONFIG) {
            try {
              const vcmailConfig = JSON.parse(env.VCMAIL_CONFIG);
              console.log(`   Legacy VCMAIL_CONFIG found:`);
              console.log(`      Domain: ${vcmailConfig.domain || 'NOT SET'}`);
              console.log(`      S3 Bucket: ${vcmailConfig.s3BucketName || 'NOT SET'}`);
            } catch (parseError) {
              console.log(`   ⚠️  Could not parse VCMAIL_CONFIG: ${parseError.message}`);
            }
          } else if (funcDetails.Configuration.FunctionName === 'VCMail-api') {
            console.log('   ℹ️  Shared Lambda "VCMail-api" detected – domain-specific config is loaded from SSM at runtime (no VCMAIL_CONFIG env var needed).');
          } else {
            console.log('   ℹ️  No VCMAIL_CONFIG environment variable set (expected for shared-SSM config).');
          }
        } catch (error) {
          console.log(`   ⚠️  Error getting function details: ${error.message}`);
        }
        
        console.log('');
      }
    }
  } catch (error) {
    console.log(`   ⚠️  Error listing Lambda functions: ${error.message}`);
  }
  
  // Step 2: Check Active SES Rule Set and ALL Rules
  console.log('\n2️⃣ Checking Active SES Rule Set and ALL Rules...\n');
  try {
    // First check for active rule set
    let activeRuleSet = null;
    try {
      activeRuleSet = await ses.send(new DescribeActiveReceiptRuleSetCommand({}));
    } catch (error) {
      if (error.name === 'RuleSetDoesNotExist' || error.code === 'RuleSetDoesNotExist') {
        console.log(`   ❌ No active rule set found`);
        
        // Check if there are any rule sets that exist but aren't active
        try {
          const { stdout: listStdout } = await execa('aws', [
            'ses', 'list-receipt-rule-sets',
            '--output', 'json'
          ], { stdio: 'pipe' });
          
          const ruleSets = JSON.parse(listStdout);
          if (ruleSets.RuleSets && ruleSets.RuleSets.length > 0) {
            console.log(`\n   ⚠️  Found ${ruleSets.RuleSets.length} inactive rule set(s):`);
            for (const ruleSet of ruleSets.RuleSets) {
              console.log(`      - ${ruleSet.Name}`);
            }
            console.log(`\n   📝 To activate a rule set, run:`);
            console.log(`      aws ses set-active-receipt-rule-set --rule-set-name "${ruleSets.RuleSets[0].Name}"`);
            console.log(`   Or run "npx vcmail" to create/activate a rule set`);
          }
        } catch (listError) {
          // Ignore list errors
        }
        
        console.log(`   📝 Run "npx vcmail" to create a rule set`);
        throw error; // Re-throw to skip rest of this section
      }
      throw error;
    }
    
    if (activeRuleSet.Metadata) {
      console.log(`   Active Rule Set: ${activeRuleSet.Metadata.Name}\n`);
      
      if (activeRuleSet.Rules && activeRuleSet.Rules.length > 0) {
        console.log(`   Found ${activeRuleSet.Rules.length} rule(s) in active rule set:\n`);
        
        let foundRuleForDomain = false;
        let ruleForDomain = null;
        
        for (const rule of activeRuleSet.Rules) {
          console.log(`   Rule: ${rule.Name}`);
          console.log(`   Enabled: ${rule.Enabled ? '✅' : '❌'}`);
          
          if (rule.Recipients && rule.Recipients.length > 0) {
            console.log(`   Recipients (domains): ${rule.Recipients.join(', ')}`);
            
            // Check if this rule matches the configured domain
            if (rule.Recipients.includes(config.domain)) {
              console.log(`   ✅ This rule matches configured domain: ${config.domain}`);
              foundRuleForDomain = true;
              ruleForDomain = rule;
            }
          } else {
            console.log(`   ⚠️  No recipients configured (matches all domains)`);
          }
          
          // Check Lambda action
          const lambdaAction = rule.Actions?.find(a => a.LambdaAction);
          if (lambdaAction) {
            const functionArn = lambdaAction.LambdaAction.FunctionArn;
            console.log(`   Lambda Function ARN: ${functionArn}`);
            
            // Extract function name from ARN
            const functionNameMatch = functionArn.match(/function:(.+?)(?::|$)/);
            if (functionNameMatch) {
              const functionName = functionNameMatch[1];
              console.log(`   Lambda Function Name: ${functionName}`);
              
              // Check if this matches the expected shared function name
              const expectedFunctionName = 'VCMail-api';  // Shared Lambda name for all projects
              if (functionName === expectedFunctionName) {
                console.log(`   ✅ Lambda function name matches expected shared Lambda: ${expectedFunctionName}`);
                console.log(`   📝 This Lambda loads domain-specific config from SSM at runtime`);
              } else {
                console.log(`   ⚠️  Lambda function name doesn't match expected shared Lambda: ${expectedFunctionName}`);
                console.log(`   📝 Expected: ${expectedFunctionName} (shared Lambda)`);
                console.log(`   📝 Actual: ${functionName}`);
                console.log(`   💡 All projects should use the shared Lambda function "VCMail-api"`);
              }
            }
          } else {
            console.log(`   ❌ No Lambda action configured - emails won't be processed!`);
          }
          
          // Check S3 action
          const s3Action = rule.Actions?.find(a => a.S3Action);
          if (s3Action) {
            console.log(`   S3 Bucket: ${s3Action.S3Action.BucketName}`);
          }
          
          console.log('');
        }
        
        // Summary for configured domain
        if (!foundRuleForDomain) {
          console.log(`\n   ❌ CRITICAL: No SES receipt rule found for domain: ${config.domain}`);
          console.log(`   📝 You need to create an SES receipt rule for ${config.domain}`);
          console.log(`   Run: npx vcmail (in the project directory for ${config.domain})`);
        } else if (ruleForDomain) {
          const lambdaAction = ruleForDomain.Actions?.find(a => a.LambdaAction);
          if (!lambdaAction) {
            console.log(`\n   ❌ CRITICAL: Rule for ${config.domain} has no Lambda action!`);
            console.log(`   📝 The rule exists but won't process emails. Run: npx vcmail`);
          } else {
            const functionArn = lambdaAction.LambdaAction.FunctionArn;
            const functionNameMatch = functionArn.match(/function:(.+?)(?::|$)/);
            if (functionNameMatch) {
              const functionName = functionNameMatch[1];
              const expectedFunctionName = 'VCMail-api';
              
              if (functionName === expectedFunctionName) {
                console.log(`\n   ✅ Rule for ${config.domain} correctly points to shared Lambda: ${expectedFunctionName}`);
              } else {
                console.log(`\n   ⚠️  WARNING: Rule for ${config.domain} points to unexpected Lambda: ${functionName}`);
                console.log(`   Expected shared Lambda: ${expectedFunctionName}`);
              }
            }
          }
        }
      } else {
        console.log(`   ⚠️  No rules found in active rule set`);
        console.log(`   📝 Run "npx vcmail" to create rules`);
      }
    } else {
      console.log(`   ❌ No active rule set found`);
      console.log(`   📝 Run "npx vcmail" to create a rule set`);
    }
  } catch (error) {
    if (error.name === 'RuleSetDoesNotExist' || error.code === 'RuleSetDoesNotExist') {
      console.log(`   ❌ No active rule set found`);
      console.log(`   📝 Run "npx vcmail" to create a rule set`);
    } else {
      console.log(`   ⚠️  Error checking rule set: ${error.message}`);
    }
  }
  
  // Step 3: Check shared Lambda "VCMail-api"
  console.log('\n3️⃣ Checking Shared Lambda Function "VCMail-api"...\n');
  const expectedFunctionName = 'VCMail-api';
  console.log(`   Expected shared Lambda function name: ${expectedFunctionName}`);
  
  try {
    const expectedFunc = await lambda.send(new GetFunctionCommand({ FunctionName: expectedFunctionName }));
    console.log(`   ✅ Shared Lambda function exists: ${expectedFunctionName}`);
    console.log('   📝 This Lambda is shared by all domains and loads config from SSM based on the incoming domain.');
    
    const env = expectedFunc.Configuration.Environment?.Variables || {};
    if (env.VCMAIL_CONFIG) {
      console.log('   ℹ️  Legacy VCMAIL_CONFIG env var is present but no longer required (config is loaded from SSM).');
    } else {
      console.log('   ✅ No VCMAIL_CONFIG env var set – this is expected for the shared SSM-based configuration.');
    }
  } catch (error) {
    if (error.name === 'ResourceNotFoundException' || error.code === 'ResourceNotFoundException') {
      console.log(`   ❌ Shared Lambda function does NOT exist: ${expectedFunctionName}`);
      console.log('   📝 Run "npx vcmail" to deploy the shared Lambda function.');
    } else {
      console.log(`   ⚠️  Error checking shared Lambda: ${error.message}`);
    }
  }
  
  // Step 4: Check Domain Verification
  console.log('\n4️⃣ Checking Domain Verification...\n');
  try {
    const verificationAttrs = await ses.send(new GetIdentityVerificationAttributesCommand({
      Identities: [config.domain]
    }));
    
    const verification = verificationAttrs.VerificationAttributes[config.domain];
    if (verification) {
      const status = verification.VerificationStatus === 'Success' ? '✅ Verified' : '❌ Not Verified';
      console.log(`   ${config.domain}: ${status}`);
      
      if (verification.VerificationStatus !== 'Success') {
        console.log(`   ❌ Domain is not verified in SES!`);
        console.log(`   📝 Verify the domain in SES or run "npx vcmail" to set it up`);
      }
    } else {
      console.log(`   ❌ Domain verification not found for ${config.domain}`);
      console.log(`   📝 Run "npx vcmail" to verify the domain`);
    }
  } catch (error) {
    console.log(`   ⚠️  Error checking domain verification: ${error.message}`);
  }
  
  // Step 5: Check recent Lambda logs for VCMail-api
  console.log('\n5️⃣ Checking recent Lambda logs for "VCMail-api"...\n');
  try {
    const logGroupName = '/aws/lambda/VCMail-api';
    
    const streams = await cloudwatchlogs.send(new DescribeLogStreamsCommand({
      logGroupName,
      orderBy: 'LastEventTime',
      descending: true,
      limit: 1
    }));
    
    if (!streams.logStreams || streams.logStreams.length === 0) {
      console.log('   ⚠️  No log streams found for VCMail-api (Lambda may not have been invoked yet).');
    } else {
      const latestStream = streams.logStreams[0];
      console.log(`   Latest log stream: ${latestStream.logStreamName}`);
      console.log(`   Last event time: ${latestStream.lastEventTimestamp || 'N/A'}`);
      
      const eventsResponse = await cloudwatchlogs.send(new GetLogEventsCommand({
        logGroupName,
        logStreamName: latestStream.logStreamName,
        limit: 50,
        startFromHead: false
      }));
      
      const events = eventsResponse.events || [];
      if (events.length === 0) {
        console.log('   ⚠️  No log events found in latest stream.');
      } else {
        const errorEvents = events.filter(e => 
          e.message && (e.message.includes('ERROR') || e.message.includes('Exception') || e.message.includes('ConfigurationError'))
        );
        
        if (errorEvents.length === 0) {
          console.log('   ✅ No obvious ERROR/Exception/ConfigurationError messages in the latest Lambda logs.');
        } else {
          console.log('   ❌ Found potential error messages in the latest Lambda logs:');
          const sampleErrors = errorEvents.slice(-5);
          for (const evt of sampleErrors) {
            console.log(`      ${new Date(evt.timestamp).toISOString()} - ${evt.message.trim()}`);
          }
        }
      }
    }
  } catch (error) {
    console.log(`   ⚠️  Error checking Lambda logs: ${error.message}`);
  }
  
  // Step 6: Check MX Records
  console.log('\n6️⃣ Checking MX Records...\n');
  try {
    const route53 = new Route53Client({});
    const zones = await route53.send(new ListHostedZonesByNameCommand({ DNSName: config.domain }));
    const zone = zones.HostedZones.find(z => z.Name === `${config.domain}.`);
    
    if (zone) {
      const records = await route53.send(new ListResourceRecordSetsCommand({
        HostedZoneId: zone.Id
      }));
      
      const mxRecords = records.ResourceRecordSets.filter(r => 
        r.Type === 'MX' && (r.Name === `${config.domain}.` || r.Name === config.domain)
      );
      
      if (mxRecords.length > 0) {
        console.log(`   Found ${mxRecords.length} MX record(s) for ${config.domain}:\n`);
        for (const record of mxRecords) {
          console.log(`   ${record.Name} -> ${record.ResourceRecords.map(r => r.Value).join(', ')}`);
          
          // Check if it points to SES
          const pointsToSES = record.ResourceRecords.some(r => 
            r.Value.includes('inbound-smtp.') || 
            r.Value.includes('amazonses.com') ||
            r.Value.includes('amazonaws.com')
          );
          if (pointsToSES) {
            console.log(`      ✅ Points to SES`);
          } else {
            console.log(`      ⚠️  Does NOT point to SES`);
            console.log(`      Expected: inbound-smtp.${region}.amazonaws.com`);
          }
        }
      } else {
        console.log(`   ❌ No MX records found for ${config.domain}`);
        console.log(`   📝 Run "npx vcmail" to create MX records`);
      }
    } else {
      console.log(`   ⚠️  Hosted zone not found for ${config.domain}`);
    }
  } catch (error) {
    console.log(`   ⚠️  Error checking MX records: ${error.message}`);
  }
  
  console.log('\n✅ Diagnostic complete!');
  console.log('\n💡 Common Issues and Fixes:');
  console.log('   1. Missing SES receipt rule: Run "npx vcmail" in the project directory');
  console.log('   2. Rule points to wrong Lambda: Ensure it points to shared "VCMail-api"');
  console.log('   3. Domain not verified: Run "npx vcmail" to verify domain');
}

if (require.main === module) {
  diagnoseMultiDomainIssue().catch(error => {
    console.error('❌ Diagnostic failed:', error);
    process.exit(1);
  });
}

module.exports = { diagnoseMultiDomainIssue };

