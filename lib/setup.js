/**
 * VCMail Setup Wizard
 * Interactive setup for configuring VCMail email infrastructure
 */

const path = require('path');
const fs = require('fs-extra');
const AWS = require('aws-sdk');

// ES modules - loaded dynamically
let inquirer, chalk, ora, execa;

const { 
  CONFIG_FILE, 
  getConfigWithDefaults, 
  sanitizeDomainForAWS,
  deriveProjectName,
  deriveSSMPrefix,
  deriveS3BucketName
} = require('./config');
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
        const { config: updatedConfig, hasChanges } = await validateAndCompleteConfig(existingConfig, skipPrompts);
        config = updatedConfig;
        
        // Save updated config if anything was added
        await fs.writeJson(configPath, config, { spaces: 2 });
        if (hasChanges) {
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
  
  // Setup Firebase Authentication providers
  await setupFirebaseAuthProviders(config);
  
  console.log(chalk.green('\n🎉 VCMail setup complete!\n'));
  console.log(chalk.cyan(`Webmail URL: https://mail.${config.domain}`));
  console.log(chalk.cyan(`API Endpoint: ${config.apiEndpoint || 'Will be shown after deployment'}`));
  
  // Run verification to check for common issues
  console.log(chalk.blue('\n🔍 Running post-deployment verification...\n'));
  try {
    const { verifySESSetup } = require('../scripts/verify-ses-setup');
    await verifySESSetup();
  } catch (error) {
    console.log(chalk.yellow(`\n⚠️  Verification had issues: ${error.message}`));
    console.log(chalk.cyan('   You can run "npx vcmail verify" later to check again.'));
  }
  
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
  
  // Track if we need to add derived fields
  let hasDerivedFieldChanges = false;
  
  // If no missing fields, check for derived fields that need to be added
  if (questions.length === 0) {
    // Support legacy mailDomain for backward compatibility
    const webmailDomain = existingConfig.webmailDomain || existingConfig.mailDomain || `mail.${existingConfig.domain}`;
    if (!existingConfig.webmailDomain && !existingConfig.mailDomain) {
      existingConfig.webmailDomain = webmailDomain;
      hasDerivedFieldChanges = true;
    }
    
    // Ensure activeRuleSetName is preserved if sharedRuleSetName exists
    // This helps track which rule set we're actually using
    if (existingConfig.sharedRuleSetName && !existingConfig.activeRuleSetName) {
      existingConfig.activeRuleSetName = existingConfig.sharedRuleSetName;
      hasDerivedFieldChanges = true;
    }
    
    // Remove derived fields from config if they exist (they're computed from domain now)
    const fieldsToRemove = ['ssmPrefix', 's3BucketName', 's3WebmailBucket', 'projectName'];
    for (const field of fieldsToRemove) {
      if (existingConfig.hasOwnProperty(field)) {
        delete existingConfig[field];
        hasDerivedFieldChanges = true;
      }
    }
    
    return {
      config: getConfigWithDefaults(existingConfig),
      hasChanges: hasDerivedFieldChanges
    };
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
      // Support legacy mailDomain for backward compatibility
      const webmailDomain = answers.webmailDomain || answers.mailDomain || existingConfig.webmailDomain || existingConfig.mailDomain || `mail.${answers.domain || existingConfig.domain}`;
      const updatedConfig = {
        ...existingConfig,
        ...answers,
        webmailDomain: webmailDomain
      };
      return {
        config: getConfigWithDefaults(updatedConfig),
        hasChanges: true // We added missing values
      };
    } else {
      console.log(chalk.yellow(`Missing ${questions.length} required configuration value(s). Please provide them:\n`));
      const answers = await inquirer.prompt(questions);
      // Merge with existing config
      // Support legacy mailDomain for backward compatibility
      const webmailDomain = answers.webmailDomain || answers.mailDomain || existingConfig.webmailDomain || existingConfig.mailDomain || `mail.${answers.domain || existingConfig.domain}`;
      const updatedConfig = {
        ...existingConfig,
        ...answers,
        webmailDomain: webmailDomain
      };
      return {
        config: getConfigWithDefaults(updatedConfig),
        hasChanges: true // We added missing values
      };
    }
  }
  
  // If no missing fields, return existing config with defaults applied
  return {
    config: getConfigWithDefaults(existingConfig),
    hasChanges: false
  };
}

async function gatherConfiguration(existingConfig, skipPrompts = false) {
  // Try to auto-discover Firebase config from service account if available
  // Note: We need domain first to compute SSM prefix, so we'll try discovery after domain is provided
  let discoveredFirebaseConfig = {};
  
  // First, prompt for domain (needed for SSM prefix)
  const domainQuestion = [
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
    }
  ];
  
  const domainAnswer = skipPrompts 
    ? { domain: existingConfig?.domain || '' }
    : await inquirer.prompt(domainQuestion);
  
  // Now try to discover Firebase config if we have domain (to compute SSM prefix)
  if (domainAnswer.domain || existingConfig?.domain) {
    try {
      const tempConfig = getConfigWithDefaults({
        ...existingConfig,
        domain: domainAnswer.domain || existingConfig?.domain
      });
      if (tempConfig.ssmPrefix) {
        const { discoverFirebaseConfig } = require('../scripts/discover-firebase-config');
        discoveredFirebaseConfig = await discoverFirebaseConfig(tempConfig);
        console.log(chalk.green('\n✓ Auto-discovered Firebase configuration from service account\n'));
      }
    } catch (error) {
      // Service account not available or discovery failed - that's okay, we'll prompt
      if (process.env.DEBUG) {
        console.log(chalk.yellow(`Debug: Could not auto-discover Firebase config: ${error.message}`));
      }
    }
  }
  
  // Merge discovered config with existing config (existing takes precedence)
  const configWithDefaults = {
    ...discoveredFirebaseConfig,
    ...existingConfig,
    ...domainAnswer
  };
  
  const questions = [
    // Domain already collected above, but include it here for skipPrompts mode
    {
      type: 'input',
      name: 'domain',
      message: 'Enter your domain name (e.g., example.com):',
      default: configWithDefaults.domain || existingConfig?.domain,
      validate: (input) => {
        if (!input || !input.match(/^[a-z0-9.-]+\.[a-z]{2,}$/i)) {
          return 'Please enter a valid domain name';
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
      name: 'webmailDomain',
      message: 'Enter webmail subdomain (default: mail.<your-domain>):',
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
      message: 'Enter Firebase project ID:',
      default: configWithDefaults.firebaseProjectId || existingConfig?.firebaseProjectId,
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
      default: (answers) => configWithDefaults.firebaseDatabaseURL || existingConfig?.firebaseDatabaseURL || `https://${answers.firebaseProjectId}.firebaseio.com`,
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
      default: configWithDefaults.firebaseApiKey || existingConfig?.firebaseApiKey,
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
      default: (answers) => configWithDefaults.firebaseAppId || existingConfig?.firebaseAppId || answers.firebaseProjectId,
      required: false
    },
    {
      type: 'input',
      name: 'firebaseMessagingSenderId',
      message: 'Enter Firebase Messaging Sender ID (optional, for notifications):',
      default: configWithDefaults.firebaseMessagingSenderId || existingConfig?.firebaseMessagingSenderId || '',
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
  
  // Support legacy mailDomain for backward compatibility
  const webmailDomain = answers.webmailDomain || answers.mailDomain || `mail.${answers.domain}`;
  
  // Derived values are computed from domain (not saved to config file)
  const projectName = deriveProjectName(answers.domain);
  
  return {
    ...answers,
    webmailDomain: webmailDomain,
    awsAccountId: awsIdentity.Account,
    awsRegion: answers.awsRegion,
    // Note: ssmPrefix, s3BucketName, s3WebmailBucket, projectName are derived from domain
    // and not saved to config file - they're computed in getConfigWithDefaults()
    firebaseApiKey: answers.firebaseApiKey,
    firebaseAppId: answers.firebaseAppId || answers.firebaseProjectId,
    firebaseMessagingSenderId: answers.firebaseMessagingSenderId || '',
    timestamp: new Date().toISOString()
  };
}

/**
 * Detects existing active SES rule set that can be shared
 * Returns detailed information about the active rule set if found
 * @param {Object} config - Configuration object to check rule name against
 * @returns {Object} { ruleSetName: string|null, ruleExists: boolean, ruleExistsForDomain: boolean, existingRules: Array }
 */
async function detectExistingRuleSet(config) {
  try {
    const { stdout } = await execa('aws', [
      'ses', 'describe-active-receipt-rule-set',
      '--output', 'json'
    ], { stdio: 'pipe' });
    
    const result = JSON.parse(stdout);
    
    // Check if there's an active rule set
    if (!result.Metadata || !result.Metadata.Name) {
      return { ruleSetName: null, ruleExists: false, ruleExistsForDomain: false, existingRules: [] };
    }
    
    const activeRuleSetName = result.Metadata.Name;
    const computedConfig = getConfigWithDefaults(config);
    const ourRuleName = `${computedConfig.projectName}-email-rule`;
    const existingRules = result.Rules || [];
    
    // Check if our rule already exists by name
    const ruleExists = existingRules.some(rule => rule.Name === ourRuleName);
    
    // Check if ANY rule exists for our domain (by checking recipients)
    const ruleExistsForDomain = existingRules.some(rule => {
      const recipients = rule.Recipients || [];
      return recipients.includes(computedConfig.domain);
    });
    
    // Check if it's a VCMail-managed rule set (ends with -incoming-email)
    if (activeRuleSetName && activeRuleSetName !== 'None' && activeRuleSetName.endsWith('-incoming-email')) {
      return { 
        ruleSetName: activeRuleSetName, 
        ruleExists: ruleExists,
        ruleExistsForDomain: ruleExistsForDomain,
        existingRules: existingRules
      };
    }
    
    // Even if not VCMail-managed, if there's a rule for our domain, we should know about it
    if (ruleExistsForDomain) {
      return {
        ruleSetName: activeRuleSetName,
        ruleExists: ruleExists,
        ruleExistsForDomain: ruleExistsForDomain,
        existingRules: existingRules
      };
    }
    
    return { ruleSetName: null, ruleExists: false, ruleExistsForDomain: false, existingRules: [] };
  } catch (error) {
    // No active rule set or error - that's okay
    if (error.message && error.message.includes('RuleSetDoesNotExist')) {
      return { ruleSetName: null, ruleExists: false, ruleExistsForDomain: false, existingRules: [] };
    }
    // Other errors - log but return null
    if (process.env.DEBUG) {
      console.log(`Debug: Error detecting rule set: ${error.message}`);
    }
    return { ruleSetName: null, ruleExists: false, ruleExistsForDomain: false, existingRules: [] };
  }
}

async function initializeTerraform(config) {
  const spinner = ora('Initializing Terraform...').start();
  
  try {
    // Ensure Terraform directory exists
    await fs.ensureDir(TERRAFORM_DIR);
    
    // Detect existing active rule set BEFORE generating Terraform files
    // This allows us to set shared_rule_set_name in the config
    const detectionResult = await detectExistingRuleSet(config);
    
    if (detectionResult.ruleSetName) {
      const computedConfig = getConfigWithDefaults(config);
      const projectRuleSetName = `${computedConfig.projectName}-incoming-email`;
      
      // ALWAYS use the active rule set if it exists (regardless of project name)
      // This ensures we don't create duplicate rule sets
      if (detectionResult.ruleSetName === projectRuleSetName) {
        // Same project - will import normally
        console.log(chalk.cyan(`ℹ️  Found existing rule set for this project: ${detectionResult.ruleSetName}`));
        // Still save it to config for clarity
        config.activeRuleSetName = detectionResult.ruleSetName;
      } else {
        // Different VCMail project - will reuse existing active rule set
        console.log(chalk.green(`✓ Found active VCMail rule set: ${detectionResult.ruleSetName}`));
        console.log(chalk.cyan(`   This project will add its rule to the active rule set`));
        
        // Show existing rules for visibility
        if (detectionResult.existingRules && detectionResult.existingRules.length > 0) {
          const existingDomains = detectionResult.existingRules
            .map(r => {
              const recipients = r.Recipients || [];
              return recipients.length > 0 ? recipients[0] : 'unknown';
            })
            .filter(d => d !== 'unknown')
            .join(', ');
          if (existingDomains) {
            console.log(chalk.cyan(`   Existing domains in this rule set: ${existingDomains}`));
            console.log(chalk.green(`   ✓ Your rule for ${computedConfig.domain} will be added alongside these domains`));
          }
        }
        
        config.sharedRuleSetName = detectionResult.ruleSetName;
        config.activeRuleSetName = detectionResult.ruleSetName;
      }
      
      // Check if our rule already exists
      if (detectionResult.ruleExists) {
        console.log(chalk.yellow(`⚠️  Rule "${computedConfig.projectName}-email-rule" already exists in active rule set`));
        console.log(chalk.cyan(`   Will import existing rule instead of creating new one`));
      } else if (detectionResult.ruleExistsForDomain) {
        // A rule exists for this domain but with a different name
        const existingRule = detectionResult.existingRules.find(rule => {
          const recipients = rule.Recipients || [];
          return recipients.includes(computedConfig.domain);
        });
        if (existingRule) {
          console.log(chalk.yellow(`⚠️  A rule for domain ${computedConfig.domain} already exists: "${existingRule.Name}"`));
          console.log(chalk.yellow(`   This rule might be from a previous setup with a different project name`));
          console.log(chalk.cyan(`   Will create a new rule "${computedConfig.projectName}-email-rule" for this domain`));
          console.log(chalk.cyan(`   You may want to remove the old rule "${existingRule.Name}" if it's no longer needed`));
        }
      }
    } else {
      // No active rule set - we'll create our own
      console.log(chalk.blue(`ℹ️  No active VCMail rule set found. This project will create a new one.`));
      
      // Check if there are any inactive rule sets that might have rules for other domains
      try {
        const { stdout: listStdout } = await execa('aws', [
          'ses', 'list-receipt-rule-sets',
          '--output', 'json'
        ], { stdio: 'pipe' });
        
        const ruleSets = JSON.parse(listStdout);
        if (ruleSets.RuleSets && ruleSets.RuleSets.length > 0) {
          console.log(chalk.yellow(`\n⚠️  Warning: Found ${ruleSets.RuleSets.length} inactive rule set(s):`));
          for (const ruleSet of ruleSets.RuleSets) {
            console.log(chalk.yellow(`   - ${ruleSet.Name}`));
          }
          console.log(chalk.yellow(`\n   These rule sets may contain rules for other domains.`));
          console.log(chalk.yellow(`   After creating the new rule set, run "npx vcmail" in other project directories`));
          console.log(chalk.yellow(`   to add their rules to the new active rule set.`));
        }
      } catch (listError) {
        // Ignore list errors - not critical
      }
      
      // Clear any existing shared rule set name from config
      delete config.sharedRuleSetName;
      delete config.activeRuleSetName;
    }
    
    // Save config with active rule set name before proceeding
    // This ensures we remember which rule set we're using
    const configPath = path.join(process.cwd(), CONFIG_FILE);
    if (await fs.pathExists(configPath)) {
      await fs.writeJson(configPath, config, { spaces: 2 });
    }
    
    // Copy template files (now with shared_rule_set_name if detected)
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
    
    // Try to import existing S3 buckets if they exist
    await importExistingS3Buckets(config);
    
    // Try to import existing CloudFront distributions if they exist
    await importExistingCloudFrontDistributions(config);
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
    
    // Get mail domain (webmail domain)
    const mailDomain = config.webmailDomain || config.mailDomain || `mail.${config.domain}`;
    
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
      },
      {
        resource: 'aws_route53_record.webmail',
        name: mailDomain,
        type: 'A',
        description: 'Webmail A record'
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
    // Get computed config values
    const computedConfig = getConfigWithDefaults(config);
    const projectRuleSetName = `${computedConfig.projectName}-incoming-email`;
    // Use activeRuleSetName if sharedRuleSetName is not set (for backward compatibility)
    const ruleSetName = config.sharedRuleSetName || config.activeRuleSetName || projectRuleSetName;
    const ruleName = `${computedConfig.projectName}-email-rule`;
    
    try {
      // Check if we're using a shared rule set (different from our project name)
      if ((config.sharedRuleSetName || config.activeRuleSetName) && ruleSetName !== projectRuleSetName) {
        // Using a shared rule set - only import the rule, not the rule set
        console.log(chalk.cyan(`   Checking if rule "${ruleName}" exists in shared rule set "${ruleSetName}"...`));
        
        try {
          // Check if rule exists in the rule set
          const { stdout: rulesJson } = await execa('aws', [
            'ses', 'describe-receipt-rule-set',
            '--rule-set-name', ruleSetName,
            '--output', 'json'
          ], { cwd: TERRAFORM_DIR, stdio: 'pipe' });
          
          const rules = JSON.parse(rulesJson);
          const ruleExists = rules.Rules?.some(r => r.Name === ruleName);
          
          if (ruleExists) {
            console.log(chalk.yellow(`⚠️  Rule "${ruleName}" already exists in shared rule set`));
            console.log(chalk.cyan(`   Attempting to import into Terraform state...`));
            
            try {
              // Import only the rule (not the rule set or active rule set)
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
              console.log(chalk.yellow(`   Could not import rule (may already be in state): ${importError.message.split('\n')[0]}`));
            }
          }
        } catch (error) {
          // Couldn't check rules - that's okay, Terraform will create it
          if (process.env.DEBUG) {
            console.log(chalk.yellow(`Debug: Could not check existing rules: ${error.message.split('\n')[0]}`));
          }
        }
      } else {
        // Using project-specific rule set - import rule set, active rule set, and rule
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
              'aws_ses_receipt_rule_set.main[0]',
              ruleSetName
            ], {
              cwd: TERRAFORM_DIR,
              stdio: 'pipe'
            });
            console.log(chalk.green(`✓ Imported existing SES rule set: ${ruleSetName}`));
            
            // Try to import the active rule set
            await execa('terraform', [
              'import',
              'aws_ses_active_receipt_rule_set.main[0]',
              ruleSetName
            ], {
              cwd: TERRAFORM_DIR,
              stdio: 'pipe'
            });
            console.log(chalk.green(`✓ Imported active SES rule set: ${ruleSetName}`));
            
            // Try to import the receipt rule
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
      }
    } catch (error) {
      // AWS CLI check failed - that's okay, continue
      if (process.env.DEBUG) {
        console.log(chalk.yellow(`Debug: Could not check for existing SES resources: ${error.message.split('\n')[0]}`));
      }
    }
  } catch (error) {
    // Non-critical - continue anyway
    if (process.env.DEBUG) {
      console.log(chalk.yellow(`Debug: Could not check for existing SES resources: ${error.message}`));
    }
  }
}

/**
 * Attempts to import existing S3 buckets into Terraform state
 * This prevents errors when buckets already exist from previous setups
 */
async function importExistingS3Buckets(config) {
  try {
    // Get computed config values
    const computedConfig = getConfigWithDefaults(config);
    const bucketsToImport = [
      {
        resource: 'aws_s3_bucket.webmail',
        bucketName: computedConfig.s3WebmailBucket,
        description: 'Webmail S3 bucket'
      },
      {
        resource: 'aws_s3_bucket.mail_inbox',
        bucketName: computedConfig.s3BucketName,
        description: 'Mail inbox S3 bucket'
      }
    ];
    
    // Try to import each bucket
    for (const bucket of bucketsToImport) {
      try {
        // Check if bucket exists using AWS CLI
        await execa('aws', [
          's3api', 'head-bucket',
          '--bucket', bucket.bucketName
        ], { cwd: TERRAFORM_DIR, stdio: 'pipe' });
        
        // Bucket exists, try to import it
        console.log(chalk.cyan(`   Attempting to import existing ${bucket.description}...`));
        
        await execa('terraform', [
          'import',
          bucket.resource,
          bucket.bucketName
        ], {
          cwd: TERRAFORM_DIR,
          stdio: 'pipe'
        });
        
        console.log(chalk.green(`✓ Imported existing ${bucket.description}: ${bucket.bucketName}`));
      } catch (importError) {
        // Check if it's already imported or doesn't exist
        if (importError.message && importError.message.includes('already managed')) {
          console.log(chalk.green(`✓ ${bucket.description} already in Terraform state`));
        } else if (importError.message && (
          importError.message.includes('does not exist') ||
          importError.message.includes('404') ||
          importError.message.includes('NoSuchBucket')
        )) {
          // Bucket doesn't exist, that's fine
        } else {
          // Other error - log but don't fail
          if (process.env.DEBUG) {
            console.log(chalk.yellow(`   Could not import ${bucket.description}: ${importError.message.split('\n')[0]}`));
          }
        }
      }
    }
  } catch (error) {
    // Non-critical - continue anyway
    if (process.env.DEBUG) {
      console.log(chalk.yellow(`Debug: Could not check for existing S3 buckets: ${error.message}`));
    }
  }
}

/**
 * Attempts to import existing CloudFront distributions into Terraform state
 * This prevents errors when distributions already exist with the same CNAME
 */
async function importExistingCloudFrontDistributions(config) {
  try {
    const mailDomain = config.webmailDomain || config.mailDomain || `mail.${config.domain}`;
    
    // List all CloudFront distributions
    const { stdout } = await execa('aws', [
      'cloudfront', 'list-distributions',
      '--query', 'DistributionList.Items[*].{Id:Id,Aliases:Aliases.Items}',
      '--output', 'json'
    ], { cwd: TERRAFORM_DIR, stdio: 'pipe' });
    
    const distributions = JSON.parse(stdout);
    
    // Find distribution with matching CNAME
    const matchingDistribution = distributions.find(dist => 
      dist.Aliases && dist.Aliases.includes(mailDomain)
    );
    
    if (matchingDistribution) {
      console.log(chalk.cyan(`   Found existing CloudFront distribution for ${mailDomain}: ${matchingDistribution.Id}`));
      console.log(chalk.cyan(`   Attempting to import into Terraform state...`));
      
      try {
        await execa('terraform', [
          'import',
          'aws_cloudfront_distribution.webmail',
          matchingDistribution.Id
        ], {
          cwd: TERRAFORM_DIR,
          stdio: 'pipe'
        });
        
        console.log(chalk.green(`✓ Imported existing CloudFront distribution: ${matchingDistribution.Id}`));
      } catch (importError) {
        // Check if it's already imported
        if (importError.message && importError.message.includes('already managed')) {
          console.log(chalk.green(`✓ CloudFront distribution already in Terraform state`));
        } else {
          // Other error - log but don't fail
          console.log(chalk.yellow(`   Could not import CloudFront distribution: ${importError.message.split('\n')[0]}`));
          console.log(chalk.cyan(`   You may need to import it manually: terraform import aws_cloudfront_distribution.webmail ${matchingDistribution.Id}`));
        }
      }
    }
  } catch (error) {
    // Non-critical - continue anyway
    if (process.env.DEBUG) {
      console.log(chalk.yellow(`Debug: Could not check for existing CloudFront distributions: ${error.message}`));
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
      
      // Check if error is about S3 bucket already existing
      const s3BucketError = error.message && (
        error.message.includes('BucketAlreadyExists') ||
        error.message.includes('bucket already exists')
      );
      
      // Check if error is about CloudFront distribution CNAME already existing
      const cloudfrontError = error.message && (
        error.message.includes('CNAMEAlreadyExists') ||
        error.message.includes('CNAME you provided are already associated')
      );
      
      if (route53RecordError || s3BucketError || cloudfrontError) {
        let errorType = 'resources';
        if (route53RecordError) errorType = 'Route53 records';
        else if (s3BucketError) errorType = 'S3 buckets';
        else if (cloudfrontError) errorType = 'CloudFront distributions';
        
        spinner.fail(`Terraform apply failed - ${errorType} already exist`);
        console.log(chalk.yellow(`\n⚠️  Some ${errorType} already exist and Terraform tried to create them again.`));
        console.log(chalk.cyan('\n   Attempting to import existing resources and retry...'));
        
        try {
          // Try to import the resources and retry
          if (route53RecordError) {
            await importExistingRoute53Records(config);
          }
          if (s3BucketError) {
            await importExistingS3Buckets(config);
          }
          if (cloudfrontError) {
            await importExistingCloudFrontDistributions(config);
          }
          
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
          
          spinner.succeed(`Terraform changes applied (after importing existing ${errorType.toLowerCase()})`);
          applySucceeded = true;
        } catch (retryError) {
          spinner.fail(`Terraform apply failed even after importing ${errorType.toLowerCase()}`);
          console.log(chalk.yellow(`\n⚠️  Could not automatically fix ${errorType.toLowerCase()} conflicts.`));
          console.log(chalk.cyan('\n   To fix this manually, you can:'));
          if (route53RecordError) {
            console.log(chalk.cyan(`   1. Get your hosted zone ID: aws route53 list-hosted-zones-by-name --dns-name ${config.domain}`));
            console.log(chalk.cyan(`   2. Import Route53 records: cd ${TERRAFORM_DIR} && terraform import aws_route53_record.<name> <ZONE_ID>_<record_name>_<type>`));
          }
          if (s3BucketError) {
            const computedConfig = getConfigWithDefaults(config);
            const webmailBucket = computedConfig.s3WebmailBucket;
            const inboxBucket = computedConfig.s3BucketName;
            console.log(chalk.cyan(`   1. Import webmail bucket: cd ${TERRAFORM_DIR} && terraform import aws_s3_bucket.webmail ${webmailBucket}`));
            console.log(chalk.cyan(`   2. Import inbox bucket: cd ${TERRAFORM_DIR} && terraform import aws_s3_bucket.mail_inbox ${inboxBucket}`));
          }
          if (cloudfrontError) {
            const mailDomain = config.webmailDomain || config.mailDomain || `mail.${config.domain}`;
            console.log(chalk.cyan(`   1. Find CloudFront distribution: aws cloudfront list-distributions --query "DistributionList.Items[?Aliases.Items[?contains(@, '${mailDomain}')]].Id" --output text`));
            console.log(chalk.cyan(`   2. Import CloudFront: cd ${TERRAFORM_DIR} && terraform import aws_cloudfront_distribution.webmail <DISTRIBUTION_ID>`));
          }
          console.log(chalk.cyan(`   3. Then run terraform apply again`));
          throw retryError;
        }
      } else if (error.message && error.message.includes('Cannot delete active rule set')) {
        spinner.fail('Terraform apply failed - cannot delete active SES rule set');
        console.log(chalk.yellow('\n⚠️  The SES rule set is currently active and cannot be deleted.'));
        console.log(chalk.yellow('   This usually means the rule set already exists and Terraform is trying to recreate it.'));
        console.log(chalk.cyan('\n   To fix this, you can:'));
        const computedConfig = getConfigWithDefaults(config);
        console.log(chalk.cyan(`   1. Import the existing rule set: cd ${TERRAFORM_DIR} && terraform import aws_ses_receipt_rule_set.main ${computedConfig.projectName}-incoming-email`));
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
    
    // Verify CloudFront configuration matches API Gateway
    if (config.cloudfrontDistributionId && outputs.api_gateway_id?.value) {
      await verifyCloudFrontConfig(config, outputs.api_gateway_id.value);
    }
    
    // Verify SES receipt rule is correctly configured
    await verifySESReceiptRule(config);
    
    // Update bucket names from Terraform outputs (these are the actual created buckets)
    // Note: s3BucketName and s3WebmailBucket are derived from domain/webmailDomain
    // and should not be saved to config file
    
    // Ensure webmailDomain is set (support legacy mailDomain)
    if (!config.webmailDomain && !config.mailDomain) {
      config.webmailDomain = `mail.${config.domain}`;
    } else if (config.mailDomain && !config.webmailDomain) {
      config.webmailDomain = config.mailDomain;
    }
    
    // Ensure activeRuleSetName is preserved if it was set during initialization
    // This tracks which rule set we're actually using (may differ from project name)
    if (!config.activeRuleSetName && config.sharedRuleSetName) {
      config.activeRuleSetName = config.sharedRuleSetName;
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
  const computedConfig = getConfigWithDefaults(config);
  const paramName = `${computedConfig.ssmPrefix}/firebase_service_account`;
  
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

async function setupFirebaseAuthProviders(config) {
  try {
    const { setupFirebaseAuth } = require('../scripts/setup-firebase-auth');
    await setupFirebaseAuth(config);
  } catch (error) {
    // Don't fail setup if auth provider setup fails - it's optional
    console.log(chalk.yellow(`\n⚠️  Could not automatically setup Firebase Authentication providers: ${error.message}`));
    console.log(chalk.cyan('   You can enable them manually in the Firebase Console:'));
    console.log(chalk.cyan('   1. Go to https://console.firebase.google.com/'));
    console.log(chalk.cyan(`   2. Select project: ${config.firebaseProjectId}`));
    console.log(chalk.cyan('   3. Go to Authentication > Sign-in method'));
    console.log(chalk.cyan('   4. Enable "Email/Password"'));
    console.log(chalk.cyan('   5. Enable "Google"'));
  }
}

async function deployFirebaseRules(config) {
  // Ensure ES modules are loaded
  await loadESModules();
  
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
    console.log(chalk.red(`\n❌ Could not deploy Firebase database rules: ${error.message}`));
    console.log(chalk.yellow('\n   This might be because:'));
    console.log(chalk.yellow('   1. Firebase service account is not in SSM'));
    console.log(chalk.yellow('   2. Firebase database URL is incorrect'));
    console.log(chalk.yellow('   3. Network/permission issues'));
    console.log(chalk.yellow('\n   ⚠️  IMPORTANT: Without deployed rules, users will get permission errors!'));
    console.log(chalk.cyan('\n   To deploy rules manually, run from your project directory:'));
    console.log(chalk.cyan('   npm run deploy-rules'));
    console.log(chalk.cyan('   OR'));
    console.log(chalk.cyan('   node scripts/deploy-database-rules.js'));
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
    
    // Deploy all S3 assets using consolidated function
    await deployS3Assets(config);
    
    spinner.succeed('Webmail client deployed');
  } catch (error) {
    spinner.fail('Webmail client deployment failed');
    throw error;
  }
}

/**
 * Consolidated function to deploy all S3 assets for the webmail client
 * This handles: index.html, favicon.ico, firebaseConfig.js, and all src files
 * Called by both deployWebmailClient and deployHtmlToS3 to ensure consistency
 */
async function deployS3Assets(config) {
  await loadESModules();
  
  const computedConfig = getConfigWithDefaults(config);
  
  // Get actual bucket name from Terraform outputs if available, otherwise use computed value
  let webmailBucket = computedConfig.s3WebmailBucket;
  try {
    const outputs = await parseTerraformOutputs();
    if (outputs.webmail_s3_bucket?.value) {
      webmailBucket = outputs.webmail_s3_bucket.value;
    }
  } catch (error) {
    console.log(chalk.yellow(`Warning: Could not get Terraform outputs, using computed bucket name: ${webmailBucket}`));
  }
  
  if (!webmailBucket) {
    throw new Error('Webmail S3 bucket name not found in Terraform outputs or computed from config');
  }
  
  // Build assets with Vite before deployment
  // Always build in the VCMail package directory, not the consuming project
  const vcmailPackageDir = path.join(__dirname, '..');
  const viteConfigPath = path.join(vcmailPackageDir, 'vite.config.js');
  const distDir = path.join(vcmailPackageDir, 'dist');
  
  if (await fs.pathExists(viteConfigPath)) {
    console.log(chalk.cyan('📦 Building assets with Vite...'));
    console.log(chalk.cyan(`   Building in VCMail package: ${vcmailPackageDir}`));
    
    try {
      const execaModule = await import('execa');
      const execa = execaModule.default || execaModule;
      
      // Check if vite is available in the VCMail package
      const packageJsonPath = path.join(vcmailPackageDir, 'package.json');
      const packageJson = await fs.readJson(packageJsonPath);
      const hasVite = packageJson.devDependencies?.vite || packageJson.dependencies?.vite;
      
      if (!hasVite) {
        console.log(chalk.yellow('⚠️  Vite not found in VCMail package dependencies'));
        console.log(chalk.yellow('   Installing Vite...'));
        await execa('npm', ['install', 'vite', 'terser', '--save-dev'], {
          cwd: vcmailPackageDir,
          stdio: 'inherit'
        });
      }
      
      // Run vite build in the VCMail package directory
      // Use npx vite to ensure we use the local vite installation from VCMail package
      await execa('npx', ['vite', 'build'], {
        cwd: vcmailPackageDir,
        stdio: 'inherit',
        env: {
          ...process.env,
          // Ensure we don't pick up vite config from consuming project
          NODE_ENV: 'production'
        }
      });
      
      if (await fs.pathExists(distDir)) {
        console.log(chalk.green('✓ Vite build completed successfully'));
      } else {
        throw new Error('Build completed but dist directory not found');
      }
    } catch (error) {
      console.log(chalk.yellow('⚠️  Vite build failed, falling back to raw source files'));
      console.log(chalk.yellow(`   Error: ${error.message}`));
      console.log(chalk.cyan('   Continuing deployment with source files...'));
    }
  } else {
    console.log(chalk.yellow('⚠️  vite.config.js not found, skipping build step'));
    console.log(chalk.cyan('   Deploying source files directly...'));
  }
  
  // Upload to S3
  const s3 = new AWS.S3({ region: computedConfig.awsRegion });
  
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
  
  // Prepare Firebase config object
  const firebaseConfigObj = {
    apiKey: config.firebaseApiKey || process.env.FIREBASE_API_KEY || '',
    authDomain: `${config.firebaseProjectId}.firebaseapp.com`,
    databaseURL: config.firebaseDatabaseURL,
    projectId: config.firebaseProjectId,
    storageBucket: `${config.firebaseProjectId}.appspot.com`,
    messagingSenderId: config.firebaseMessagingSenderId || '',
    appId: config.firebaseAppId || config.firebaseProjectId
  };
  
  // Validate Firebase API key before deploying
  if (!config.firebaseApiKey || config.firebaseApiKey === 'your-api-key' || config.firebaseApiKey === 'your-firebase-api-key') {
    console.log(chalk.yellow(`⚠️  Warning: Firebase API key is missing or placeholder. Webmail authentication may not work.`));
    console.log(chalk.cyan(`   Please add firebaseApiKey to ${CONFIG_FILE} and redeploy.`));
  } else {
    console.log(chalk.green(`✓ Using Firebase API key: ${config.firebaseApiKey.substring(0, 10)}...`));
  }
  
  // Log Firebase config for debugging (without exposing full API key)
  console.log(chalk.cyan(`✓ Firebase config:`));
  console.log(chalk.cyan(`   Project ID: ${firebaseConfigObj.projectId}`));
  console.log(chalk.cyan(`   API Key: ${firebaseConfigObj.apiKey ? firebaseConfigObj.apiKey.substring(0, 10) + '...' : 'MISSING'}`));
  console.log(chalk.cyan(`   Auth Domain: ${firebaseConfigObj.authDomain}`));
  
  // Inject VCMail configuration into HTML
  const webmailDomain = config.webmailDomain || config.mailDomain || `mail.${config.domain}`;
  const vcmailConfigObj = {
    domain: config.domain,
    webmailDomain: webmailDomain,
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
  
  // Upload index.html with injected config
  // Use built version from dist if available, otherwise use source
  const indexHtmlPath = await fs.pathExists(path.join(vcmailPackageDir, 'dist', 'index.html'))
    ? path.join(vcmailPackageDir, 'dist', 'index.html')
    : path.join(vcmailPackageDir, 'index.html');
  let indexHtml = await fs.readFile(indexHtmlPath, 'utf-8');
  
  // Replace or add config script before closing head tag
  let replaced = false;
  const originalHtmlLength = indexHtml.length;
  
  // Pattern 1: Match script tag with comments and VCMAIL_CONFIG
  const configScriptRegex1 = /<script>[\s\S]*?\/\/.*?VCMail.*?configuration[\s\S]*?window\.VCMAIL_CONFIG[\s\S]*?<\/script>/i;
  if (configScriptRegex1.test(indexHtml)) {
    const beforeReplace = indexHtml.length;
    indexHtml = indexHtml.replace(configScriptRegex1, vcmailConfigScript.trim());
    if (indexHtml.length !== beforeReplace) {
      replaced = true;
      console.log(chalk.green(`✓ Replaced existing VCMAIL_CONFIG in index.html (method 1)`));
    }
  }
  
  // Pattern 2: Match any script tag containing window.VCMAIL_CONFIG
  if (!replaced) {
    const configScriptRegex2 = /<script>[\s\S]*?window\.VCMAIL_CONFIG[\s\S]*?<\/script>/i;
    if (configScriptRegex2.test(indexHtml)) {
      const beforeReplace = indexHtml.length;
      indexHtml = indexHtml.replace(configScriptRegex2, vcmailConfigScript.trim());
      if (indexHtml.length !== beforeReplace) {
        replaced = true;
        console.log(chalk.green(`✓ Replaced existing VCMAIL_CONFIG in index.html (method 2)`));
      }
    }
  }
  
  // Pattern 3: Direct replacement
  if (!replaced) {
    const vcmailConfigIndex = indexHtml.indexOf('window.VCMAIL_CONFIG');
    if (vcmailConfigIndex > -1) {
      const scriptStartIndex = indexHtml.lastIndexOf('<script>', vcmailConfigIndex);
      const scriptEndIndex = indexHtml.indexOf('</script>', vcmailConfigIndex);
      
      if (scriptStartIndex >= 0 && scriptEndIndex >= 0 && scriptEndIndex > scriptStartIndex) {
        indexHtml = indexHtml.substring(0, scriptStartIndex) + 
                   vcmailConfigScript.trim() + 
                   indexHtml.substring(scriptEndIndex + '</script>'.length);
        replaced = true;
        console.log(chalk.green('✓ Replaced VCMAIL_CONFIG in index.html (direct replacement)'));
      }
    }
  }
  
  // If no replacement happened, insert before closing head tag
  if (!replaced) {
    if (indexHtml.includes('</head>')) {
      indexHtml = indexHtml.replace('</head>', `  ${vcmailConfigScript.trim()}\n</head>`);
      replaced = true;
      console.log(chalk.green('✓ Inserted VCMAIL_CONFIG into index.html'));
    } else {
      indexHtml = indexHtml.replace('</head>', `${vcmailConfigScript.trim()}\n</head>`);
      console.log(chalk.yellow('⚠️  Inserted VCMAIL_CONFIG at end of head (fallback)'));
    }
  }
  
  // Verify the replacement worked
  if (!indexHtml.includes(config.firebaseApiKey || '') && config.firebaseApiKey && config.firebaseApiKey !== 'your-api-key') {
    console.log(chalk.yellow('⚠️  Warning: Firebase API key might not have been injected. Please check the deployed HTML.'));
  } else if (config.firebaseApiKey && config.firebaseApiKey !== 'your-api-key') {
    console.log(chalk.green('✓ Verified Firebase API key is in the HTML'));
  }
  
  // Upload index.html
  await s3.putObject({
    Bucket: webmailBucket,
    Key: 'index.html',
    Body: indexHtml,
    ContentType: 'text/html',
    CacheControl: 'no-cache, no-store, must-revalidate'
  }).promise();
  
  console.log(chalk.green(`✓ Uploaded index.html to S3 (${(indexHtml.length / 1024).toFixed(2)} KB)`));
  
  // Upload favicon.ico
  const faviconPath = path.join(vcmailPackageDir, 'favicon.ico');
  if (await fs.pathExists(faviconPath)) {
    const faviconContent = await fs.readFile(faviconPath);
    await s3.putObject({
      Bucket: webmailBucket,
      Key: 'favicon.ico',
      Body: faviconContent,
      ContentType: 'image/x-icon',
      CacheControl: 'public, max-age=31536000' // Cache favicon for 1 year
    }).promise();
    console.log(chalk.green(`✓ Uploaded favicon.ico to S3`));
  } else {
    console.log(chalk.yellow('⚠️  favicon.ico not found. Run "node scripts/generate-favicon.js" to generate it.'));
  }
  
  // Upload public directory (images, etc.)
  const publicDir = path.join(vcmailPackageDir, 'public');
  if (await fs.pathExists(publicDir)) {
    const uploadDirectory = async (dir, prefix = '') => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const s3Key = prefix ? `${prefix}/${entry.name}` : entry.name;
        
        if (entry.isDirectory()) {
          await uploadDirectory(fullPath, s3Key);
        } else {
          const content = await fs.readFile(fullPath);
          
          // Determine content type based on file extension
          let contentType = 'application/octet-stream';
          const ext = path.extname(entry.name).toLowerCase();
          const contentTypes = {
            '.webp': 'image/webp',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.json': 'application/json',
            '.html': 'text/html',
            '.txt': 'text/plain'
          };
          contentType = contentTypes[ext] || contentType;
          
          await s3.putObject({
            Bucket: webmailBucket,
            Key: s3Key,
            Body: content,
            ContentType: contentType,
            CacheControl: ext.match(/\.(webp|png|jpg|jpeg|gif|svg|ico|css)$/i) 
              ? 'public, max-age=31536000' // Cache static assets for 1 year
              : 'public, max-age=3600' // Cache other files for 1 hour
          }).promise();
          console.log(chalk.green(`✓ Uploaded ${s3Key} to S3`));
        }
      }
    };
    
    await uploadDirectory(publicDir);
    console.log(chalk.green('✓ Uploaded public directory to S3'));
  }
  
  // Update and upload firebaseConfig.js (only if not using built version)
  // When using Vite build, firebaseConfig.js is bundled into index.js, so we skip it
  const buildDir = await fs.pathExists(path.join(vcmailPackageDir, 'dist'))
    ? path.join(vcmailPackageDir, 'dist')
    : null;
  
  if (!buildDir) {
    // Only upload firebaseConfig.js separately if we're using source files
    const firebaseConfigPath = path.join(vcmailPackageDir, 'src', 'firebaseConfig.js');
    if (await fs.pathExists(firebaseConfigPath)) {
      let firebaseConfig = await fs.readFile(firebaseConfigPath, 'utf-8');
      
      firebaseConfig = firebaseConfig.replace(
        /export const firebaseConfig = window\.VCMAIL_CONFIG\?\.firebase \|\| \{[\s\S]*?\};/,
        `export const firebaseConfig = window.VCMAIL_CONFIG?.firebase || ${JSON.stringify(firebaseConfigObj, null, 2)};`
      );
      
      const vcmailConfigObjForJs = {
        domain: config.domain,
        webmailDomain: webmailDomain,
        apiEndpoint: '',
        storageCacheKey: config.storageCacheKey || 'vcmail_email_cache',
        buildId: buildId
      };
      
      firebaseConfig = firebaseConfig.replace(
        /export const vcmailConfig = window\.VCMAIL_CONFIG \|\| \{[\s\S]*?\};/,
        `export const vcmailConfig = window.VCMAIL_CONFIG || ${JSON.stringify(vcmailConfigObjForJs, null, 2)};`
      );
      
      await s3.putObject({
        Bucket: webmailBucket,
        Key: 'src/firebaseConfig.js',
        Body: firebaseConfig,
        ContentType: 'application/javascript'
      }).promise();
      
      console.log(chalk.green('✓ Uploaded src/firebaseConfig.js to S3'));
    }
  } else {
    console.log(chalk.cyan('ℹ️  Skipping firebaseConfig.js upload (bundled in Vite build)'));
  }
  
  // Upload built files from dist if available, otherwise upload from src
  // Always use paths relative to VCMail package directory
  const srcDir = path.join(vcmailPackageDir, 'src');
  const uploadDir = buildDir || srcDir;
  
  if (buildDir) {
    console.log(chalk.cyan(`📤 Using built assets from: ${buildDir}`));
  } else {
    console.log(chalk.cyan(`📤 Using source files from: ${srcDir}`));
  }
  
  // Upload files recursively from uploadDir
  const uploadFilesRecursively = async (dir, basePath = '') => {
    if (!await fs.pathExists(dir)) return;
    
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
      
      if (entry.isDirectory()) {
        // Recursively upload subdirectories
        await uploadFilesRecursively(fullPath, relativePath);
      } else {
        // Skip files already uploaded
        if (entry.name === 'index.html') continue;
        if (!buildDir && entry.name === 'firebaseConfig.js') continue; // Already uploaded above if using source
        
        const content = await fs.readFile(fullPath);
        
        // Determine content type
        let contentType = 'application/octet-stream';
        const ext = path.extname(entry.name).toLowerCase();
        const contentTypes = {
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.html': 'text/html',
          '.txt': 'text/plain'
        };
        contentType = contentTypes[ext] || contentType;
        
        // Determine S3 key - preserve directory structure
        const s3Key = relativePath.replace(/\\/g, '/'); // Normalize path separators
        
        await s3.putObject({
          Bucket: webmailBucket,
          Key: s3Key,
          Body: content,
          ContentType: contentType,
          CacheControl: ext.match(/\.(css|js)$/) 
            ? 'public, max-age=31536000' // Cache CSS/JS for 1 year
            : undefined
        }).promise();
        console.log(chalk.green(`✓ Uploaded ${s3Key} to S3`));
      }
    }
  };
  
  await uploadFilesRecursively(uploadDir);
  
  // Invalidate CloudFront cache so changes are visible immediately
  await invalidateCloudFrontCache(config);
  
  return { buildId, webmailBucket };
}

async function invalidateCloudFrontCache(config) {
  // Ensure ES modules are loaded
  await loadESModules();
  
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
  const computedConfig = getConfigWithDefaults(config);
  let tfvars = `domain                  = "${computedConfig.domain}"
project_name            = "${computedConfig.projectName}"
mail_domain             = "${computedConfig.webmailDomain}"
aws_region              = "${computedConfig.awsRegion}"
firebase_project_id     = "${computedConfig.firebaseProjectId}"
firebase_database_url   = "${computedConfig.firebaseDatabaseURL}"
ssm_prefix              = "${computedConfig.ssmPrefix}"
s3_bucket_name          = "${computedConfig.s3BucketName}"
s3_webmail_bucket_name  = "${computedConfig.s3WebmailBucket}"
`;
  
  // Add shared_rule_set_name if detected (use activeRuleSetName if sharedRuleSetName not set)
  const ruleSetName = config.sharedRuleSetName || config.activeRuleSetName || '';
  if (ruleSetName) {
    tfvars += `shared_rule_set_name     = "${ruleSetName}"
`;
  }
  
  return tfvars;
}

function generateProviderTf(config) {
  return `provider "aws" {
  region = var.aws_region
}
`;
}

async function generateServerlessConfig(config) {
  const computedConfig = getConfigWithDefaults(config);
  const template = await fs.readFile(
    path.join(__dirname, '..', 'templates', 'serverless.yml.template'),
    'utf-8'
  );
  
  // First, replace SSM variable references BEFORE replacing SSM_PREFIX
  // Pattern: ${ssm:${SSM_PREFIX}/param} becomes ${ssm:/path/param}
  // Note: In newer Serverless Framework versions, ~true suffix is not needed for SecureString
  let serverlessYml = template.replace(
    /\$\{ssm:\$\{SSM_PREFIX\}\/([^}~]+)(~true)?\}/g, 
    `\${ssm:${computedConfig.ssmPrefix}/$1}`
  );
  
  // Now replace all other variables
  serverlessYml = serverlessYml
    .replace(/\$\{PROJECT_NAME\}/g, computedConfig.projectName)
    .replace(/\$\{DOMAIN\}/g, computedConfig.domain)
    .replace(/\$\{SSM_PREFIX\}/g, computedConfig.ssmPrefix)
    .replace(/\$\{S3_BUCKET\}/g, computedConfig.s3BucketName)
    .replace(/\$\{S3_WEBMAIL_BUCKET\}/g, computedConfig.s3WebmailBucket)
    .replace(/\$\{AWS_REGION\}/g, computedConfig.awsRegion)
    .replace(/\$\{AWS_ACCOUNT_ID\}/g, computedConfig.awsAccountId);
  
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

/**
 * Verify API Gateway stage is using latest deployment
 * Detects if stage is using stale deployment
 */
async function verifyAPIGatewayStage(apiGatewayId, stageName = 'prod') {
  await loadESModules();
  
  try {
    // Get stage info
    const { stdout: stageStdout } = await execa('aws', [
      'apigateway', 'get-stage',
      '--rest-api-id', apiGatewayId,
      '--stage-name', stageName,
      '--output', 'json'
    ], { stdio: 'pipe' });
    
    const stage = JSON.parse(stageStdout);
    
    // Get all deployments
    const { stdout: deploymentsStdout } = await execa('aws', [
      'apigateway', 'get-deployments',
      '--rest-api-id', apiGatewayId,
      '--output', 'json'
    ], { stdio: 'pipe' });
    
    const deployments = JSON.parse(deploymentsStdout);
    
    if (!deployments.items || deployments.items.length === 0) {
      return true; // No deployments to check
    }
    
    // Sort by creation date (newest first)
    deployments.items.sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
    const latestDeployment = deployments.items[0];
    
    if (stage.deploymentId !== latestDeployment.id) {
      console.log(chalk.yellow(`\n⚠️  Warning: API Gateway stage '${stageName}' is using old deployment!`));
      console.log(chalk.yellow(`   Current: ${stage.deploymentId} (${deployments.items.find(d => d.id === stage.deploymentId)?.createdDate || 'unknown'})`));
      console.log(chalk.yellow(`   Latest:  ${latestDeployment.id} (${latestDeployment.createdDate})`));
      console.log(chalk.cyan(`   Run 'terraform apply' to update the stage to use the latest deployment.`));
      return false;
    }
    
    console.log(chalk.green(`\n✓ API Gateway stage is using latest deployment`));
    return true;
  } catch (error) {
    console.log(chalk.yellow(`\n⚠️  Could not verify API Gateway stage: ${error.message.split('\n')[0]}`));
    return false;
  }
}

/**
 * Verify SES receipt rule is correctly configured
 * Checks that rule exists, is enabled, and points to correct Lambda
 */
async function verifySESReceiptRule(config) {
  await loadESModules();
  
  try {
    const computedConfig = getConfigWithDefaults(config);
    const expectedRuleName = `${computedConfig.projectName}-email-rule`;
    const expectedFunctionName = `${computedConfig.projectName}-api`;
    
    // Get active rule set
    const { stdout } = await execa('aws', [
      'ses', 'describe-active-receipt-rule-set',
      '--output', 'json'
    ], { stdio: 'pipe' });
    
    const ruleSet = JSON.parse(stdout);
    
    if (!ruleSet.Rules || ruleSet.Rules.length === 0) {
      console.log(chalk.yellow(`\n⚠️  Warning: No rules found in active rule set`));
      return false;
    }
    
    // Find our rule
    const ourRule = ruleSet.Rules.find(r => r.Name === expectedRuleName);
    
    if (!ourRule) {
      console.log(chalk.yellow(`\n⚠️  Warning: SES receipt rule "${expectedRuleName}" not found in active rule set`));
      console.log(chalk.cyan(`   Run 'terraform apply' to create the rule`));
      return false;
    }
    
    // Check if rule is enabled
    if (!ourRule.Enabled) {
      console.log(chalk.yellow(`\n⚠️  Warning: SES receipt rule "${expectedRuleName}" is disabled`));
      console.log(chalk.cyan(`   Run 'terraform apply' to enable it`));
      return false;
    }
    
    // Check if rule matches our domain
    const recipients = ourRule.Recipients || [];
    if (!recipients.includes(computedConfig.domain)) {
      console.log(chalk.yellow(`\n⚠️  Warning: SES receipt rule "${expectedRuleName}" does not match domain ${computedConfig.domain}`));
      console.log(chalk.yellow(`   Rule recipients: ${recipients.join(', ')}`));
      console.log(chalk.cyan(`   Run 'terraform apply' to update the rule`));
      return false;
    }
    
    // Check Lambda action
    const lambdaAction = ourRule.Actions?.find(a => a.LambdaAction);
    if (!lambdaAction) {
      console.log(chalk.yellow(`\n⚠️  Warning: SES receipt rule "${expectedRuleName}" has no Lambda action`));
      console.log(chalk.cyan(`   Run 'terraform apply' to add Lambda action`));
      return false;
    }
    
    // Extract function name from ARN
    const functionArn = lambdaAction.LambdaAction.FunctionArn;
    const functionNameMatch = functionArn.match(/function:(.+?)(?::|$)/);
    if (functionNameMatch) {
      const functionName = functionNameMatch[1];
      
      if (functionName !== expectedFunctionName) {
        console.log(chalk.yellow(`\n⚠️  Warning: SES receipt rule points to Lambda "${functionName}", expected "${expectedFunctionName}"`));
        console.log(chalk.cyan(`   Run 'terraform apply' to update the rule`));
        return false;
      }
      
      // Verify Lambda is configured for correct domain
      try {
        const lambda = new AWS.Lambda({ region: computedConfig.awsRegion });
        const func = await lambda.getFunction({ FunctionName: functionName }).promise();
        const env = func.Configuration.Environment?.Variables || {};
        
        if (env.VCMAIL_CONFIG) {
          const vcmailConfig = JSON.parse(env.VCMAIL_CONFIG);
          if (vcmailConfig.domain !== computedConfig.domain) {
            console.log(chalk.yellow(`\n⚠️  Warning: Lambda "${functionName}" is configured for domain "${vcmailConfig.domain}", not "${computedConfig.domain}"`));
            console.log(chalk.cyan(`   Run 'terraform apply' to update Lambda environment variable`));
            return false;
          }
        }
      } catch (lambdaError) {
        console.log(chalk.yellow(`\n⚠️  Could not verify Lambda configuration: ${lambdaError.message}`));
        return false;
      }
    }
    
    console.log(chalk.green(`\n✓ SES receipt rule "${expectedRuleName}" is correctly configured`));
    return true;
  } catch (error) {
    if (error.message && error.message.includes('RuleSetDoesNotExist')) {
      console.log(chalk.yellow(`\n⚠️  Warning: No active SES rule set found`));
      console.log(chalk.cyan(`   Run 'terraform apply' to create a rule set`));
    } else {
      console.log(chalk.yellow(`\n⚠️  Could not verify SES receipt rule: ${error.message.split('\n')[0]}`));
    }
    return false;
  }
}

/**
 * Verify CloudFront configuration matches API Gateway setup
 * Detects configuration drift and warns user
 */
async function verifyCloudFrontConfig(config, apiGatewayId) {
  await loadESModules();
  
  try {
    const { stdout } = await execa('aws', [
      'cloudfront', 'get-distribution-config',
      '--id', config.cloudfrontDistributionId,
      '--query', 'DistributionConfig',
      '--output', 'json'
    ], { stdio: 'pipe' });
    
    const distConfig = JSON.parse(stdout);
    const expectedOriginId = `API-${apiGatewayId}`;
    const apiOrigin = distConfig.Origins.Items.find(origin => origin.Id === expectedOriginId);
    
    if (!apiOrigin) {
      console.log(chalk.yellow(`\n⚠️  Warning: CloudFront distribution ${config.cloudfrontDistributionId} does not have API Gateway origin ${expectedOriginId}`));
      console.log(chalk.cyan(`   This may cause API calls to fail. Run 'terraform apply' to update CloudFront.`));
      return false;
    }
    
    // Check if origin path matches stage
    const expectedOriginPath = '/prod';
    if (apiOrigin.OriginPath !== expectedOriginPath) {
      console.log(chalk.yellow(`\n⚠️  Warning: CloudFront API Gateway origin path mismatch!`));
      console.log(chalk.yellow(`   Expected: ${expectedOriginPath}`));
      console.log(chalk.yellow(`   Actual: ${apiOrigin.OriginPath || '(none)'}`));
      console.log(chalk.cyan(`   Run 'terraform apply' to fix this.`));
      return false;
    }
    
    // Check cache behavior
    const apiCacheBehavior = distConfig.CacheBehaviors?.Items?.find(
      behavior => behavior.PathPattern === '/api/*'
    );
    
    if (!apiCacheBehavior) {
      console.log(chalk.yellow(`\n⚠️  Warning: CloudFront cache behavior for /api/* not found!`));
      console.log(chalk.cyan(`   Run 'terraform apply' to add it.`));
      return false;
    }
    
    if (apiCacheBehavior.TargetOriginId !== expectedOriginId) {
      console.log(chalk.yellow(`\n⚠️  Warning: CloudFront cache behavior targets wrong origin!`));
      console.log(chalk.yellow(`   Expected: ${expectedOriginId}`));
      console.log(chalk.yellow(`   Actual: ${apiCacheBehavior.TargetOriginId}`));
      console.log(chalk.cyan(`   Run 'terraform apply' to fix this.`));
      return false;
    }
    
    console.log(chalk.green(`\n✓ CloudFront configuration verified`));
    return true;
  } catch (error) {
    console.log(chalk.yellow(`\n⚠️  Could not verify CloudFront configuration: ${error.message.split('\n')[0]}`));
    return false;
  }
}

/**
 * Deploy only HTML and src files to S3 (quick deployment for HTML changes)
 * This uses the consolidated deployS3Assets function to ensure all assets are deployed
 */
async function deployHtmlToS3() {
  // Ensure ES modules are loaded first
  await loadESModules();
  
  const spinner = ora('Deploying HTML files to S3...').start();
  
  try {
    // Load config from file
    const configPath = path.join(process.cwd(), CONFIG_FILE);
    if (!await fs.pathExists(configPath)) {
      throw new Error(`Configuration file ${CONFIG_FILE} not found. Please run 'npx vcmail' first to create it.`);
    }
    
    const fileConfig = await fs.readJson(configPath);
    const config = getConfigWithDefaults(fileConfig);
    
    // Deploy all S3 assets using consolidated function
    await deployS3Assets(config);
    
    spinner.succeed('HTML files deployed to S3');
  } catch (error) {
    spinner.fail('HTML deployment failed');
    throw error;
  }
}

module.exports = { setup, deployWebmailClient, deployFirebaseRules, deployHtmlToS3 };

