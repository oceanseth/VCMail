#!/usr/bin/env node

/**
 * Script to identify and clean up old Terraform resources when project_name changes
 * 
 * Usage:
 *   node scripts/cleanup-old-resources.js <old-project-name>
 *   OR
 *   npx vcmail cleanup-old-resources <old-project-name>
 * 
 * Example:
 *   node scripts/cleanup-old-resources.js masky-mail
 *   npx vcmail cleanup-old-resources masky-mail
 */

const { execSync } = require('child_process');
const readline = require('readline');

// Support being called directly or via bin/vcmail.js
// If called via bin/vcmail.js, process.argv was modified to: ['node', 'cleanup-old-resources.js', projectName]
// If called directly, process.argv is: ['node', 'path/to/script.js', projectName]
const OLD_PROJECT_NAME = process.argv[2];

if (!OLD_PROJECT_NAME) {
  console.error('Error: Please provide the old project name');
  console.error('Usage: node scripts/cleanup-old-resources.js <old-project-name>');
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

function runCommand(command) {
  try {
    return execSync(command, { encoding: 'utf-8', stdio: 'pipe' });
  } catch (error) {
    return error.stdout || error.message;
  }
}

async function findResources() {
  console.log(`\n🔍 Searching for resources with project name: ${OLD_PROJECT_NAME}\n`);
  
  const resources = {
    lambda: [],
    iamRole: [],
    iamPolicy: [],
    apiGateway: [],
    cloudfrontOAC: [],
    sesConfigSet: [],
    sesRuleSet: [],
    sesReceiptRule: [],
    lambdaPermissions: []
  };

  // Find Lambda functions
  console.log('Checking Lambda functions...');
  const lambdaOutput = runCommand(`aws lambda list-functions --query "Functions[?contains(FunctionName, '${OLD_PROJECT_NAME}')].FunctionName" --output json`);
  try {
    resources.lambda = JSON.parse(lambdaOutput);
  } catch (e) {
    console.log('  No Lambda functions found or error querying');
  }

  // Find IAM Roles
  console.log('Checking IAM Roles...');
  const roleOutput = runCommand(`aws iam list-roles --query "Roles[?contains(RoleName, '${OLD_PROJECT_NAME}')].RoleName" --output json`);
  try {
    resources.iamRole = JSON.parse(roleOutput);
  } catch (e) {
    console.log('  No IAM roles found or error querying');
  }

  // Find IAM Policies (inline policies)
  console.log('Checking IAM Policies...');
  if (resources.iamRole.length > 0) {
    for (const roleName of resources.iamRole) {
      const policyOutput = runCommand(`aws iam list-role-policies --role-name ${roleName} --output json`);
      try {
        const policies = JSON.parse(policyOutput);
        if (policies.PolicyNames && policies.PolicyNames.length > 0) {
          resources.iamPolicy.push({ role: roleName, policies: policies.PolicyNames });
        }
      } catch (e) {
        // Ignore errors
      }
    }
  }

  // Find API Gateways
  console.log('Checking API Gateways...');
  const apiOutput = runCommand(`aws apigateway get-rest-apis --query "items[?contains(name, '${OLD_PROJECT_NAME}')].{Name:name,Id:id}" --output json`);
  try {
    resources.apiGateway = JSON.parse(apiOutput);
  } catch (e) {
    console.log('  No API Gateways found or error querying');
  }

  // Find CloudFront OACs
  console.log('Checking CloudFront Origin Access Controls...');
  const oacOutput = runCommand(`aws cloudfront list-origin-access-controls --query "OriginAccessControlList.Items[?contains(Name, '${OLD_PROJECT_NAME}')].{Id:Id,Name:Name}" --output json`);
  try {
    resources.cloudfrontOAC = JSON.parse(oacOutput);
  } catch (e) {
    console.log('  No CloudFront OACs found or error querying');
  }

  // Find SES Configuration Sets
  console.log('Checking SES Configuration Sets...');
  const sesConfigOutput = runCommand(`aws sesv2 list-configuration-sets --query "ConfigurationSets[?contains(Name, '${OLD_PROJECT_NAME}')].Name" --output json`);
  try {
    resources.sesConfigSet = JSON.parse(sesConfigOutput);
  } catch (e) {
    console.log('  No SES Configuration Sets found or error querying');
  }

  // Find SES Rule Sets
  console.log('Checking SES Rule Sets...');
  const sesRuleSetOutput = runCommand(`aws ses describe-active-receipt-rule-set --query "Metadata.Name" --output text 2>/dev/null || echo "[]"`);
  try {
    const activeRuleSet = sesRuleSetOutput.trim();
    if (activeRuleSet && activeRuleSet.includes(OLD_PROJECT_NAME)) {
      resources.sesRuleSet.push(activeRuleSet);
    }
  } catch (e) {
    // Ignore
  }

  // Find Lambda Permissions
  console.log('Checking Lambda Permissions...');
  if (resources.lambda.length > 0) {
    for (const funcName of resources.lambda) {
      const policyOutput = runCommand(`aws lambda get-policy --function-name ${funcName} --output json 2>/dev/null || echo '{}'`);
      try {
        const policy = JSON.parse(policyOutput);
        if (policy.Policy) {
          const policyDoc = JSON.parse(policy.Policy);
          if (policyDoc.Statement) {
            resources.lambdaPermissions.push({
              function: funcName,
              statements: policyDoc.Statement.length
            });
          }
        }
      } catch (e) {
        // Ignore
      }
    }
  }

  return resources;
}

function displayResources(resources) {
  console.log('\n📋 Found Resources:\n');
  
  if (resources.lambda.length > 0) {
    console.log('Lambda Functions:');
    resources.lambda.forEach(name => console.log(`  - ${name}`));
  }
  
  if (resources.iamRole.length > 0) {
    console.log('\nIAM Roles:');
    resources.iamRole.forEach(name => console.log(`  - ${name}`));
  }
  
  if (resources.iamPolicy.length > 0) {
    console.log('\nIAM Policies (inline):');
    resources.iamPolicy.forEach(({ role, policies }) => {
      policies.forEach(policy => console.log(`  - ${role}/${policy}`));
    });
  }
  
  if (resources.apiGateway.length > 0) {
    console.log('\nAPI Gateways:');
    resources.apiGateway.forEach(({ Name, Id }) => console.log(`  - ${Name} (${Id})`));
  }
  
  if (resources.cloudfrontOAC.length > 0) {
    console.log('\nCloudFront Origin Access Controls:');
    resources.cloudfrontOAC.forEach(({ Id, Name }) => console.log(`  - ${Name} (${Id})`));
  }
  
  if (resources.sesConfigSet.length > 0) {
    console.log('\nSES Configuration Sets:');
    resources.sesConfigSet.forEach(name => console.log(`  - ${name}`));
  }
  
  if (resources.sesRuleSet.length > 0) {
    console.log('\nSES Rule Sets:');
    resources.sesRuleSet.forEach(name => console.log(`  - ${name}`));
  }
  
  const totalCount = resources.lambda.length + 
                     resources.iamRole.length + 
                     resources.apiGateway.length + 
                     resources.cloudfrontOAC.length + 
                     resources.sesConfigSet.length + 
                     resources.sesRuleSet.length;
  
  console.log(`\nTotal resources found: ${totalCount}`);
  
  return totalCount > 0;
}

function generateDeleteCommands(resources) {
  const commands = [];
  
  // Delete Lambda functions (must delete permissions first)
  resources.lambda.forEach(funcName => {
    commands.push({
      description: `Delete Lambda function: ${funcName}`,
      command: `aws lambda delete-function --function-name ${funcName}`,
      warning: 'This will delete the Lambda function and all its versions'
    });
  });
  
  // Delete API Gateways (must delete deployments and stages first)
  resources.apiGateway.forEach(({ Name, Id }) => {
    commands.push({
      description: `Delete API Gateway: ${Name} (${Id})`,
      command: `aws apigateway delete-rest-api --rest-api-id ${Id}`,
      warning: 'This will delete the entire API Gateway. Make sure no CloudFront distributions are using it!',
      prerequisite: 'First delete all stages and deployments'
    });
  });
  
  // Delete IAM Policies (inline policies)
  resources.iamPolicy.forEach(({ role, policies }) => {
    policies.forEach(policy => {
      commands.push({
        description: `Delete IAM Policy: ${role}/${policy}`,
        command: `aws iam delete-role-policy --role-name ${role} --policy-name ${policy}`
      });
    });
  });
  
  // Delete IAM Roles (must delete policies first)
  resources.iamRole.forEach(roleName => {
    commands.push({
      description: `Delete IAM Role: ${roleName}`,
      command: `aws iam delete-role --role-name ${roleName}`,
      warning: 'Make sure all policies attached to this role are deleted first'
    });
  });
  
  // Delete CloudFront OACs
  resources.cloudfrontOAC.forEach(({ Id, Name }) => {
    commands.push({
      description: `Delete CloudFront OAC: ${Name} (${Id})`,
      command: `# First get the ETag:\naws cloudfront get-origin-access-control --id ${Id} --query "ETag" --output text\n# Then delete with the ETag:\naws cloudfront delete-origin-access-control --id ${Id} --if-match <ETag>`,
      warning: 'Make sure no CloudFront distributions are using this OAC. You need to get the ETag first.',
      note: 'Replace <ETag> with the ETag value from the get command above'
    });
  });
  
  // Delete SES Configuration Sets
  resources.sesConfigSet.forEach(name => {
    commands.push({
      description: `Delete SES Configuration Set: ${name}`,
      command: `aws sesv2 delete-configuration-set --configuration-set-name ${name}`
    });
  });
  
  // Note about SES Rule Sets - these are trickier
  if (resources.sesRuleSet.length > 0) {
    commands.push({
      description: 'SES Rule Sets',
      command: 'Manual cleanup required - see AWS Console',
      warning: 'SES Rule Sets require manual cleanup. Check AWS SES Console for active rule sets.'
    });
  }
  
  return commands;
}

async function main() {
  console.log('🧹 VCMail Resource Cleanup Tool');
  console.log('================================\n');
  console.log(`Looking for resources with project name: ${OLD_PROJECT_NAME}`);
  console.log('⚠️  WARNING: This will help you identify resources to delete.');
  console.log('   Make sure you have verified these are the correct resources!\n');
  
  const resources = await findResources();
  const hasResources = displayResources(resources);
  
  if (!hasResources) {
    console.log('\n✅ No resources found with that project name. Nothing to clean up!');
    rl.close();
    return;
  }
  
  console.log('\n⚠️  IMPORTANT NOTES:');
  console.log('   1. Delete resources in this order:');
  console.log('      a. Lambda Permissions (if any)');
  console.log('      b. Lambda Functions');
  console.log('      c. API Gateway Stages/Deployments');
  console.log('      d. API Gateways');
  console.log('      e. IAM Policies (inline)');
  console.log('      f. IAM Roles');
  console.log('      g. CloudFront OACs (if not in use)');
  console.log('      h. SES Configuration Sets');
  console.log('   2. Some resources may have dependencies - check AWS Console');
  console.log('   3. CloudFront distributions using these resources must be updated first');
  console.log('   4. SES Rule Sets require manual cleanup via AWS Console\n');
  
  const answer = await question('Do you want to see the delete commands? (yes/no): ');
  
  if (answer.toLowerCase() !== 'yes' && answer.toLowerCase() !== 'y') {
    console.log('\nCancelled.');
    rl.close();
    return;
  }
  
  const commands = generateDeleteCommands(resources);
  
  console.log('\n📝 Delete Commands:\n');
  commands.forEach((cmd, index) => {
    console.log(`${index + 1}. ${cmd.description}`);
    if (cmd.warning) {
      console.log(`   ⚠️  ${cmd.warning}`);
    }
    if (cmd.prerequisite) {
      console.log(`   📋 ${cmd.prerequisite}`);
    }
    if (cmd.note) {
      console.log(`   💡 ${cmd.note}`);
    }
    // Handle multi-line commands (for OAC deletion)
    if (cmd.command.includes('\n')) {
      console.log(`   Commands:`);
      cmd.command.split('\n').forEach(line => {
        if (line.trim() && !line.trim().startsWith('#')) {
          console.log(`   ${line}`);
        } else if (line.trim().startsWith('#')) {
          console.log(`   ${line}`);
        }
      });
    } else {
      console.log(`   Command: ${cmd.command}`);
    }
    console.log('');
  });
  
  console.log('\n💡 Tip: Copy these commands and run them one by one, checking for errors.');
  console.log('   Or use Terraform to import and destroy if you have the old state file.\n');
  
  rl.close();
}

main().catch(error => {
  console.error('Error:', error);
  rl.close();
  process.exit(1);
});

