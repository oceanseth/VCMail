/**
 * VCMail Setup Wizard
 * Interactive setup for configuring VCMail email infrastructure
 */

const path = require('path');
const fs = require('fs-extra');
const AWS = require('aws-sdk');

// ES modules - loaded dynamically
let inquirer, chalk, ora, execa;

const { CONFIG_FILE, getConfigWithDefaults } = require('./config');
// Terraform directory in user's project (where they run npx vcmail)
const TERRAFORM_DIR = path.join(process.cwd(), '.vcmail-terraform');
// Package Terraform directory (source files)
const PACKAGE_TERRAFORM_DIR = path.join(__dirname, 'terraform');

// Load ES modules
async function loadESModules() {
  if (!inquirer || !chalk || !ora || !execa) {
    inquirer = (await import('inquirer')).default;
    chalk = (await import('chalk')).default;
    ora = (await import('ora')).default;
    const execaModule = await import('execa');
    execa = execaModule.default || execaModule;
  }
}

async function setup(args, options = {}) {
  const { skipPrompts = false } = options;
  
  // Load ES modules first
  await loadESModules();
  
  console.log(chalk.blue('📧 VCMail Setup Wizard\n'));
  
  if (skipPrompts) {
    console.log(chalk.yellow('⚠️  Skip prompts mode enabled - using defaults for all prompts\n'));
  }
  
  // Check if config already exists
  const configPath = path.join(process.cwd(), CONFIG_FILE);
  let existingConfig = null;
  let config = null;
  
  if (await fs.pathExists(configPath)) {
    try {
      existingConfig = await fs.readJson(configPath);
      let overwrite = false;
      
      if (!skipPrompts) {
        const result = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'overwrite',
            message: `Configuration file ${CONFIG_FILE} already exists. Update with new values?`,
            default: false
          }
        ]);
        overwrite = result.overwrite;
      } else {
        // In skip mode, use default (false) - keep existing config
        overwrite = false;
      }
      
      if (!overwrite) {
        // Use existing config, but check for missing values
        console.log(chalk.blue('Using existing configuration. Checking for missing values...\n'));
        config = await validateAndCompleteConfig(existingConfig, skipPrompts);
        
        // Save updated config if anything was added
        await fs.writeJson(configPath, config, { spaces: 2 });
        if (config !== existingConfig) {
          console.log(chalk.green(`✓ Configuration updated with missing values\n`));
        } else {
          console.log(chalk.green(`✓ Configuration is complete\n`));
        }
      } else {
        // User wants to update - gather full configuration
        const gatheredConfig = await gatherConfiguration(existingConfig, skipPrompts);
        config = getConfigWithDefaults(gatheredConfig);
        await fs.writeJson(configPath, config, { spaces: 2 });
        console.log(chalk.green(`\n✓ Configuration saved to ${CONFIG_FILE}\n`));
      }
    } catch (error) {
      console.log(chalk.yellow(`Warning: Could not read existing config: ${error.message}`));
      // Continue to create new config
      const exampleConfigPath = path.join(__dirname, '..', 'example.vcmail.config.json');
      if (await fs.pathExists(exampleConfigPath)) {
        const exampleConfig = await fs.readJson(exampleConfigPath);
        const gatheredConfig = await gatherConfiguration(exampleConfig, skipPrompts);
        config = getConfigWithDefaults(gatheredConfig);
      } else {
        const gatheredConfig = await gatherConfiguration(null, skipPrompts);
        config = getConfigWithDefaults(gatheredConfig);
      }
      await fs.writeJson(configPath, config, { spaces: 2 });
      console.log(chalk.green(`\n✓ Configuration saved to ${CONFIG_FILE}\n`));
    }
  } else {
    // Copy example config if it exists
    const exampleConfigPath = path.join(__dirname, '..', 'example.vcmail.config.json');
    if (await fs.pathExists(exampleConfigPath)) {
      const exampleConfig = await fs.readJson(exampleConfigPath);
      const gatheredConfig = await gatherConfiguration(exampleConfig, skipPrompts);
      config = getConfigWithDefaults(gatheredConfig);
    } else {
      const gatheredConfig = await gatherConfiguration(null, skipPrompts);
      config = getConfigWithDefaults(gatheredConfig);
    }
    
    // Save configuration
    await fs.writeJson(configPath, config, { spaces: 2 });
    console.log(chalk.green(`\n✓ Configuration saved to ${CONFIG_FILE}\n`));
  }
  
  // Continue with deployment if we have a valid config
  if (!config) {
    console.error(chalk.red('No configuration available. Please run setup again.'));
    return;
  }
  
  // Update .gitignore to exclude VCMail-generated directories
  await updateGitignore();
  
  // Prepare Lambda package before Terraform (Terraform needs it)
  await prepareLambdaPackage(config);
  
  // Initialize Terraform
  await initializeTerraform(config);
  
  // Run Terraform (this will deploy Lambda and all infrastructure)
  await runTerraform(config, skipPrompts);
  
  // Post-deployment setup (webmail client deployment)
  await postDeploymentSetup(config);
  
  console.log(chalk.green('\n🎉 VCMail setup complete!\n'));
  console.log(chalk.cyan(`Webmail URL: https://mail.${config.domain}`));
  console.log(chalk.cyan(`API Endpoint: ${config.apiEndpoint || 'Will be shown after deployment'}`));
  
  // Clean up any remaining Firebase connections
  try {
    const firebaseInitializer = require('../firebaseInit');
    // Clean up all Firebase apps from the cache
    if (firebaseInitializer.firebaseAppMap) {
      const apps = Array.from(firebaseInitializer.firebaseAppMap.values());
      for (const app of apps) {
        try {
          await app.delete();
        } catch (e) {
          // Ignore cleanup errors
        }
      }
      firebaseInitializer.firebaseAppMap.clear();
    }
  } catch (cleanupError) {
    // Ignore cleanup errors
  }
  
  // Exit the process to ensure it terminates cleanly
  // This is necessary because Firebase Admin SDK and other libraries may keep connections open
  process.exit(0);
}

// Validate and complete configuration - prompt only for missing values
async function validateAndCompleteConfig(existingConfig, skipPrompts = false) {
  const requiredFields = [
    { key: 'domain', message: 'Enter your domain name (e.g., example.com):' },
    { key: 'projectName', message: 'Enter a project name (used for AWS resource naming):', default: 'vcmail' },
    { key: 'awsRegion', message: 'Enter AWS region:', default: 'us-east-1' },
    { key: 'firebaseProjectId', message: 'Enter Firebase project ID:', required: true },
    { key: 'firebaseDatabaseURL', message: 'Enter Firebase Realtime Database URL:', 
      default: (answers) => `https://${answers.firebaseProjectId || existingConfig.firebaseProjectId}.firebaseio.com` },
    { key: 'firebaseApiKey', message: 'Enter Firebase Web API Key (found in Firebase Console > Project Settings > General > Your apps):',
      required: true,
      validate: (input) => {
        if (!input || input === 'your-api-key' || input === 'your-firebase-api-key') {
          return 'Firebase API Key is required (get it from Firebase Console)';
        }
        return true;
      }
    }
  ];
  
  const missingFields = [];
  const questions = [];
  
  // Check which fields are missing, empty, or placeholder values
  for (const field of requiredFields) {
    const value = existingConfig[field.key];
    const isPlaceholder = value && typeof value === 'string' && (
      value === 'your-api-key' || 
      value === 'your-firebase-api-key' ||
      value.startsWith('your-') ||
      value === 'example.com' ||
      value === 'your-firebase-project-id'
    );
    
    if (!value || (typeof value === 'string' && value.trim() === '') || isPlaceholder) {
      missingFields.push(field);
      
      const question = {
        type: 'input',
        name: field.key,
        message: field.message,
        default: typeof field.default === 'function' 
          ? field.default({ ...existingConfig })
          : (field.default || (isPlaceholder ? '' : existingConfig[field.key]) || ''),
        validate: field.required || field.validate ? (input) => {
          if (field.validate) {
            return field.validate(input);
          }
          if (field.required && !input) {
            return `${field.key} is required`;
          }
          return true;
        } : undefined
      };
      
      questions.push(question);
    }
  }
  
  // If no missing fields, return existing config
  if (questions.length === 0) {
    // Ensure emailDomain is set
    if (!existingConfig.emailDomain) {
      existingConfig.emailDomain = existingConfig.domain;
    }
    // Ensure other derived fields are set
    if (!existingConfig.ssmPrefix) {
      existingConfig.ssmPrefix = `/${existingConfig.projectName}/prod`;
    }
    if (!existingConfig.s3BucketName) {
      existingConfig.s3BucketName = `${existingConfig.projectName}-mail-inbox`;
    }
    if (!existingConfig.s3WebmailBucket) {
      existingConfig.s3WebmailBucket = existingConfig.mailDomain || `mail.${existingConfig.domain}`;
    }
    if (!existingConfig.storageCacheKey) {
      existingConfig.storageCacheKey = `${existingConfig.projectName}_email_cache`.replace(/[^a-zA-Z0-9_]/g, '_');
    }
    if (!existingConfig.mailDomain) {
      existingConfig.mailDomain = `mail.${existingConfig.domain}`;
    }
    
    return getConfigWithDefaults(existingConfig);
  }
  
  // Prompt for missing fields
  if (questions.length > 0) {
    if (skipPrompts) {
      // Auto-answer with defaults
      console.log(chalk.yellow(`Missing ${questions.length} required configuration value(s). Using defaults...\n`));
      const answers = {};
      for (const question of questions) {
        // question.default is already evaluated when creating the question object
        const defaultValue = question.default || existingConfig[question.name] || '';
        answers[question.name] = defaultValue;
        console.log(chalk.cyan(`  ${question.name}: ${defaultValue || '(empty)'}`));
      }
      // Merge with existing config
      const updatedConfig = {
        ...existingConfig,
        ...answers,
        emailDomain: answers.emailDomain || existingConfig.emailDomain || answers.domain || existingConfig.domain
      };
      return getConfigWithDefaults(updatedConfig);
    } else {
      console.log(chalk.yellow(`Missing ${questions.length} required configuration value(s). Please provide them:\n`));
      const answers = await inquirer.prompt(questions);
      // Merge with existing config
      const updatedConfig = {
        ...existingConfig,
        ...answers,
        emailDomain: answers.emailDomain || existingConfig.emailDomain || answers.domain || existingConfig.domain
      };
      return getConfigWithDefaults(updatedConfig);
    }
  }
  
  // If no missing fields, return existing config with defaults applied
  return getConfigWithDefaults(existingConfig);
}

async function gatherConfiguration(existingConfig, skipPrompts = false) {
  const questions = [
    {
      type: 'input',
      name: 'domain',
      message: 'Enter your domain name (e.g., example.com):',
      default: existingConfig?.domain,
      validate: (input) => {
        if (!input || !input.match(/^[a-z0-9.-]+\.[a-z]{2,}$/i)) {
          return 'Please enter a valid domain name';
        }
        return true;
      }
    },
    {
      type: 'input',
      name: 'projectName',
      message: 'Enter a project name (used for AWS resource naming):',
      default: existingConfig?.projectName || 'vcmail',
      validate: (input) => {
        if (!input || !input.match(/^[a-z0-9-]+$/i)) {
          return 'Project name must contain only letters, numbers, and hyphens';
        }
        return true;
      }
    },
    {
      type: 'input',
      name: 'awsRegion',
      message: 'Enter AWS region:',
      default: existingConfig?.awsRegion || 'us-east-1'
    },
    {
      type: 'input',
      name: 'mailDomain',
      message: 'Enter mail subdomain (default: mail.<your-domain>):',
      default: (answers) => `mail.${answers.domain}`,
      validate: (input) => {
        if (!input || !input.match(/^[a-z0-9.-]+$/i)) {
          return 'Please enter a valid subdomain';
        }
        return true;
      }
    },
    {
      type: 'input',
      name: 'firebaseProjectId',
      message: 'Enter Firebase project ID (or create new in Firebase console):',
      default: existingConfig?.firebaseProjectId,
      validate: (input) => {
        if (!input) {
          return 'Firebase project ID is required';
        }
        return true;
      }
    },
    {
      type: 'input',
      name: 'firebaseDatabaseURL',
      message: 'Enter Firebase Realtime Database URL:',
      default: (answers) => `https://${answers.firebaseProjectId}.firebaseio.com`,
      validate: (input) => {
        if (!input || !input.startsWith('https://')) {
          return 'Please enter a valid Firebase Database URL';
        }
        return true;
      }
    },
    {
      type: 'input',
      name: 'firebaseApiKey',
      message: 'Enter Firebase Web API Key (found in Firebase Console > Project Settings > General > Your apps):',
      default: existingConfig?.firebaseApiKey,
      validate: (input) => {
        if (!input || input === 'your-api-key') {
          return 'Firebase API Key is required (get it from Firebase Console)';
        }
        return true;
      }
    },
    {
      type: 'input',
      name: 'firebaseAppId',
      message: 'Enter Firebase App ID (optional, defaults to project-id):',
      default: (answers) => existingConfig?.firebaseAppId || answers.firebaseProjectId,
      required: false
    },
    {
      type: 'input',
      name: 'firebaseMessagingSenderId',
      message: 'Enter Firebase Messaging Sender ID (optional, for notifications):',
      default: existingConfig?.firebaseMessagingSenderId || '',
      required: false
    }
  ];
  
  let answers;
  if (skipPrompts) {
    // Auto-answer with defaults
    answers = {};
    for (const question of questions) {
      const defaultValue = typeof question.default === 'function' 
        ? question.default({ ...existingConfig, ...answers })
        : (question.default || existingConfig?.[question.name] || '');
      answers[question.name] = defaultValue;
      console.log(chalk.cyan(`  ${question.name}: ${defaultValue || '(empty)'}`));
    }
  } else {
    answers = await inquirer.prompt(questions);
  }
  
  // Get AWS account ID
  const { stdout } = await execa('aws', ['sts', 'get-caller-identity', '--output', 'json']);
  const awsIdentity = JSON.parse(stdout);
  
  // Set emailDomain to domain if not provided
  const emailDomain = answers.emailDomain || answers.domain;
  
  return {
    ...answers,
    emailDomain: emailDomain,
    awsAccountId: awsIdentity.Account,
    awsRegion: answers.awsRegion,
    ssmPrefix: `/${answers.projectName}/prod`,
    s3BucketName: `${answers.projectName}-mail-inbox`,
    s3WebmailBucket: answers.mailDomain || `mail.${answers.domain}`,
    storageCacheKey: `${answers.projectName}_email_cache`.replace(/[^a-zA-Z0-9_]/g, '_'),
    firebaseApiKey: answers.firebaseApiKey,
    firebaseAppId: answers.firebaseAppId || answers.firebaseProjectId,
    firebaseMessagingSenderId: answers.firebaseMessagingSenderId || '',
    timestamp: new Date().toISOString()
  };
}

async function initializeTerraform(config) {
  const spinner = ora('Initializing Terraform...').start();
  
  try {
    // Ensure Terraform directory exists
    await fs.ensureDir(TERRAFORM_DIR);
    
    // Copy template files
    await generateTerraformFiles(config);
    
    // Initialize Terraform
    await execa('terraform', ['init'], {
      cwd: TERRAFORM_DIR,
      stdio: 'pipe'
    });
    
    spinner.succeed('Terraform initialized');
    
    // Try to import existing Route53 records if they exist
    await importExistingRoute53Records(config);
    
    // Try to import existing SES resources if they exist
    await importExistingSESResources(config);
  } catch (error) {
    spinner.fail('Terraform initialization failed');
    throw error;
  }
}

/**
 * Attempts to import existing Route53 records into Terraform state
 * This prevents errors when records already exist from previous setups
 */
async function importExistingRoute53Records(config) {
  try {
    // Get the hosted zone ID
    let zoneId;
    try {
      const { stdout } = await execa('aws', [
        'route53', 'list-hosted-zones-by-name',
        '--dns-name', config.domain,
        '--query', 'HostedZones[?Name==`' + config.domain + '.`].Id',
        '--output', 'text'
      ], { cwd: TERRAFORM_DIR, stdio: 'pipe' });
      
      zoneId = stdout.trim();
      // Remove /hostedzone/ prefix if present
      zoneId = zoneId.replace(/^\/hostedzone\//, '');
      
      if (!zoneId || zoneId === 'None') {
        // Try alternative query format
        const { stdout: altStdout } = await execa('aws', [
          'route53', 'list-hosted-zones-by-name',
          '--dns-name', config.domain,
          '--output', 'json'
        ], { cwd: TERRAFORM_DIR, stdio: 'pipe' });
        
        const zones = JSON.parse(altStdout);
        const zone = zones.HostedZones?.find(z => z.Name === `${config.domain}.`);
        if (zone) {
          zoneId = zone.Id.replace(/^\/hostedzone\//, '');
        }
      }
      
      if (!zoneId || zoneId === 'None') {
        console.log(chalk.yellow(`⚠️  Could not find hosted zone for ${config.domain}, skipping Route53 imports`));
        return;
      }
    } catch (error) {
      console.log(chalk.yellow(`⚠️  Could not get hosted zone ID: ${error.message.split('\n')[0]}`));
      return;
    }
    
    // Records to potentially import
    const recordsToImport = [
      {
        resource: 'aws_route53_record.mx',
        name: config.domain,
        type: 'MX',
        description: 'MX record'
      },
      {
        resource: 'aws_route53_record.dmarc',
        name: `_dmarc.${config.domain}`,
        type: 'TXT',
        description: 'DMARC record'
      }
    ];
    
    // Try to import each record
    for (const record of recordsToImport) {
      try {
        // Check if record exists using AWS CLI
        const { stdout: listStdout } = await execa('aws', [
          'route53', 'list-resource-record-sets',
          '--hosted-zone-id', zoneId,
          '--query', `ResourceRecordSets[?Name=='${record.name}.' && Type=='${record.type}']`,
          '--output', 'json'
        ], { cwd: TERRAFORM_DIR, stdio: 'pipe' });
        
        const records = JSON.parse(listStdout);
        if (records && records.length > 0) {
          // Record exists, try to import it
          const importId = `${zoneId}_${record.name}_${record.type}`;
          
          console.log(chalk.cyan(`   Attempting to import existing ${record.description}...`));
          
          await execa('terraform', [
            'import',
            record.resource,
            importId
          ], {
            cwd: TERRAFORM_DIR,
            stdio: 'pipe'
          });
          
          console.log(chalk.green(`✓ Imported existing ${record.description}: ${record.name}`));
        }
      } catch (importError) {
        // Check if it's already imported or doesn't exist
        if (importError.message && importError.message.includes('already managed')) {
          console.log(chalk.green(`✓ ${record.description} already in Terraform state`));
        } else if (importError.message && importError.message.includes('does not exist')) {
          // Record doesn't exist, that's fine
        } else {
          // Other error - log but don't fail
          if (process.env.DEBUG) {
            console.log(chalk.yellow(`   Could not import ${record.description}: ${importError.message.split('\n')[0]}`));
          }
        }
      }
    }
  } catch (error) {
    // Non-critical - continue anyway
    if (process.env.DEBUG) {
      console.log(chalk.yellow(`Debug: Could not check for existing Route53 records: ${error.message}`));
    }
  }
}

async function importExistingSESResources(config) {
  try {
    // Check if SES rule set already exists
    const ruleSetName = `${config.projectName}-incoming-email`;
    try {
      const { stdout } = await execa('aws', [
        'ses', 'describe-active-receipt-rule-set',
        '--query', `RuleSetMetadata.Name == '${ruleSetName}'`,
        '--output', 'text'
      ], { cwd: TERRAFORM_DIR, stdio: 'pipe' });
      
      if (stdout.trim() === 'True') {
        console.log(chalk.yellow(`⚠️  SES rule set "${ruleSetName}" already exists and is active`));
        console.log(chalk.cyan(`   Attempting to import into Terraform state...`));
        
        try {
          // Try to import the rule set
          await execa('terraform', [
            'import',
            'aws_ses_receipt_rule_set.main',
            ruleSetName
          ], {
            cwd: TERRAFORM_DIR,
            stdio: 'pipe'
          });
          console.log(chalk.green(`✓ Imported existing SES rule set: ${ruleSetName}`));
          
          // Try to import the active rule set
          await execa('terraform', [
            'import',
            'aws_ses_active_receipt_rule_set.main',
            ruleSetName
          ], {
            cwd: TERRAFORM_DIR,
            stdio: 'pipe'
          });
          console.log(chalk.green(`✓ Imported active SES rule set: ${ruleSetName}`));
          
          // Try to import the receipt rule
          const ruleName = `${config.projectName}-email-rule`;
          await execa('terraform', [
            'import',
            'aws_ses_receipt_rule.main',
            `${ruleSetName}:${ruleName}`
          ], {
            cwd: TERRAFORM_DIR,
            stdio: 'pipe'
          });
          console.log(chalk.green(`✓ Imported SES receipt rule: ${ruleName}`));
        } catch (importError) {
          // Import failed - that's okay, Terraform will handle it
          console.log(chalk.yellow(`   Could not import (may already be in state or doesn't exist): ${importError.message.split('\n')[0]}`));
        }
      }
    } catch (error) {
      // AWS CLI check failed - that's okay, continue
    }
  } catch (error) {
    // Non-critical - continue anyway
    if (process.env.DEBUG) {
      console.log(chalk.yellow(`Debug: Could not check for existing SES resources: ${error.message}`));
    }
  }
}

async function generateTerraformFiles(config) {
  // Copy Terraform files from package to user's project directory
  const terraformFiles = ['main.tf', 'variables.tf', 'outputs.tf', 'provider.tf'];
  
  // Copy each Terraform file if it exists in the package
  for (const file of terraformFiles) {
    const sourceFile = path.join(PACKAGE_TERRAFORM_DIR, file);
    const destFile = path.join(TERRAFORM_DIR, file);
    
    if (await fs.pathExists(sourceFile)) {
      // Copy the real Terraform file from package
      await fs.copy(sourceFile, destFile);
      console.log(chalk.green(`✓ Copied ${file}`));
    } else {
      // Fallback: generate template if file doesn't exist in package
      console.log(chalk.yellow(`⚠ ${file} not found in package, generating template...`));
      if (file === 'main.tf') {
        await fs.writeFile(destFile, generateMainTf(config));
      } else if (file === 'variables.tf') {
        await fs.writeFile(destFile, generateVariablesTf());
      } else if (file === 'outputs.tf') {
        await fs.writeFile(destFile, generateOutputsTf());
      } else if (file === 'provider.tf') {
        await fs.writeFile(destFile, generateProviderTf(config));
      }
    }
  }
  
  // Always generate terraform.tfvars (this is user-specific)
  const tfvars = generateTfvars(config);
  await fs.writeFile(path.join(TERRAFORM_DIR, 'terraform.tfvars'), tfvars);
}

async function runTerraform(config, skipPrompts = false) {
  let spinner = ora('Running Terraform plan...').start();
  
  try {
    // Terraform plan
    await execa('terraform', ['plan', '-out=tfplan'], {
      cwd: TERRAFORM_DIR,
      stdio: 'pipe'
    });
    
    spinner.succeed('Terraform plan created');
    
    // Ask for confirmation
    let proceed = true; // Default to true
    
    if (!skipPrompts) {
      const result = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'proceed',
          message: 'Do you want to apply these changes?',
          default: true
        }
      ]);
      proceed = result.proceed;
    } else {
      console.log(chalk.cyan('  Proceeding with Terraform apply (skip prompts mode)...'));
    }
    
    if (!proceed) {
      console.log(chalk.yellow('Terraform apply cancelled.'));
      return;
    }
    
    // Terraform apply
    spinner = ora('Applying Terraform changes...').start();
    let stdout;
    let applySucceeded = false;
    try {
      ({ stdout } = await execa('terraform', ['apply', 'tfplan'], {
        cwd: TERRAFORM_DIR,
        stdio: 'pipe'
      }));
      spinner.succeed('Terraform changes applied');
      applySucceeded = true;
    } catch (error) {
      // Check if error is about Route53 records already existing
      const route53RecordError = error.message && (
        error.message.includes('Tried to create resource record set') ||
        error.message.includes('but it already exists')
      );
      
      if (route53RecordError) {
        spinner.fail('Terraform apply failed - Route53 records already exist');
        console.log(chalk.yellow('\n⚠️  Some Route53 records already exist and Terraform tried to create them again.'));
        console.log(chalk.cyan('\n   Attempting to import existing records and retry...'));
        
        try {
          // Try to import the records and retry
          await importExistingRoute53Records(config);
          
          // Re-run terraform plan
          console.log(chalk.cyan('   Re-running Terraform plan...'));
          await execa('terraform', ['plan', '-out=tfplan'], {
            cwd: TERRAFORM_DIR,
            stdio: 'pipe'
          });
          
          // Retry apply
          console.log(chalk.cyan('   Retrying Terraform apply...'));
          ({ stdout } = await execa('terraform', ['apply', 'tfplan'], {
            cwd: TERRAFORM_DIR,
            stdio: 'pipe'
          }));
          
          spinner.succeed('Terraform changes applied (after importing existing records)');
          applySucceeded = true;
        } catch (retryError) {
          spinner.fail('Terraform apply failed even after importing records');
          console.log(chalk.yellow('\n⚠️  Could not automatically fix Route53 record conflicts.'));
          console.log(chalk.cyan('\n   To fix this manually, you can:'));
          console.log(chalk.cyan(`   1. Get your hosted zone ID: aws route53 list-hosted-zones-by-name --dns-name ${config.domain}`));
          console.log(chalk.cyan(`   2. Import the MX record: cd ${TERRAFORM_DIR} && terraform import aws_route53_record.mx <ZONE_ID>_${config.domain}_MX`));
          console.log(chalk.cyan(`   3. Import the DMARC record: cd ${TERRAFORM_DIR} && terraform import aws_route53_record.dmarc <ZONE_ID>__dmarc.${config.domain}_TXT`));
          console.log(chalk.cyan(`   4. Then run npx vcmail again`));
          throw retryError;
        }
      } else if (error.message && error.message.includes('Cannot delete active rule set')) {
        spinner.fail('Terraform apply failed - cannot delete active SES rule set');
        console.log(chalk.yellow('\n⚠️  The SES rule set is currently active and cannot be deleted.'));
        console.log(chalk.yellow('   This usually means the rule set already exists and Terraform is trying to recreate it.'));
        console.log(chalk.cyan('\n   To fix this, you can:'));
        console.log(chalk.cyan(`   1. Import the existing rule set: cd ${TERRAFORM_DIR} && terraform import aws_ses_receipt_rule_set.main ${config.projectName}-incoming-email`));
        console.log(chalk.cyan(`   2. Or manually deactivate it first: aws ses set-active-receipt-rule-set --rule-set-name ""`));
        console.log(chalk.cyan(`   3. Then run npx vcmail again`));
        throw error;
      } else {
        throw error;
      }
    }
    
    // Parse outputs
    const outputs = await parseTerraformOutputs();
    
    // Note: spinner.succeed() is already called above if apply succeeded
    
    // Store outputs in config - use actual Terraform outputs
    config.apiEndpoint = outputs.api_gateway_endpoint?.value || outputs.api_endpoint?.value;
    config.webmailUrl = outputs.webmail_url?.value;
    config.hostedZoneId = outputs.hosted_zone_id?.value || outputs.route53_zone_id?.value;
    if (outputs.cloudfront_distribution_id?.value) {
      config.cloudfrontDistributionId = outputs.cloudfront_distribution_id.value;
    }
    if (outputs.cloudfront_domain_name?.value) {
      config.cloudfrontDomainName = outputs.cloudfront_domain_name.value;
    }
    
    // Update bucket names from Terraform outputs (these are the actual created buckets)
    if (outputs.mail_inbox_s3_bucket?.value) {
      config.s3BucketName = outputs.mail_inbox_s3_bucket.value;
    }
    if (outputs.webmail_s3_bucket?.value) {
      config.s3WebmailBucket = outputs.webmail_s3_bucket.value;
    }
    
    // Ensure emailDomain is set
    if (!config.emailDomain) {
      config.emailDomain = config.domain;
    }
    
    await fs.writeJson(path.join(process.cwd(), CONFIG_FILE), config, { spaces: 2 });
    
  } catch (error) {
    spinner.fail('Terraform operation failed');
    throw error;
  }
}

async function parseTerraformOutputs() {
  try {
    const { stdout } = await execa('terraform', ['output', '-json'], {
      cwd: TERRAFORM_DIR,
      stdio: 'pipe'
    });
    return JSON.parse(stdout);
  } catch (error) {
    return {};
  }
}

async function postDeploymentSetup(config) {
  const spinner = ora('Setting up Firebase configuration...').start();
  
  try {
    // Store Firebase config in SSM
    await storeFirebaseConfig(config);
    
    spinner.succeed('Firebase configuration stored in AWS SSM');
    
    // Deploy Firebase database rules
    await deployFirebaseRules(config);
    
    // Lambda is already deployed via Terraform, so we just deploy webmail client
    // Deploy webmail client (this must succeed - it uploads files to S3)
    await deployWebmailClient(config);
    
  } catch (error) {
    spinner.fail('Post-deployment setup failed');
    console.log(chalk.yellow('\n⚠️  Some steps may have failed. You can manually deploy:'));
    console.log(chalk.cyan(`  - Firebase rules: npm run deploy-rules`));
    console.log(chalk.cyan(`  - Webmail client: node -e "require('./lib/setup.js').deployWebmailClient(require('${CONFIG_FILE}'))"`));
    throw error;
  }
}

async function storeFirebaseConfig(config) {
  const ssm = new AWS.SSM({ region: config.awsRegion });
  const paramName = `${config.ssmPrefix}/firebase_service_account`;
  
  try {
    // Check if the parameter already exists
    await ssm.getParameter({ Name: paramName, WithDecryption: false }).promise();
    console.log(chalk.green(`✓ Firebase service account parameter already exists in SSM: ${paramName}`));
    return;
  } catch (error) {
    if (error.code === 'ParameterNotFound') {
      // Parameter doesn't exist, show warning
      console.log(chalk.yellow('\n⚠️  Please manually upload Firebase service account to SSM:'));
      console.log(chalk.cyan(`  Parameter: ${paramName}`));
      console.log(chalk.cyan(`  Use: aws ssm put-parameter --name "${paramName}" --type "SecureString" --value "$(cat firebase-service-account.json)"`));
    } else {
      // Other error (permissions, etc.) - show warning anyway but mention the error
      console.log(chalk.yellow(`\n⚠️  Could not verify Firebase service account parameter (${error.code}):`));
      console.log(chalk.cyan(`  Parameter: ${paramName}`));
      console.log(chalk.yellow(`  If the parameter exists, you can ignore this warning.`));
      console.log(chalk.cyan(`  To create it: aws ssm put-parameter --name "${paramName}" --type "SecureString" --value "$(cat firebase-service-account.json)"`));
    }
  }
}

async function deployFirebaseRules(config) {
  const spinner = ora('Deploying Firebase database rules...').start();
  let firebaseApp = null;
  
  try {
    // Import firebaseInitializer dynamically
    const firebaseInitializer = require('../firebaseInit');
    const path = require('path');
    
    // Get Firebase database URL from config
    const databaseURL = config.firebaseDatabaseURL || `https://${config.firebaseProjectId}.firebaseio.com`;
    
    // Initialize Firebase
    firebaseApp = await firebaseInitializer.get(databaseURL);
    const db = firebaseApp.database();
    
    // Read the database rules file (using fs-extra which is already imported)
    const rulesPath = path.join(__dirname, '..', 'database.rules.json');
    if (!await fs.pathExists(rulesPath)) {
      throw new Error(`Database rules file not found: ${rulesPath}`);
    }
    
    const rulesContent = await fs.readFile(rulesPath, 'utf8');
    const rules = JSON.parse(rulesContent);
    
    // Deploy the rules
    await db.setRules(JSON.stringify(rules));
    
    spinner.succeed('Firebase database rules deployed successfully');
    
  } catch (error) {
    spinner.fail('Failed to deploy Firebase database rules');
    console.log(chalk.yellow(`\n⚠️  Could not deploy Firebase database rules: ${error.message}`));
    console.log(chalk.yellow('   This might be because:'));
    console.log(chalk.yellow('   1. Firebase service account is not in SSM'));
    console.log(chalk.yellow('   2. Firebase database URL is incorrect'));
    console.log(chalk.yellow('   3. Network/permission issues'));
    console.log(chalk.cyan('\n   You can manually deploy rules later with: npm run deploy-rules'));
    // Don't throw - allow setup to continue even if rules deployment fails
    // User can deploy rules manually later
  } finally {
    // Clean up Firebase app to allow process to exit
    if (firebaseApp) {
      try {
        await firebaseApp.delete();
      } catch (deleteError) {
        // Ignore errors when deleting Firebase app
        console.log(chalk.yellow('Note: Could not clean up Firebase app (this is usually harmless)'));
      }
    }
  }
}

async function prepareLambdaPackage(config) {
  const spinner = ora('Preparing Lambda package...').start();
  
  try {
    // Run the Lambda package preparation script
    await execa('node', [path.join(__dirname, '..', 'scripts', 'prepare-lambda-package.js')], {
      cwd: process.cwd(),
      stdio: 'pipe'
    });
    
    spinner.succeed('Lambda package prepared');
    return true;
  } catch (error) {
    spinner.fail('Lambda package preparation failed');
    console.log(chalk.yellow('⚠️  Lambda package preparation failed'));
    if (error.message) {
      console.log(chalk.red(`  Error: ${error.message}`));
    }
    return false;
  }
}

async function deployWebmailClient(config) {
  const spinner = ora('Deploying webmail client...').start();
  
  try {
    // Ensure config is loaded from file if firebaseApiKey is missing
    if (!config.firebaseApiKey) {
      const configPath = path.join(process.cwd(), CONFIG_FILE);
      if (await fs.pathExists(configPath)) {
        const fileConfig = await fs.readJson(configPath);
        config.firebaseApiKey = fileConfig.firebaseApiKey || config.firebaseApiKey;
        config.firebaseAppId = fileConfig.firebaseAppId || config.firebaseAppId;
        config.firebaseMessagingSenderId = fileConfig.firebaseMessagingSenderId || config.firebaseMessagingSenderId;
        console.log(chalk.green(`✓ Loaded Firebase config from ${CONFIG_FILE}`));
      }
    }
    
    // Get actual bucket name from Terraform outputs if available
    let webmailBucket = config.s3WebmailBucket;
    try {
      const outputs = await parseTerraformOutputs();
      if (outputs.webmail_s3_bucket?.value) {
        webmailBucket = outputs.webmail_s3_bucket.value;
        config.s3WebmailBucket = webmailBucket; // Update config with actual bucket name
      }
    } catch (error) {
      console.log(chalk.yellow(`Warning: Could not get Terraform outputs, using config bucket name: ${webmailBucket}`));
    }
    
    if (!webmailBucket) {
      throw new Error('Webmail S3 bucket name not found in config or Terraform outputs');
    }
    
    // Upload to S3
    const s3 = new AWS.S3({ region: config.awsRegion });
    
    // Verify bucket exists
    try {
      await s3.headBucket({ Bucket: webmailBucket }).promise();
      console.log(chalk.green(`✓ Verified S3 bucket exists: ${webmailBucket}`));
    } catch (error) {
      if (error.code === 'NotFound' || error.statusCode === 404 || error.code === '403') {
        console.error(chalk.red(`\n✗ S3 bucket "${webmailBucket}" does not exist or is not accessible.`));
        console.error(chalk.yellow('\nPossible causes:'));
        console.error(chalk.yellow('  1. Terraform may not have created the bucket yet'));
        console.error(chalk.yellow('  2. The bucket name in config may not match Terraform output'));
        console.error(chalk.yellow('  3. AWS credentials may not have permission to access the bucket'));
        console.error(chalk.yellow('\nTroubleshooting:'));
        console.error(chalk.cyan(`  - Check Terraform outputs: cd ${TERRAFORM_DIR} && terraform output`));
        console.error(chalk.cyan(`  - Verify bucket exists: aws s3 ls | grep ${webmailBucket}`));
        console.error(chalk.cyan(`  - Check Terraform state: cd ${TERRAFORM_DIR} && terraform show`));
        throw new Error(`S3 bucket "${webmailBucket}" does not exist. Please ensure Terraform has created it successfully.`);
      }
      throw error;
    }
    
    // Generate build ID for deployment verification
    const buildId = `build-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    console.log(chalk.cyan(`📦 Build ID: ${buildId}`));
    
    // Upload index.html with injected config
    let indexHtml = await fs.readFile(path.join(__dirname, '..', 'index.html'), 'utf-8');
    
    // Validate Firebase API key before deploying
    if (!config.firebaseApiKey || config.firebaseApiKey === 'your-api-key' || config.firebaseApiKey === 'your-firebase-api-key') {
      console.log(chalk.yellow(`⚠️  Warning: Firebase API key is missing or placeholder. Webmail authentication may not work.`));
      console.log(chalk.cyan(`   Please add firebaseApiKey to ${CONFIG_FILE} and redeploy.`));
    } else {
      console.log(chalk.green(`✓ Using Firebase API key: ${config.firebaseApiKey.substring(0, 10)}...`));
    }
    
    // Prepare Firebase config object (same for HTML and firebaseConfig.js)
    const firebaseConfigObj = {
      apiKey: config.firebaseApiKey || process.env.FIREBASE_API_KEY || '',
      authDomain: `${config.firebaseProjectId}.firebaseapp.com`,
      databaseURL: config.firebaseDatabaseURL,
      projectId: config.firebaseProjectId,
      storageBucket: `${config.firebaseProjectId}.appspot.com`,
      messagingSenderId: config.firebaseMessagingSenderId || '',
      appId: config.firebaseAppId || config.firebaseProjectId
    };
    
    // Log Firebase config for debugging (without exposing full API key)
    console.log(chalk.cyan(`✓ Firebase config:`));
    console.log(chalk.cyan(`   Project ID: ${firebaseConfigObj.projectId}`));
    console.log(chalk.cyan(`   API Key: ${firebaseConfigObj.apiKey ? firebaseConfigObj.apiKey.substring(0, 10) + '...' : 'MISSING'}`));
    console.log(chalk.cyan(`   Auth Domain: ${firebaseConfigObj.authDomain}`));
    
    // Inject VCMail configuration into HTML
    // When using CloudFront, apiEndpoint should be empty to use relative URLs
    // CloudFront will route /api/* to API Gateway
    const vcmailConfigObj = {
      domain: config.domain,
      emailDomain: config.emailDomain || config.domain,
      mailDomain: config.mailDomain,
      apiEndpoint: '', // Empty string = use relative URLs (CloudFront handles routing)
      storageCacheKey: config.storageCacheKey || 'vcmail_email_cache',
      buildId: buildId,
      firebase: firebaseConfigObj
    };
    
    const vcmailConfigScript = `
    <script>
      window.VCMAIL_CONFIG = ${JSON.stringify(vcmailConfigObj, null, 2)};
    </script>
    `;
    
    // Replace or add config script before closing head tag
    // Use a more robust regex that matches the entire script block, including multi-line config objects
    // Try multiple regex patterns to handle different formats
    let replaced = false;
    const originalHtmlLength = indexHtml.length;
    
    // Pattern 1: Match script tag with comments and VCMAIL_CONFIG (most specific)
    // This pattern matches from <script> to </script> including all whitespace and newlines
    // Match any comment containing "VCMail configuration" or "vcmail.config.json"
    const configScriptRegex1 = /<script>[\s\S]*?\/\/.*?VCMail.*?configuration[\s\S]*?window\.VCMAIL_CONFIG[\s\S]*?<\/script>/i;
    if (configScriptRegex1.test(indexHtml)) {
      const beforeReplace = indexHtml.length;
      indexHtml = indexHtml.replace(configScriptRegex1, vcmailConfigScript.trim());
      if (indexHtml.length !== beforeReplace) {
        replaced = true;
        console.log(chalk.green(`✓ Replaced existing VCMAIL_CONFIG in index.html (method 1, saved ${beforeReplace - indexHtml.length} bytes)`));
      }
    }
    
    // Pattern 2: Match any script tag containing window.VCMAIL_CONFIG (more general fallback)
    if (!replaced) {
      const configScriptRegex2 = /<script>[\s\S]*?window\.VCMAIL_CONFIG[\s\S]*?<\/script>/i;
      if (configScriptRegex2.test(indexHtml)) {
        const beforeReplace = indexHtml.length;
        indexHtml = indexHtml.replace(configScriptRegex2, vcmailConfigScript.trim());
        if (indexHtml.length !== beforeReplace) {
          replaced = true;
          console.log(chalk.green(`✓ Replaced existing VCMAIL_CONFIG in index.html (method 2, saved ${beforeReplace - indexHtml.length} bytes)`));
        }
      }
    }
    
    // Pattern 3: Direct replacement - find the script tag containing window.VCMAIL_CONFIG and replace entire script tag
    if (!replaced) {
      const vcmailConfigIndex = indexHtml.indexOf('window.VCMAIL_CONFIG');
      if (vcmailConfigIndex > -1) {
        // Find the start of the script tag (go backwards from window.VCMAIL_CONFIG)
        const scriptStartIndex = indexHtml.lastIndexOf('<script>', vcmailConfigIndex);
        // Find the end of the script tag (go forwards from window.VCMAIL_CONFIG)
        const scriptEndIndex = indexHtml.indexOf('</script>', vcmailConfigIndex);
        
        if (scriptStartIndex >= 0 && scriptEndIndex >= 0 && scriptEndIndex > scriptStartIndex) {
          // Replace the entire script tag
          indexHtml = indexHtml.substring(0, scriptStartIndex) + 
                     vcmailConfigScript.trim() + 
                     indexHtml.substring(scriptEndIndex + '</script>'.length);
          replaced = true;
          console.log(chalk.green('✓ Replaced VCMAIL_CONFIG in index.html (direct replacement method)'));
        }
      }
    }
    
    // If no replacement happened, insert before closing head tag
    if (!replaced) {
      // Try to find </head> tag
      if (indexHtml.includes('</head>')) {
        indexHtml = indexHtml.replace('</head>', `  ${vcmailConfigScript.trim()}\n</head>`);
        replaced = true;
        console.log(chalk.green('✓ Inserted VCMAIL_CONFIG into index.html'));
      } else {
        // Fallback: insert at the end of <head> section
        indexHtml = indexHtml.replace('</head>', `${vcmailConfigScript.trim()}\n</head>`);
        console.log(chalk.yellow('⚠️  Inserted VCMAIL_CONFIG at end of head (fallback)'));
      }
    }
    
    // Debug: Check if HTML actually changed and verify injection
    if (!replaced || (indexHtml.length === originalHtmlLength && replaced)) {
      console.log(chalk.yellow('⚠️  Warning: HTML might not have been updated correctly.'));
      // Show a snippet of what we're trying to match
      const matchIndex = indexHtml.indexOf('window.VCMAIL_CONFIG');
      if (matchIndex > -1) {
        const snippet = indexHtml.substring(Math.max(0, matchIndex - 50), Math.min(indexHtml.length, matchIndex + 300));
        console.log(chalk.gray(`   Snippet around VCMAIL_CONFIG:\n${snippet}`));
      }
    }
    
    // Verify the replacement worked
    if (!indexHtml.includes(config.firebaseApiKey || '') && config.firebaseApiKey && config.firebaseApiKey !== 'your-api-key') {
      console.log(chalk.yellow('⚠️  Warning: Firebase API key might not have been injected. Please check the deployed HTML.'));
    } else if (config.firebaseApiKey && config.firebaseApiKey !== 'your-api-key') {
      console.log(chalk.green('✓ Verified Firebase API key is in the HTML'));
    }
    
    await s3.putObject({
      Bucket: webmailBucket,
      Key: 'index.html',
      Body: indexHtml,
      ContentType: 'text/html',
      CacheControl: 'no-cache, no-store, must-revalidate' // Prevent caching of HTML
    }).promise();
    
    console.log(chalk.green(`✓ Uploaded index.html to S3 (${(indexHtml.length / 1024).toFixed(2)} KB)`));
    
    // Verify the replacement worked by checking for actual values
    const buildIdFound = indexHtml.includes(buildId);
    const apiKeyFound = config.firebaseApiKey && config.firebaseApiKey !== 'your-api-key' && indexHtml.includes(config.firebaseApiKey);
    const placeholderFound = indexHtml.includes('your-api-key');
    
    console.log(chalk.cyan(`   Build ID in HTML: ${buildIdFound ? buildId : 'NOT FOUND'}`));
    console.log(chalk.cyan(`   Firebase API Key in HTML: ${apiKeyFound ? 'PRESENT' : (placeholderFound ? 'PLACEHOLDER STILL PRESENT' : 'MISSING')}`));
    
    if (placeholderFound && !apiKeyFound) {
      console.log(chalk.red('❌ ERROR: Placeholder API key still in HTML! Replacement failed.'));
      console.log(chalk.yellow('   This indicates the HTML replacement did not work correctly.'));
      console.log(chalk.cyan('   Please check the deployment logs above for replacement method used.'));
    }
    
    // Update firebaseConfig.js
    const firebaseConfigPath = path.join(__dirname, '..', 'src', 'firebaseConfig.js');
    if (await fs.pathExists(firebaseConfigPath)) {
      let firebaseConfig = await fs.readFile(firebaseConfigPath, 'utf-8');
      
      // Use the same Firebase config object created earlier
      // Update Firebase config
      firebaseConfig = firebaseConfig.replace(
        /export const firebaseConfig = window\.VCMAIL_CONFIG\?\.firebase \|\| \{[\s\S]*?\};/,
        `export const firebaseConfig = window.VCMAIL_CONFIG?.firebase || ${JSON.stringify(firebaseConfigObj, null, 2)};`
      );
      
      // Update vcmail config with build ID
      // When using CloudFront, apiEndpoint should be empty to use relative URLs
      const vcmailConfigObj = {
        domain: config.domain,
        emailDomain: config.emailDomain || config.domain,
        mailDomain: config.mailDomain,
        apiEndpoint: '', // Empty string = use relative URLs (CloudFront handles routing)
        storageCacheKey: config.storageCacheKey || 'vcmail_email_cache',
        buildId: buildId
      };
      
      firebaseConfig = firebaseConfig.replace(
        /export const vcmailConfig = window\.VCMAIL_CONFIG \|\| \{[\s\S]*?\};/,
        `export const vcmailConfig = window.VCMAIL_CONFIG || ${JSON.stringify(vcmailConfigObj, null, 2)};`
      );
      
      await s3.putObject({
        Bucket: webmailBucket,
        Key: 'src/firebaseConfig.js',
        Body: firebaseConfig,
        ContentType: 'application/javascript'
      }).promise();
    }
    
    // Upload other src files
    const srcDir = path.join(__dirname, '..', 'src');
    if (await fs.pathExists(srcDir)) {
      const files = await fs.readdir(srcDir);
      for (const file of files) {
        if (file === 'firebaseConfig.js') continue; // Already uploaded above
        const filePath = path.join(srcDir, file);
        const content = await fs.readFile(filePath);
        await s3.putObject({
          Bucket: webmailBucket,
          Key: `src/${file}`,
          Body: content,
          ContentType: file.endsWith('.js') ? 'application/javascript' : 'text/plain'
        }).promise();
      }
    }
    
    // Invalidate CloudFront cache so changes are visible immediately
    await invalidateCloudFrontCache(config);
    
    spinner.succeed('Webmail client deployed');
  } catch (error) {
    spinner.fail('Webmail client deployment failed');
    throw error;
  }
}

async function invalidateCloudFrontCache(config) {
  if (!config.cloudfrontDistributionId) {
    console.log(chalk.yellow('⚠️  CloudFront distribution ID not available. Skipping cache invalidation.'));
    console.log(chalk.cyan('   Terraform outputs should include cloudfront_distribution_id. Re-run Terraform if missing.'));
    return;
  }
  
  const cloudfront = new AWS.CloudFront();
  const callerReference = `vcmail-${Date.now()}`;
  const distributionId = config.cloudfrontDistributionId;
  
  const spinner = ora(`Invalidating CloudFront cache (${distributionId})...`).start();
  try {
    await cloudfront.createInvalidation({
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: callerReference,
        Paths: {
          Quantity: 1,
          Items: ['/*']
        }
      }
    }).promise();
    spinner.succeed(`CloudFront cache invalidated (${distributionId})`);
  } catch (error) {
    spinner.fail('CloudFront cache invalidation failed');
    console.log(chalk.yellow(`   You may need to manually invalidate distribution ${distributionId}`));
    console.log(chalk.cyan(`   Command: aws cloudfront create-invalidation --distribution-id ${distributionId} --paths "/*"`));
  }
}

// Template generation functions (simplified - full implementation needed)
function generateMainTf(config) {
  return `# VCMail Infrastructure
# Generated automatically by VCMail setup

terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "domain" {
  description = "Domain name"
  type        = string
}

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
}

variable "mail_domain" {
  description = "Mail subdomain"
  type        = string
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "firebase_project_id" {
  description = "Firebase project ID"
  type        = string
}

# Resources will be added by Terraform modules
`;
}

function generateVariablesTf() {
  return `# Terraform variables
# Variables are defined here
`;
}

function generateOutputsTf() {
  return `# Terraform outputs
output "api_endpoint" {
  description = "API Gateway endpoint"
  value       = "Will be set after deployment"
}

output "webmail_url" {
  description = "Webmail URL"
  value       = "https://mail.\${var.domain}"
}

output "hosted_zone_id" {
  description = "Route53 hosted zone ID"
  value       = "Will be set after deployment"
}
`;
}

function generateTfvars(config) {
  return `domain                  = "${config.domain}"
project_name            = "${config.projectName}"
mail_domain             = "${config.mailDomain}"
aws_region              = "${config.awsRegion}"
firebase_project_id     = "${config.firebaseProjectId}"
firebase_database_url   = "${config.firebaseDatabaseURL}"
ssm_prefix              = "${config.ssmPrefix || `/${config.projectName}/prod`}"
s3_bucket_name          = "${config.s3BucketName}"
s3_webmail_bucket_name  = "${config.s3WebmailBucket}"
email_domain            = "${config.emailDomain || config.domain}"
`;
}

function generateProviderTf(config) {
  return `provider "aws" {
  region = var.aws_region
}
`;
}

async function generateServerlessConfig(config) {
  const template = await fs.readFile(
    path.join(__dirname, '..', 'templates', 'serverless.yml.template'),
    'utf-8'
  );
  
  const ssmPrefix = config.ssmPrefix || `/${config.projectName}/prod`;
  
  // First, replace SSM variable references BEFORE replacing SSM_PREFIX
  // Pattern: ${ssm:${SSM_PREFIX}/param} becomes ${ssm:/path/param}
  // Note: In newer Serverless Framework versions, ~true suffix is not needed for SecureString
  let serverlessYml = template.replace(
    /\$\{ssm:\$\{SSM_PREFIX\}\/([^}~]+)(~true)?\}/g, 
    `\${ssm:${ssmPrefix}/$1}`
  );
  
  // Now replace all other variables
  serverlessYml = serverlessYml
    .replace(/\$\{PROJECT_NAME\}/g, config.projectName)
    .replace(/\$\{DOMAIN\}/g, config.domain)
    .replace(/\$\{SSM_PREFIX\}/g, ssmPrefix)
    .replace(/\$\{S3_BUCKET\}/g, config.s3BucketName)
    .replace(/\$\{S3_WEBMAIL_BUCKET\}/g, config.s3WebmailBucket)
    .replace(/\$\{AWS_REGION\}/g, config.awsRegion)
    .replace(/\$\{AWS_ACCOUNT_ID\}/g, config.awsAccountId);
  
  const serverlessPath = path.join(process.cwd(), 'vcmail-serverless.yml');
  await fs.writeFile(serverlessPath, serverlessYml);
  return serverlessPath;
}

/**
 * Updates .gitignore file to exclude VCMail-generated directories
 * Adds .vcmail-terraform and vcmail-lambda-package if they don't already exist
 */
async function updateGitignore() {
  const gitignorePath = path.join(process.cwd(), '.gitignore');
  const entriesToAdd = [
    '.vcmail-terraform',
    'vcmail-lambda-package'
  ];
  
  let gitignoreContent = '';
  let needsUpdate = false;
  
  // Read existing .gitignore if it exists
  if (await fs.pathExists(gitignorePath)) {
    gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
  }
  
  // Check which entries are missing
  const missingEntries = [];
  for (const entry of entriesToAdd) {
    // Check if entry exists (as exact line or with trailing slash)
    const entryRegex = new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`, 'm');
    if (!entryRegex.test(gitignoreContent)) {
      missingEntries.push(entry);
      needsUpdate = true;
    }
  }
  
  // If no updates needed, return early
  if (!needsUpdate) {
    return;
  }
  
  // Add VCMail section if it doesn't exist
  const vcmailSectionHeader = '# VCMail generated files';
  const hasVcmailSection = gitignoreContent.includes(vcmailSectionHeader);
  
  if (!hasVcmailSection) {
    // Add VCMail section at the end
    if (gitignoreContent && !gitignoreContent.endsWith('\n')) {
      gitignoreContent += '\n';
    }
    gitignoreContent += `\n${vcmailSectionHeader}\n`;
  }
  
  // Add missing entries
  for (const entry of missingEntries) {
    if (hasVcmailSection) {
      // Insert after the section header
      const sectionIndex = gitignoreContent.indexOf(vcmailSectionHeader);
      const afterHeader = gitignoreContent.indexOf('\n', sectionIndex) + 1;
      gitignoreContent = gitignoreContent.slice(0, afterHeader) + 
                        `${entry}\n` + 
                        gitignoreContent.slice(afterHeader);
    } else {
      // Append to the VCMail section we just added
      gitignoreContent += `${entry}\n`;
    }
  }
  
  // Write updated .gitignore
  await fs.writeFile(gitignorePath, gitignoreContent, 'utf-8');
  
  if (missingEntries.length > 0) {
    console.log(chalk.green(`✓ Updated .gitignore to exclude VCMail directories`));
    for (const entry of missingEntries) {
      console.log(chalk.cyan(`  Added: ${entry}`));
    }
  }
}

module.exports = { setup, deployWebmailClient, deployFirebaseRules };

