/**
 * VCMail Setup Wizard
 * Interactive setup for configuring VCMail email infrastructure
 */

const path = require('path');
const fs = require('fs-extra');
const { S3Client, PutObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { SSMClient, GetParameterCommand, PutParameterCommand } = require('@aws-sdk/client-ssm');
const { CloudFrontClient, CreateInvalidationCommand } = require('@aws-sdk/client-cloudfront');
const { LambdaClient, GetFunctionCommand } = require('@aws-sdk/client-lambda');

function isParameterNotFound(err) {
  return err && (err.name === 'ParameterNotFound' || err.code === 'ParameterNotFound');
}

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
// Terraform directory in user's project (where they run npx vcmail) — per-domain site resources
const TERRAFORM_DIR = path.join(process.cwd(), '.vcmail-terraform');
// Account-level stack: shared Lambda, IAM, canonical SES rule set (once per AWS account)
const TERRAFORM_ACCOUNT_DIR = path.join(process.cwd(), '.vcmail-terraform-account');
// Package Terraform directory (source files)
const PACKAGE_TERRAFORM_DIR = path.join(__dirname, 'terraform');
const PACKAGE_TERRAFORM_ACCOUNT_DIR = path.join(__dirname, 'terraform-account');

/** Shared multiproject Lambda IAM role (must match lib/terraform-account/main.tf). */
const SHARED_VCMAIL_LAMBDA_IAM_ROLE_NAME = 'VCMail-api-role';

/** Shared multiproject Lambda function name (must match lib/terraform-account/main.tf). */
const SHARED_VCMAIL_LAMBDA_FUNCTION_NAME = 'VCMail-api';

/** Canonical SES receipt rule set for all VCMail domains in one AWS account (must match Terraform locals). */
const VCMAIL_SES_RULE_SET_NAME = 'vcmail_rule_set';

/** execa v5 often omits stderr from `message` alone; use this for reliable substring checks. */
function execaCombinedErrorText(err) {
  if (!err) return '';
  const parts = [err.message, err.stderr, err.stdout].filter((s) => typeof s === 'string' && s.length > 0);
  return parts.join('\n');
}

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

  await ensureGoogleCalendarApiForFirebaseProject(config, skipPrompts, configPath);
  
  // Update .gitignore to exclude VCMail-generated directories
  await updateGitignore();
  
  // Prepare Lambda package before Terraform (Terraform needs it)
  await prepareLambdaPackage(config);
  
  // Initialize Terraform (account stack, then site stack)
  await initializeTerraform(config, skipPrompts);
  
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

// Validate and complete configuration - prompt only for essential values
// Only domain, webmailDomain, and ssmPrefix are required
// Everything else is derived from domain or loaded from SSM
async function validateAndCompleteConfig(existingConfig, skipPrompts = false) {
  const requiredFields = [
    { key: 'domain', message: 'Enter your domain name (e.g., example.com):' }
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
    // Keep ssmPrefix if explicitly set by user, but remove other derived fields
    const fieldsToRemove = ['s3BucketName', 's3WebmailBucket', 'projectName', 'cloudfrontDistributionId', 'cloudfrontDomainName', 'apiEndpoint'];
    // Keep Firebase web client fields when present — deployS3Assets persists values discovered from SSM
    // so later npx vcmail runs avoid redundant discovery. Service account JSON stays only in SSM.
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

/**
 * Enable Google Calendar API on the Google Cloud project that hosts Firebase.
 *
 * The Firebase project ID is the same as the parent Google Cloud project ID (Firebase console →
 * Project settings). We only persist `firebaseProjectId` in vcmail.config.json — there is no
 * separate `gcpProjectId`. This function passes that ID to `gcloud ... --project <id>`.
 *
 * If an older config still has `gcpProjectId` in JSON only, we still honor it here until the file
 * is updated to use `firebaseProjectId` only.
 */
async function ensureGoogleCalendarApiForFirebaseProject(config, skipPrompts, configPath) {
  await loadESModules();
  let fileExtra = {};
  if (configPath && (await fs.pathExists(configPath))) {
    try {
      fileExtra = await fs.readJson(configPath);
    } catch {
      fileExtra = {};
    }
  }
  // Effective GCP project for APIs = Firebase project ID (single ID in Google Cloud).
  let projectId = String(
    config.firebaseProjectId || fileExtra.firebaseProjectId || fileExtra.gcpProjectId || ''
  ).trim();

  if (!projectId) {
    if (skipPrompts) {
      console.log(
        chalk.yellow(
          '⚠️  No firebaseProjectId in config — skipping automatic Google Calendar API enable (skip-prompts mode).\n'
        )
      );
    } else {
      console.log(
        chalk.cyan(
          'No firebaseProjectId — skipping automatic Google Calendar API enable. Add firebaseProjectId to vcmail.config.json (same value as in Firebase console) and re-run npx vcmail, or enable the API in Google Cloud Console.\n'
        )
      );
    }
    return;
  }

  try {
    await execa('gcloud', ['--version'], { stdio: 'pipe' });
  } catch {
    console.log(
      chalk.yellow(
        '⚠️  gcloud CLI not found on PATH. npx vcmail does not install the Google Cloud SDK; install it separately and ensure `gcloud` is on PATH for this process.\n'
      )
    );
    console.log(
      chalk.cyan(
        '   If you just installed gcloud, open a new terminal tab or restart your IDE so PATH updates; this Node process cannot pick up installers that only modify future shell sessions.\n'
      )
    );
    console.log(chalk.cyan('   Install: https://cloud.google.com/sdk/docs/install'));
    console.log(
      chalk.cyan(
        `   Or enable in console: https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=${encodeURIComponent(
          projectId
        )}\n`
      )
    );
    return;
  }

  const spinner = ora(`Ensuring Google Calendar API is enabled for project ${projectId}...`).start();
  try {
    await execa(
      'gcloud',
      ['services', 'enable', 'calendar-json.googleapis.com', '--project', projectId],
      { stdio: 'pipe' }
    );
    spinner.succeed(chalk.green(`Google Calendar API enabled (or already enabled) for project ${projectId}`));
  } catch (err) {
    spinner.fail('Could not enable Google Calendar API via gcloud');
    const msg = err.stderr?.toString() || err.message || String(err);
    console.log(chalk.yellow(msg));
    console.log(
      chalk.cyan(
        `   Check gcloud auth (gcloud auth login) and permissions, or enable manually: https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=${encodeURIComponent(
          projectId
        )}\n`
      )
    );
  }
}

async function gatherConfiguration(existingConfig, skipPrompts = false) {
  // Only prompt for essential values: domain, webmailDomain, and optionally ssmPrefix
  // Everything else is derived from domain or loaded from SSM
  
  const domain = existingConfig?.domain || '';
  const webmailDomain = existingConfig?.webmailDomain || existingConfig?.mailDomain || '';
  const ssmPrefix = existingConfig?.ssmPrefix || '';
  
  // Derive default ssmPrefix from domain if not provided
  const defaultSsmPrefix = domain ? deriveSSMPrefix(domain) : '';
  
  const questions = [
    {
      type: 'input',
      name: 'domain',
      message: 'Enter your domain name (e.g., example.com):',
      default: domain,
      validate: (input) => {
        if (!input || !input.match(/^[a-z0-9.-]+\.[a-z]{2,}$/i)) {
          return 'Please enter a valid domain name';
        }
        return true;
      }
    },
    {
      type: 'input',
      name: 'webmailDomain',
      message: 'Enter webmail subdomain (default: mail.<your-domain>):',
      default: (answers) => webmailDomain || `mail.${answers.domain || domain}`,
      validate: (input) => {
        if (!input || !input.match(/^[a-z0-9.-]+$/i)) {
          return 'Please enter a valid subdomain';
        }
        return true;
      }
    },
    {
      type: 'input',
      name: 'ssmPrefix',
      message: `Enter SSM parameter prefix (default: ${defaultSsmPrefix || 'derived from domain'}):`,
      default: (answers) => ssmPrefix || deriveSSMPrefix(answers.domain || domain),
      validate: (input) => {
        if (!input || !input.startsWith('/')) {
          return 'SSM prefix must start with / (e.g., /example-com/prod)';
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
      name: 'firebaseProjectId',
      message:
        'Enter your Firebase project ID (Firebase console → Project settings; same as the Google Cloud project ID for Calendar and other APIs). Leave blank to skip:',
      default: existingConfig?.firebaseProjectId || '',
      validate: (input) => {
        const s = String(input || '').trim();
        if (!s) return true;
        if (!/^[a-z0-9-]+$/i.test(s)) {
          return 'Use the project ID (letters, numbers, hyphens), not the display name';
        }
        return true;
      }
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
  const finalWebmailDomain = answers.webmailDomain || answers.mailDomain || `mail.${answers.domain}`;
  
  const firebaseProjectId = String(
    answers.firebaseProjectId || existingConfig?.firebaseProjectId || ''
  ).trim();
  // Only store essential values in config file
  return {
    domain: answers.domain,
    webmailDomain: finalWebmailDomain,
    ssmPrefix: answers.ssmPrefix || deriveSSMPrefix(answers.domain),
    awsRegion: answers.awsRegion || 'us-east-1',
    awsAccountId: awsIdentity.Account,
    timestamp: new Date().toISOString(),
    ...(firebaseProjectId ? { firebaseProjectId } : {}),
    ...(existingConfig?.googleOAuthClientId
      ? { googleOAuthClientId: existingConfig.googleOAuthClientId }
      : {}),
    // Note: Firebase API keys, CloudFront IDs, API endpoints, etc. are NOT stored here;
    // they are loaded from SSM or detected from Terraform outputs as needed.
  };
}

/**
 * Legacy rules reference per-domain Lambdas (e.g. *-mail-api); SES validates the ARN on create.
 * Point all Lambda actions at the shared VCMail Lambda (same region/account as the original ARN).
 */
function rewriteSesRuleLambdaActionsForSharedVcmail(rule) {
  const clone = JSON.parse(JSON.stringify(rule));
  const arnRe = /^arn:aws:lambda:([^:]+):(\d+):function:.+$/;
  if (!clone.Actions || !Array.isArray(clone.Actions)) {
    return clone;
  }
  for (const action of clone.Actions) {
    const arn = action.LambdaAction?.FunctionArn;
    if (typeof arn !== 'string') {
      continue;
    }
    const m = arn.match(arnRe);
    if (m) {
      const [, region, accountId] = m;
      action.LambdaAction.FunctionArn = `arn:aws:lambda:${region}:${accountId}:function:${SHARED_VCMAIL_LAMBDA_FUNCTION_NAME}`;
    }
  }
  return clone;
}

/**
 * Rule object for SES PutReceiptRule (subset of Describe fields).
 */
function sanitizeSesReceiptRuleForPut(rule) {
  const keys = ['Name', 'Enabled', 'TlsPolicy', 'Recipients', 'Actions', 'ScanEnabled'];
  const out = {};
  for (const k of keys) {
    if (rule[k] !== undefined && rule[k] !== null) {
      out[k] = rule[k];
    }
  }
  return out;
}

/**
 * If the active rule set still uses the legacy *-incoming-email name, move traffic to
 * VCMAIL_SES_RULE_SET_NAME: copy rules if the canonical set is empty, or if it already has rules
 * (partial prior run) add only missing rules, then activate canonical and delete the legacy set.
 */
async function migrateLegacySesRuleSetToCanonical() {
  await loadESModules();
  const canonical = VCMAIL_SES_RULE_SET_NAME;
  let activeName;
  try {
    const { stdout } = await execa('aws', ['ses', 'describe-active-receipt-rule-set', '--output', 'json'], {
      stdio: 'pipe'
    });
    const parsed = JSON.parse(stdout);
    activeName = parsed.Metadata?.Name;
  } catch (error) {
    const msg = `${error.message || ''}\n${error.stderr || ''}`;
    if (msg.includes('RuleSetDoesNotExist')) {
      return false;
    }
    throw error;
  }
  if (!activeName || activeName === canonical) {
    return false;
  }
  if (!activeName.endsWith('-incoming-email')) {
    console.log(
      chalk.cyan(
        `ℹ️  Active SES rule set "${activeName}" is not named *-incoming-email; leaving it unchanged (not migrating to ${canonical}).`
      )
    );
    return false;
  }

  const spinner = ora(`Renaming multiproject SES rule set "${activeName}" → "${canonical}" (copy rules, switch active, remove legacy)...`).start();
  try {
    const { stdout: oldSetJson } = await execa(
      'aws',
      ['ses', 'describe-receipt-rule-set', '--rule-set-name', activeName, '--output', 'json'],
      { stdio: 'pipe' }
    );
    const oldSet = JSON.parse(oldSetJson);
    const rules = oldSet.Rules || [];
    if (rules.length === 0) {
      spinner.stop();
      console.log(chalk.yellow(`Legacy rule set "${activeName}" has no rules; skipping migration.`));
      return false;
    }

    let canRules = [];
    let describeCanonicalOk = false;
    try {
      const { stdout: canJson } = await execa(
        'aws',
        ['ses', 'describe-receipt-rule-set', '--rule-set-name', canonical, '--output', 'json'],
        { stdio: 'pipe' }
      );
      canRules = JSON.parse(canJson).Rules || [];
      describeCanonicalOk = true;
    } catch (e) {
      if (!String(e.stderr || e.message).includes('RuleSetDoesNotExist')) {
        throw e;
      }
    }

    // Partial migration: "vcmail_rule_set" already has rules — add any missing from legacy, activate, remove legacy.
    if (describeCanonicalOk && canRules.length > 0) {
      console.log(
        chalk.cyan(
          `   "${canonical}" already has ${canRules.length} rule(s); completing migration from "${activeName}".`
        )
      );
      const canonicalNames = new Set(canRules.map((r) => r.Name));
      const missingFromLegacy = rules.filter((r) => !canonicalNames.has(r.Name));
      if (missingFromLegacy.length > 0) {
        console.log(
          chalk.cyan(
            `   Adding ${missingFromLegacy.length} rule(s) that exist in "${activeName}" but not in "${canonical}".`
          )
        );
        console.log(
          chalk.cyan(
            `   Receipt rules will use shared Lambda ${SHARED_VCMAIL_LAMBDA_FUNCTION_NAME} (replacing per-domain function ARNs).`
          )
        );
        let afterName = canRules[canRules.length - 1]?.Name;
        for (const legacyRule of missingFromLegacy) {
          const rule = rewriteSesRuleLambdaActionsForSharedVcmail(legacyRule);
          const body = {
            RuleSetName: canonical,
            Rule: sanitizeSesReceiptRuleForPut(rule)
          };
          if (afterName) {
            body.After = afterName;
          }
          await execa('aws', ['ses', 'create-receipt-rule', '--cli-input-json', JSON.stringify(body)], {
            stdio: 'pipe'
          });
          afterName = rule.Name;
        }
      }

      await execa('aws', ['ses', 'set-active-receipt-rule-set', '--rule-set-name', canonical], { stdio: 'pipe' });

      for (const rule of rules) {
        await execa(
          'aws',
          ['ses', 'delete-receipt-rule', '--rule-set-name', activeName, '--rule-name', rule.Name],
          { stdio: 'pipe' }
        );
      }
      await execa('aws', ['ses', 'delete-receipt-rule-set', '--rule-set-name', activeName], { stdio: 'pipe' });

      spinner.succeed(chalk.green(`SES is now using "${canonical}"; legacy set "${activeName}" removed.`));
      return true;
    }

    try {
      await execa('aws', ['ses', 'create-receipt-rule-set', '--rule-set-name', canonical], { stdio: 'pipe' });
    } catch (e) {
      if (!String(e.stderr || e.message).includes('AlreadyExists')) {
        throw e;
      }
    }

    console.log(
      chalk.cyan(
        `   Receipt rules will use shared Lambda ${SHARED_VCMAIL_LAMBDA_FUNCTION_NAME} (replacing per-domain function ARNs from the legacy set).`
      )
    );

    for (let i = 0; i < rules.length; i++) {
      const rule = rewriteSesRuleLambdaActionsForSharedVcmail(rules[i]);
      const body = {
        RuleSetName: canonical,
        Rule: sanitizeSesReceiptRuleForPut(rule)
      };
      if (i > 0) {
        body.After = rules[i - 1].Name;
      }
      await execa('aws', ['ses', 'create-receipt-rule', '--cli-input-json', JSON.stringify(body)], {
        stdio: 'pipe'
      });
    }

    await execa('aws', ['ses', 'set-active-receipt-rule-set', '--rule-set-name', canonical], { stdio: 'pipe' });

    for (const rule of rules) {
      await execa(
        'aws',
        ['ses', 'delete-receipt-rule', '--rule-set-name', activeName, '--rule-name', rule.Name],
        { stdio: 'pipe' }
      );
    }
    await execa('aws', ['ses', 'delete-receipt-rule-set', '--rule-set-name', activeName], { stdio: 'pipe' });

    spinner.succeed(chalk.green(`SES receipt rule set is now active as "${canonical}" (migrated from "${activeName}")`));
    return true;
  } catch (err) {
    spinner.fail('SES rule set migration failed');
    const msg = err.stderr?.toString() || err.message || String(err);
    console.log(chalk.yellow(msg));
    throw err;
  }
}

/**
 * Sets sharedRuleSetName / activeRuleSetName for terraform.tfvars.
 * Pre-init: pass useTerraformStateShow false (uses local state file + migratedFromLegacy).
 * Post-init: pass useTerraformStateShow true for authoritative terraform state show.
 */
async function applySesRuleSetConfigAlignment(config, detectionResult, opts = {}) {
  const { useTerraformStateShow = false, migratedFromLegacy = false } = opts;
  const canonical = VCMAIL_SES_RULE_SET_NAME;
  if (!detectionResult?.ruleSetName) {
    delete config.sharedRuleSetName;
    delete config.activeRuleSetName;
    return;
  }
  if (detectionResult.ruleSetName !== canonical) {
    const computedConfig = getConfigWithDefaults(config);
    const legacyProjectSet = `${computedConfig.projectName}-incoming-email`;
    if (detectionResult.ruleSetName === legacyProjectSet) {
      config.activeRuleSetName = detectionResult.ruleSetName;
      delete config.sharedRuleSetName;
    } else {
      config.sharedRuleSetName = detectionResult.ruleSetName;
      config.activeRuleSetName = detectionResult.ruleSetName;
    }
    return;
  }
  config.activeRuleSetName = canonical;
  // Site stack never manages the canonical rule set; `.vcmail-terraform-account` does. Always use shared_rule_set_name in site tfvars.
  config.sharedRuleSetName = canonical;
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
    
    // Canonical multiproject rule set (fixed name for all domains)
    if (activeRuleSetName && activeRuleSetName !== 'None' && activeRuleSetName === VCMAIL_SES_RULE_SET_NAME) {
      return {
        ruleSetName: activeRuleSetName,
        ruleExists,
        ruleExistsForDomain,
        existingRules
      };
    }
    
    // Legacy VCMail rule set name pattern (pre–vcmail_rule_set); migrate on init, not here
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

async function initializeTerraform(config, skipPrompts = false) {
  let sesSpinner;
  let siteInitSpinner;
  let importSpinner;
  try {
    await fs.ensureDir(TERRAFORM_DIR);

    sesSpinner = ora('Checking SES configuration (migration + active rule set)...').start();
    const migratedFromLegacy = await migrateLegacySesRuleSetToCanonical();
    const detectionResult = await detectExistingRuleSet(config);

    if (detectionResult.ruleSetName) {
      const computedConfig = getConfigWithDefaults(config);
      console.log(chalk.green(`✓ Found active SES receipt rule set: ${detectionResult.ruleSetName}`));
      if (detectionResult.existingRules && detectionResult.existingRules.length > 0) {
        const existingDomains = detectionResult.existingRules
          .map(r => {
            const recipients = r.Recipients || [];
            return recipients.length > 0 ? recipients[0] : 'unknown';
          })
          .filter(d => d !== 'unknown')
          .join(', ');
        if (existingDomains) {
          console.log(chalk.cyan(`   Domains with rules in this set: ${existingDomains}`));
        }
        console.log(chalk.cyan(`   Your domain ${computedConfig.domain} will use this rule set (see terraform.tfvars).`));
      }
      if (detectionResult.ruleExists) {
        console.log(chalk.yellow(`⚠️  Rule "${computedConfig.projectName}-email-rule" already exists in the active rule set`));
        console.log(chalk.cyan(`   Will import existing rule instead of creating a new one`));
      } else if (detectionResult.ruleExistsForDomain) {
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
      console.log(
        chalk.blue(
          `ℹ️  No active VCMail-compatible SES rule set found. This project may create "${VCMAIL_SES_RULE_SET_NAME}".`
        )
      );
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
          console.log(
            chalk.yellow(
              `\n   Legacy *-incoming-email sets are migrated to "${VCMAIL_SES_RULE_SET_NAME}" on the next successful npx vcmail init.`
            )
          );
        }
      } catch {
        // Ignore list errors - not critical
      }
    }

    sesSpinner.succeed('SES configuration ready');
    sesSpinner = null;

    await applySesRuleSetConfigAlignment(config, detectionResult, {
      useTerraformStateShow: false,
      migratedFromLegacy
    });
    
    const configPath = path.join(process.cwd(), CONFIG_FILE);
    if (await fs.pathExists(configPath)) {
      await fs.writeJson(configPath, config, { spaces: 2 });
    }

    await initializeTerraformAccount(config, skipPrompts);

    await generateTerraformFiles(config);

    siteInitSpinner = ora('Initializing site Terraform (.vcmail-terraform)...').start();
    await execa('terraform', ['init'], {
      cwd: TERRAFORM_DIR,
      stdio: 'pipe'
    });
    siteInitSpinner.succeed('Site Terraform initialized');
    siteInitSpinner = null;
    
    await applySesRuleSetConfigAlignment(config, detectionResult, {
      useTerraformStateShow: true,
      migratedFromLegacy: false
    });
    
    if (await fs.pathExists(configPath)) {
      await fs.writeJson(configPath, config, { spaces: 2 });
    }

    // Post-init alignment can set or clear sharedRuleSetName; tfvars must match or Terraform and
    // discoverSESImports disagree (stale owner tfvars + secondary config → skipped imports + AlreadyExists).
    await generateTerraformFiles(config);

    importSpinner = ora('Importing existing site resources into Terraform state...').start();
    await importExistingResourcesParallel(config);
    importSpinner.succeed('Site Terraform state aligned with existing resources');
    importSpinner = null;
  } catch (error) {
    if (sesSpinner) sesSpinner.fail('Terraform initialization failed');
    if (siteInitSpinner) siteInitSpinner.fail('Site Terraform init failed');
    if (importSpinner) importSpinner.fail('Terraform import step failed');
    throw error;
  }
}

/**
 * Parallel discovery and sequential import of existing resources
 * This optimizes performance by running AWS API calls in parallel,
 * then executing Terraform imports sequentially (Terraform state is not thread-safe)
 */
async function importExistingResourcesParallel(config) {
  const importQueue = [];
  let isProcessingQueue = false;
  let allDiscoveriesComplete = false;
  
  // Function to process the import queue sequentially
  const processImportQueue = async () => {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    
    while (importQueue.length > 0 || !allDiscoveriesComplete) {
      if (importQueue.length > 0) {
        const op = importQueue.shift();
        try {
          console.log(chalk.cyan(`   ${op.message}...`));
          await execa('terraform', ['import', op.resource, op.importId], {
            cwd: op.terraformCwd || TERRAFORM_DIR,
            stdio: 'pipe'
          });
          console.log(chalk.green(`✓ ${op.successMessage}`));
        } catch (importError) {
          const importErrText = execaCombinedErrorText(importError);
          if (importErrText.includes('already managed')) {
            console.log(chalk.green(`✓ ${op.alreadyManagedMessage || op.successMessage}`));
          } else if (
            importErrText.includes('does not exist') ||
            importErrText.includes('404') ||
            importErrText.includes('NoSuchBucket')
          ) {
            // Resource doesn't exist, skip silently
          } else {
            // Other error - log but don't fail
            if (process.env.DEBUG) {
              console.log(chalk.yellow(`   Could not import ${op.resource}: ${importErrText.split('\n')[0]}`));
            }
          }
        }
      } else {
        // Queue is empty but discoveries might still be running - wait a bit
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    
    isProcessingQueue = false;
  };
  
  // Start processing queue immediately (it will wait for items)
  const queueProcessor = processImportQueue();
  
  // Run all discovery operations in parallel
  // As each completes, add its imports to the queue
  const discoveryPromises = [
    discoverRoute53Imports(config).then(result => {
      if (result && result.length > 0) {
        importQueue.push(...result);
      }
      return { type: 'Route53', count: result.length };
    }).catch(err => {
      if (process.env.DEBUG) {
        console.log(chalk.yellow(`Debug: Route53 discovery failed: ${err.message}`));
      }
      return { type: 'Route53', count: 0 };
    }),
    discoverSESImports(config).then(result => {
      if (result && result.length > 0) {
        importQueue.push(...result);
      }
      return { type: 'SES', count: result.length };
    }).catch(err => {
      if (process.env.DEBUG) {
        console.log(chalk.yellow(`Debug: SES discovery failed: ${err.message}`));
      }
      return { type: 'SES', count: 0 };
    }),
    discoverS3Imports(config).then(result => {
      if (result && result.length > 0) {
        importQueue.push(...result);
      }
      return { type: 'S3', count: result.length };
    }).catch(err => {
      if (process.env.DEBUG) {
        console.log(chalk.yellow(`Debug: S3 discovery failed: ${err.message}`));
      }
      return { type: 'S3', count: 0 };
    }),
    discoverCloudFrontImports(config).then(result => {
      if (result && result.length > 0) {
        importQueue.push(...result);
      }
      return { type: 'CloudFront', count: result.length };
    }).catch(err => {
      if (process.env.DEBUG) {
        console.log(chalk.yellow(`Debug: CloudFront discovery failed: ${err.message}`));
      }
      return { type: 'CloudFront', count: 0 };
    })
  ];
  
  // Wait for all discoveries to complete
  await Promise.all(discoveryPromises);
  allDiscoveriesComplete = true;
  
  // Wait for queue processor to finish processing all imports
  await queueProcessor;

  await ensureSiteSesReceiptRuleInTerraformState(config);
}

/**
 * After parallel imports, guarantee the shared Lambda execution role is tracked in state.
 * Avoids false "already in state" logs (stderr not in execa message) and races with concurrent terraform CLI calls.
 */
async function ensureSharedLambdaIamRoleInTerraformState() {
  const tfDir = TERRAFORM_ACCOUNT_DIR;
  const roleName = SHARED_VCMAIL_LAMBDA_IAM_ROLE_NAME;
  const resource = 'aws_iam_role.lambda_email_processor';
  try {
    await execa('aws', ['iam', 'get-role', '--role-name', roleName], {
      cwd: tfDir,
      stdio: 'pipe'
    });
  } catch {
    return;
  }
  try {
    await execa('terraform', ['state', 'show', resource], {
      cwd: tfDir,
      stdio: 'pipe'
    });
    return;
  } catch {
    // Role exists in AWS but not in state — import below
  }
  console.log(chalk.cyan(`   Ensuring shared IAM role is in Terraform state (${roleName})...`));
  try {
    await execa('terraform', ['import', resource, roleName], {
      cwd: tfDir,
      stdio: 'pipe'
    });
    console.log(chalk.green(`✓ Imported shared IAM role ${roleName}`));
  } catch (e) {
    const et = execaCombinedErrorText(e);
    if (et.includes('already managed')) {
      console.log(chalk.green(`✓ Shared IAM role ${roleName} already in Terraform state`));
      return;
    }
    console.log(
      chalk.yellow(`   Could not import shared IAM role into state: ${et.split('\n').filter(Boolean).slice(0, 2).join(' ')}`)
    );
  }
}

/**
 * Pre-account-apply: VCMail-api often already exists (legacy site stack or manual deploy).
 * Import into account state so Terraform does not try CreateFunction (409).
 */
async function ensureSharedLambdaFunctionInTerraformState() {
  const tfDir = TERRAFORM_ACCOUNT_DIR;
  const name = SHARED_VCMAIL_LAMBDA_FUNCTION_NAME;
  const addr = 'aws_lambda_function.email_processor';
  try {
    await execa('aws', ['lambda', 'get-function', '--function-name', name], {
      cwd: tfDir,
      stdio: 'pipe'
    });
  } catch {
    return;
  }
  try {
    await execa('terraform', ['state', 'show', addr], { cwd: tfDir, stdio: 'pipe' });
    return;
  } catch {
    // exists in AWS, not in state
  }
  console.log(chalk.cyan(`   Ensuring shared Lambda ${name} is in account Terraform state...`));
  try {
    await execa('terraform', ['import', addr, name], { cwd: tfDir, stdio: 'pipe' });
    console.log(chalk.green(`✓ Imported shared Lambda ${name} (account stack)`));
  } catch (e) {
    const et = execaCombinedErrorText(e);
    if (et.includes('already managed')) {
      console.log(chalk.green(`✓ Shared Lambda ${name} already in account Terraform state`));
      return;
    }
    console.log(
      chalk.yellow(
        `   Could not import shared Lambda into account state: ${et.split('\n').filter(Boolean).slice(0, 2).join(' ')}`
      )
    );
  }
}

const LAMBDA_SES_PERMISSION_STATEMENT_ID = 'AllowExecutionFromSES';

/**
 * SES→Lambda permission is often already on VCMail-api; import so apply does not duplicate it.
 */
async function ensureLambdaSesPermissionInTerraformState() {
  const tfDir = TERRAFORM_ACCOUNT_DIR;
  const fn = SHARED_VCMAIL_LAMBDA_FUNCTION_NAME;
  const addr = 'aws_lambda_permission.ses';
  let policyDoc = null;
  try {
    const { stdout } = await execa(
      'aws',
      ['lambda', 'get-policy', '--function-name', fn, '--output', 'json'],
      { cwd: tfDir, stdio: 'pipe' }
    );
    const outer = JSON.parse(stdout);
    if (!outer.Policy) return;
    policyDoc = typeof outer.Policy === 'string' ? JSON.parse(outer.Policy) : outer.Policy;
  } catch {
    return;
  }
  const stmts = policyDoc.Statement;
  const list = Array.isArray(stmts) ? stmts : stmts ? [stmts] : [];
  const hasSesInvoke = list.some((s) => {
    const sid = s.Sid || s.sid;
    if (sid === LAMBDA_SES_PERMISSION_STATEMENT_ID) return true;
    const principal = s.Principal;
    const svc =
      typeof principal === 'object' && principal !== null && !Array.isArray(principal)
        ? principal.Service || principal.service
        : null;
    const actions = Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];
    return (
      svc === 'ses.amazonaws.com' &&
      actions.some((a) => String(a).includes('lambda:InvokeFunction') || String(a) === 'lambda:InvokeFunction')
    );
  });
  if (!hasSesInvoke) return;
  try {
    await execa('terraform', ['state', 'show', addr], { cwd: tfDir, stdio: 'pipe' });
    return;
  } catch {
    // import
  }
  console.log(chalk.cyan(`   Ensuring SES Lambda permission is in account Terraform state (${fn})...`));
  const importId = `${fn}/${LAMBDA_SES_PERMISSION_STATEMENT_ID}`;
  try {
    await execa('terraform', ['import', addr, importId], { cwd: tfDir, stdio: 'pipe' });
    console.log(chalk.green(`✓ Imported ${addr} (account stack)`));
  } catch (e) {
    const et = execaCombinedErrorText(e);
    if (et.includes('already managed')) {
      console.log(chalk.green(`✓ ${addr} already in account Terraform state`));
      return;
    }
    console.log(
      chalk.yellow(`   Could not import Lambda SES permission: ${et.split('\n').filter(Boolean).slice(0, 2).join(' ')}`)
    );
  }
}

/** Canonical SES rule set + active binding live only in the account stack state. */
async function ensureAccountSesRuleSetInTerraformState() {
  const tfDir = TERRAFORM_ACCOUNT_DIR;
  const canonical = VCMAIL_SES_RULE_SET_NAME;
  let rules = [];
  try {
    const { stdout } = await execa(
      'aws',
      ['ses', 'describe-receipt-rule-set', '--rule-set-name', canonical, '--output', 'json'],
      { cwd: tfDir, stdio: 'pipe' }
    );
    rules = JSON.parse(stdout).Rules || [];
  } catch (e) {
    const t = execaCombinedErrorText(e);
    if (!t.includes('RuleSetDoesNotExist') && process.env.DEBUG) {
      console.log(chalk.yellow(`Debug: ensure account SES describe ${canonical}: ${t.split('\n')[0]}`));
    }
    return;
  }

  const ruleSetAddr = 'aws_ses_receipt_rule_set.main';
  if (!(await terraformStateHasAddress(ruleSetAddr, tfDir))) {
    console.log(chalk.cyan(`   Ensuring SES rule set ${canonical} is in account Terraform state...`));
    try {
      await execa('terraform', ['import', ruleSetAddr, canonical], {
        cwd: tfDir,
        stdio: 'pipe'
      });
      console.log(chalk.green(`✓ Imported SES rule set ${canonical} (account stack)`));
    } catch (e) {
      const et = execaCombinedErrorText(e);
      if (et.includes('already managed')) {
        console.log(chalk.green(`✓ SES rule set ${canonical} already in account Terraform state`));
      } else {
        console.log(
          chalk.yellow(`   Could not import SES rule set (account): ${et.split('\n').filter(Boolean).slice(0, 2).join(' ')}`)
        );
      }
    }
  }

  let activeIsCanonical = false;
  try {
    const { stdout } = await execa(
      'aws',
      ['ses', 'describe-active-receipt-rule-set', '--output', 'json'],
      { cwd: tfDir, stdio: 'pipe' }
    );
    activeIsCanonical = JSON.parse(stdout).Metadata?.Name === canonical;
  } catch {
    // ignore
  }

  const activeAddr = 'aws_ses_active_receipt_rule_set.main';
  if (activeIsCanonical && !(await terraformStateHasAddress(activeAddr, tfDir))) {
    console.log(chalk.cyan(`   Ensuring active SES rule set ${canonical} is in account Terraform state...`));
    try {
      await execa('terraform', ['import', activeAddr, canonical], {
        cwd: tfDir,
        stdio: 'pipe'
      });
      console.log(chalk.green(`✓ Imported active SES rule set ${canonical} (account stack)`));
    } catch (e) {
      const et = execaCombinedErrorText(e);
      if (et.includes('already managed')) {
        console.log(chalk.green(`✓ Active SES rule set already in account Terraform state`));
      } else {
        console.log(
          chalk.yellow(`   Could not import active SES rule set (account): ${et.split('\n').filter(Boolean).slice(0, 2).join(' ')}`)
        );
      }
    }
  }
}

/** Per-domain SES receipt rule lives in the site stack. */
async function ensureSiteSesReceiptRuleInTerraformState(config) {
  const tfDir = TERRAFORM_DIR;
  const canonical = config.sharedRuleSetName || VCMAIL_SES_RULE_SET_NAME;
  const computedConfig = getConfigWithDefaults(config);
  const ruleName = `${computedConfig.projectName}-email-rule`;
  let rules = [];
  try {
    const { stdout } = await execa(
      'aws',
      ['ses', 'describe-receipt-rule-set', '--rule-set-name', canonical, '--output', 'json'],
      { cwd: tfDir, stdio: 'pipe' }
    );
    rules = JSON.parse(stdout).Rules || [];
  } catch {
    return;
  }
  const receiptRuleAddr = 'aws_ses_receipt_rule.main';
  const receiptImportId = `${canonical}:${ruleName}`;
  if (rules.some((r) => r.Name === ruleName) && !(await terraformStateHasAddress(receiptRuleAddr, tfDir))) {
    console.log(chalk.cyan(`   Ensuring SES receipt rule ${ruleName} is in site Terraform state...`));
    try {
      await execa('terraform', ['import', receiptRuleAddr, receiptImportId], {
        cwd: tfDir,
        stdio: 'pipe'
      });
      console.log(chalk.green(`✓ Imported SES receipt rule ${ruleName}`));
    } catch (e) {
      const et = execaCombinedErrorText(e);
      if (et.includes('already managed')) {
        console.log(chalk.green(`✓ SES receipt rule ${ruleName} already in Terraform state`));
      } else {
        console.log(
          chalk.yellow(`   Could not import SES receipt rule: ${et.split('\n').filter(Boolean).slice(0, 2).join(' ')}`)
        );
      }
    }
  }
}

async function terraformStateHasAddress(addr, cwd = TERRAFORM_DIR) {
  try {
    await execa('terraform', ['state', 'show', addr], {
      cwd,
      stdio: 'pipe'
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Discovers Route53 records that need to be imported
 * Returns array of import operations (does not execute them)
 */
async function discoverRoute53Imports(config) {
  const imports = [];
  
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
      zoneId = zoneId.replace(/^\/hostedzone\//, '');
      
      if (!zoneId || zoneId === 'None') {
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
        return imports;
      }
    } catch (error) {
      return imports;
    }
    
    const mailDomain = config.webmailDomain || config.mailDomain || `mail.${config.domain}`;
    
    const recordsToCheck = [
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
    
    // Check all records in parallel
    const recordChecks = recordsToCheck.map(async (record) => {
      try {
        const { stdout: listStdout } = await execa('aws', [
          'route53', 'list-resource-record-sets',
          '--hosted-zone-id', zoneId,
          '--query', `ResourceRecordSets[?Name=='${record.name}.' && Type=='${record.type}']`,
          '--output', 'json'
        ], { cwd: TERRAFORM_DIR, stdio: 'pipe' });
        
        const records = JSON.parse(listStdout);
        if (records && records.length > 0) {
          return {
            resource: record.resource,
            importId: `${zoneId}_${record.name}_${record.type}`,
            message: `Attempting to import existing ${record.description}`,
            successMessage: `Imported existing ${record.description}: ${record.name}`,
            alreadyManagedMessage: `${record.description} already in Terraform state`
          };
        }
      } catch (error) {
        // Record doesn't exist or error checking - skip
      }
      return null;
    });
    
    const results = await Promise.all(recordChecks);
    imports.push(...results.filter(op => op !== null));
  } catch (error) {
    // Non-critical - return empty array
  }
  
  return imports;
}

/**
 * Discovers SES resources that need to be imported
 * Returns array of import operations (does not execute them)
 */
async function discoverSESImports(config) {
  const imports = [];

  try {
    const computedConfig = getConfigWithDefaults(config);
    const canonical = VCMAIL_SES_RULE_SET_NAME;
    const ruleName = `${computedConfig.projectName}-email-rule`;
    const ruleSetName = config.sharedRuleSetName || canonical;

    try {
      const { stdout: rulesJson } = await execa(
        'aws',
        ['ses', 'describe-receipt-rule-set', '--rule-set-name', ruleSetName, '--output', 'json'],
        { cwd: TERRAFORM_DIR, stdio: 'pipe' }
      );

      const rules = JSON.parse(rulesJson);
      const ruleExists = rules.Rules?.some((r) => r.Name === ruleName);

      if (ruleExists) {
        imports.push({
          resource: 'aws_ses_receipt_rule.main',
          importId: `${ruleSetName}:${ruleName}`,
          message: `Attempting to import existing SES receipt rule: ${ruleName}`,
          successMessage: `Imported SES receipt rule: ${ruleName}`,
          alreadyManagedMessage: `SES receipt rule already in Terraform state`
        });
      }
    } catch {
      // Rule set or rule missing — skip
    }
  } catch {
    // Non-critical
  }

  return imports;
}

/**
 * Discovers S3 buckets that need to be imported
 * Returns array of import operations (does not execute them)
 */
async function discoverS3Imports(config) {
  const imports = [];
  
  try {
    const computedConfig = getConfigWithDefaults(config);
    const bucketsToCheck = [
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
    
    // Check all buckets in parallel
    const bucketChecks = bucketsToCheck.map(async (bucket) => {
      try {
        await execa('aws', [
          's3api', 'head-bucket',
          '--bucket', bucket.bucketName
        ], { cwd: TERRAFORM_DIR, stdio: 'pipe' });
        
        // Bucket exists
        return {
          resource: bucket.resource,
          importId: bucket.bucketName,
          message: `Attempting to import existing ${bucket.description}`,
          successMessage: `Imported existing ${bucket.description}: ${bucket.bucketName}`,
          alreadyManagedMessage: `${bucket.description} already in Terraform state`
        };
      } catch (error) {
        // Bucket doesn't exist - skip
        return null;
      }
    });
    
    const results = await Promise.all(bucketChecks);
    imports.push(...results.filter(op => op !== null));
  } catch (error) {
    // Non-critical - return empty array
  }
  
  return imports;
}

/**
 * Discovers CloudFront distributions that need to be imported
 * Returns array of import operations (does not execute them)
 */
async function discoverCloudFrontImports(config) {
  const imports = [];
  
  try {
    const mailDomain = config.webmailDomain || config.mailDomain || `mail.${config.domain}`;
    
    const { stdout } = await execa('aws', [
      'cloudfront', 'list-distributions',
      '--query', 'DistributionList.Items[*].{Id:Id,Aliases:Aliases.Items}',
      '--output', 'json'
    ], { cwd: TERRAFORM_DIR, stdio: 'pipe' });
    
    const distributions = JSON.parse(stdout);
    const matchingDistribution = distributions.find(dist => 
      dist.Aliases && dist.Aliases.includes(mailDomain)
    );
    
    if (matchingDistribution) {
      // Don't log here during discovery - log during import phase for consistency
      imports.push({
        resource: 'aws_cloudfront_distribution.webmail',
        importId: matchingDistribution.Id,
        message: `Attempting to import existing CloudFront distribution for ${mailDomain}`,
        successMessage: `Imported existing CloudFront distribution: ${matchingDistribution.Id}`,
        alreadyManagedMessage: `CloudFront distribution already in Terraform state`
      });
    }
  } catch (error) {
    // Non-critical - return empty array
  }
  
  return imports;
}

/**
 * If the shared VCMail Lambda IAM role already exists in AWS (another machine, partial apply,
 * or first project in the account) but is not in Terraform state, queue a terraform import.
 * One API/Lambda services all domains; the role name is fixed in main.tf.
 */
async function discoverSharedLambdaIamRoleImports(config) {
  const imports = [];
  const roleName = SHARED_VCMAIL_LAMBDA_IAM_ROLE_NAME;
  try {
    await execa('aws', ['iam', 'get-role', '--role-name', roleName], {
      cwd: TERRAFORM_ACCOUNT_DIR,
      stdio: 'pipe'
    });
  } catch {
    return imports;
  }
  // Do not skip based on `terraform state show` here: it can race with other imports in the same
  // parallel discovery + queue flow and miss state. `ensureSharedLambdaIamRoleInTerraformState` runs after the queue.
  imports.push({
    resource: 'aws_iam_role.lambda_email_processor',
    importId: roleName,
    terraformCwd: TERRAFORM_ACCOUNT_DIR,
    message: `Importing shared IAM role ${roleName} (account Terraform workspace)`,
    successMessage: `Imported shared IAM role ${roleName}`,
    alreadyManagedMessage: `Shared IAM role ${roleName} already in Terraform state`
  });
  return imports;
}

/**
 * SES rule set + active binding for the account stack only (not site).
 */
async function discoverAccountSesStackImports() {
  const imports = [];
  const canonical = VCMAIL_SES_RULE_SET_NAME;
  const tf = TERRAFORM_ACCOUNT_DIR;
  let canonicalExists = false;
  let activeIsCanonical = false;
  try {
    await execa(
      'aws',
      ['ses', 'describe-receipt-rule-set', '--rule-set-name', canonical, '--output', 'json'],
      { cwd: tf, stdio: 'pipe' }
    );
    canonicalExists = true;
  } catch {
    return imports;
  }
  imports.push({
    resource: 'aws_ses_receipt_rule_set.main',
    importId: canonical,
    terraformCwd: tf,
    message: `Importing canonical SES rule set ${canonical} (account stack)`,
    successMessage: `Imported SES rule set ${canonical}`,
    alreadyManagedMessage: `SES rule set ${canonical} already in account Terraform state`
  });
  try {
    const { stdout: activeJson } = await execa(
      'aws',
      ['ses', 'describe-active-receipt-rule-set', '--output', 'json'],
      { cwd: tf, stdio: 'pipe' }
    );
    activeIsCanonical = JSON.parse(activeJson).Metadata?.Name === canonical;
  } catch {
    // ignore
  }
  if (activeIsCanonical) {
    imports.push({
      resource: 'aws_ses_active_receipt_rule_set.main',
      importId: canonical,
      terraformCwd: tf,
      message: `Importing active SES rule set ${canonical} (account stack)`,
      successMessage: `Imported active SES rule set ${canonical}`,
      alreadyManagedMessage: `Active SES rule set already in account Terraform state`
    });
  }
  return imports;
}

/**
 * Import shared IAM + canonical SES into `.vcmail-terraform-account` before account apply.
 */
async function importAccountSharedResourcesParallel(config) {
  const importQueue = [];
  let isProcessingQueue = false;
  let allDiscoveriesComplete = false;
  const processImportQueue = async () => {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    while (importQueue.length > 0 || !allDiscoveriesComplete) {
      if (importQueue.length > 0) {
        const op = importQueue.shift();
        try {
          console.log(chalk.cyan(`   ${op.message}...`));
          await execa('terraform', ['import', op.resource, op.importId], {
            cwd: op.terraformCwd || TERRAFORM_ACCOUNT_DIR,
            stdio: 'pipe'
          });
          console.log(chalk.green(`✓ ${op.successMessage}`));
        } catch (importError) {
          const importErrText = execaCombinedErrorText(importError);
          if (importErrText.includes('already managed')) {
            console.log(chalk.green(`✓ ${op.alreadyManagedMessage || op.successMessage}`));
          } else if (
            importErrText.includes('does not exist') ||
            importErrText.includes('404') ||
            importErrText.includes('NoSuchBucket')
          ) {
            // skip
          } else if (process.env.DEBUG) {
            console.log(chalk.yellow(`   Could not import ${op.resource}: ${importErrText.split('\n')[0]}`));
          }
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    isProcessingQueue = false;
  };
  const queueProcessor = processImportQueue();
  const discoveryPromises = [
    discoverSharedLambdaIamRoleImports(config).then((result) => {
      if (result && result.length > 0) importQueue.push(...result);
      return { count: result.length };
    }),
    discoverAccountSesStackImports().then((result) => {
      if (result && result.length > 0) importQueue.push(...result);
      return { count: result.length };
    })
  ];
  await Promise.all(discoveryPromises);
  allDiscoveriesComplete = true;
  await queueProcessor;
  await ensureSharedLambdaIamRoleInTerraformState();
  await ensureSharedLambdaFunctionInTerraformState();
  await ensureLambdaSesPermissionInTerraformState();
  await ensureAccountSesRuleSetInTerraformState();
}

async function generateTerraformAccountFiles(config) {
  await fs.ensureDir(TERRAFORM_ACCOUNT_DIR);
  const computedConfig = getConfigWithDefaults(config);
  const files = ['main.tf', 'variables.tf', 'outputs.tf', 'provider.tf'];
  for (const file of files) {
    const sourceFile = path.join(PACKAGE_TERRAFORM_ACCOUNT_DIR, file);
    const destFile = path.join(TERRAFORM_ACCOUNT_DIR, file);
    if (await fs.pathExists(sourceFile)) {
      await fs.copy(sourceFile, destFile);
    }
  }
  const tfvars = `aws_region = "${computedConfig.awsRegion}"
`;
  await fs.writeFile(path.join(TERRAFORM_ACCOUNT_DIR, 'terraform.tfvars'), tfvars);
}

async function runTerraformAccountApply(config, skipPrompts = false) {
  await generateTerraformAccountFiles(config);
  if (!(await fs.pathExists(path.join(TERRAFORM_ACCOUNT_DIR, '.terraform')))) {
    const reinit = ora('terraform init (account stack — providers may download on first run)...').start();
    await execa('terraform', ['init'], { cwd: TERRAFORM_ACCOUNT_DIR, stdio: 'pipe' });
    reinit.succeed('Account Terraform init complete');
  }
  if (await fs.pathExists(path.join(TERRAFORM_ACCOUNT_DIR, '.terraform'))) {
    await ensureSharedLambdaIamRoleInTerraformState();
    await ensureSharedLambdaFunctionInTerraformState();
    await ensureLambdaSesPermissionInTerraformState();
    await ensureAccountSesRuleSetInTerraformState();
  }
  let proceed = true;
  if (!skipPrompts) {
    await loadESModules();
    const result = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'proceed',
        message: 'Apply account-level VCMail stack (shared Lambda, IAM, canonical SES rule set)?',
        default: true
      }
    ]);
    proceed = result.proceed;
  } else {
    console.log(chalk.cyan('  Proceeding with account-level Terraform apply (skip prompts mode)...'));
  }
  if (!proceed) {
    console.log(chalk.yellow('Account Terraform apply skipped.'));
    return;
  }
  const accountPlanPath = path.join(TERRAFORM_ACCOUNT_DIR, 'account-tfplan');
  try {
    await fs.remove(accountPlanPath);
  } catch {
    // ignore
  }
  console.log(
    chalk.dim(
      '   Account terraform plan can take several minutes (the archive provider zips vcmail-lambda-package).'
    )
  );
  const planSpin = ora('terraform plan (account stack)...').start();
  await execa('terraform', ['plan', '-out=account-tfplan'], {
    cwd: TERRAFORM_ACCOUNT_DIR,
    stdio: 'pipe'
  });
  planSpin.succeed('Account Terraform plan complete');

  const applySpin = ora('terraform apply (account stack)...').start();
  await execa('terraform', ['apply', 'account-tfplan'], {
    cwd: TERRAFORM_ACCOUNT_DIR,
    stdio: 'pipe'
  });
  applySpin.succeed('Account stack apply complete');
  console.log(chalk.green('✓ Account-level Terraform apply complete'));
}

async function initializeTerraformAccount(config, skipPrompts = false) {
  console.log(chalk.blue('\n📦 VCMail account stack (.vcmail-terraform-account)\n'));
  await generateTerraformAccountFiles(config);
  const accInitSpin = ora('terraform init (account stack — first run may download providers)...').start();
  await execa('terraform', ['init'], { cwd: TERRAFORM_ACCOUNT_DIR, stdio: 'pipe' });
  accInitSpin.succeed('Account Terraform initialized');

  console.log(
    chalk.cyan(
      '   Importing / ensuring IAM and SES in account Terraform state (each import may take 30-90s)...'
    )
  );
  await importAccountSharedResourcesParallel(config);
  console.log(chalk.green('✓ Account Terraform state aligned with AWS (IAM, SES)\n'));

  await runTerraformAccountApply(config, skipPrompts);
}

/**
 * Attempts to import existing Route53 records into Terraform state
 * This prevents errors when records already exist from previous setups
 * @deprecated Use importExistingResourcesParallel instead for better performance
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

/**
 * Attempts to import existing SES resources into Terraform state
 * @deprecated Use importExistingResourcesParallel instead for better performance
 */
async function importExistingSESResources(config) {
  try {
    const computedConfig = getConfigWithDefaults(config);
    const canonical = VCMAIL_SES_RULE_SET_NAME;
    const ruleSetName = config.sharedRuleSetName || canonical;
    const ruleName = `${computedConfig.projectName}-email-rule`;

    try {
      console.log(chalk.cyan(`   Checking if rule "${ruleName}" exists in rule set "${ruleSetName}"...`));

      try {
        const { stdout: rulesJson } = await execa(
          'aws',
          ['ses', 'describe-receipt-rule-set', '--rule-set-name', ruleSetName, '--output', 'json'],
          { cwd: TERRAFORM_DIR, stdio: 'pipe' }
        );

        const rules = JSON.parse(rulesJson);
        const ruleExists = rules.Rules?.some((r) => r.Name === ruleName);

        if (ruleExists) {
          console.log(chalk.yellow(`⚠️  Rule "${ruleName}" already exists in rule set "${ruleSetName}"`));
          console.log(chalk.cyan(`   Attempting to import receipt rule into site Terraform state...`));

          try {
            await execa(
              'terraform',
              ['import', 'aws_ses_receipt_rule.main', `${ruleSetName}:${ruleName}`],
              { cwd: TERRAFORM_DIR, stdio: 'pipe' }
            );
            console.log(chalk.green(`✓ Imported SES receipt rule: ${ruleName}`));
          } catch (importError) {
            console.log(chalk.yellow(`   Could not import rule (may already be in state): ${importError.message.split('\n')[0]}`));
          }
        }
      } catch (error) {
        if (process.env.DEBUG) {
          console.log(chalk.yellow(`Debug: Could not check existing rules: ${error.message.split('\n')[0]}`));
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
 * @deprecated Use importExistingResourcesParallel instead for better performance
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
 * @deprecated Use importExistingResourcesParallel instead for better performance
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
      console.log(chalk.cyan(`   Attempting to import existing CloudFront distribution for ${mailDomain}...`));
      
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
  const tfvars = await generateTfvars(config);
  await fs.writeFile(path.join(TERRAFORM_DIR, 'terraform.tfvars'), tfvars);
}

async function runTerraform(config, skipPrompts = false) {
  let spinner = ora('Preparing account-level Terraform (.vcmail-terraform-account)...').start();

  try {
    await generateTerraformAccountFiles(config);
    if (!(await fs.pathExists(path.join(TERRAFORM_ACCOUNT_DIR, '.terraform')))) {
      spinner.text = 'terraform init (account stack; first run may download providers)...';
      await execa('terraform', ['init'], { cwd: TERRAFORM_ACCOUNT_DIR, stdio: 'pipe' });
    }
    if (await fs.pathExists(path.join(TERRAFORM_ACCOUNT_DIR, '.terraform'))) {
      spinner.text = 'Checking account Terraform state (Lambda, IAM, SES)...';
      await ensureSharedLambdaIamRoleInTerraformState();
      await ensureSharedLambdaFunctionInTerraformState();
      await ensureLambdaSesPermissionInTerraformState();
      await ensureAccountSesRuleSetInTerraformState();
    }
    const accountPlanFile = path.join(TERRAFORM_ACCOUNT_DIR, 'account-tfplan');
    try {
      await fs.remove(accountPlanFile);
    } catch {
      // ignore
    }
    spinner.text =
      'terraform plan (account stack; can take several minutes while Lambda package is zipped)...';
    console.log(
      chalk.dim(
        '   Tip: the account module archives vcmail-lambda-package on every plan — a large node_modules slows this.'
      )
    );
    await execa('terraform', ['plan', '-out=account-tfplan'], {
      cwd: TERRAFORM_ACCOUNT_DIR,
      stdio: 'pipe'
    });
    spinner.succeed('Account Terraform plan created');

    let accountProceed = true;
    if (!skipPrompts) {
      const accountConfirm = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'proceed',
          message: 'Apply account-level VCMail stack (shared Lambda, IAM, canonical SES rule set)?',
          default: true
        }
      ]);
      accountProceed = accountConfirm.proceed;
    } else {
      console.log(chalk.cyan('  Proceeding with account-level Terraform apply (skip prompts mode)...'));
    }
    if (!accountProceed) {
      console.log(
        chalk.yellow(
          'Account Terraform apply skipped. The site stack needs the shared Lambda in AWS — run setup again and apply the account stack, or run Terraform in .vcmail-terraform-account.'
        )
      );
      return;
    }
    spinner = ora('Applying account-level Terraform...').start();
    await execa('terraform', ['apply', 'account-tfplan'], {
      cwd: TERRAFORM_ACCOUNT_DIR,
      stdio: 'pipe'
    });
    spinner.succeed('Account-level Terraform changes applied');

    spinner = ora('Planning site Terraform...').start();
    if (await fs.pathExists(path.join(TERRAFORM_DIR, 'terraform.tfvars'))) {
      await generateTerraformFiles(config);
    }

    if (await fs.pathExists(path.join(TERRAFORM_DIR, '.terraform'))) {
      await ensureSiteSesReceiptRuleInTerraformState(config);
    }

    await execa('terraform', ['plan', '-out=tfplan'], {
      cwd: TERRAFORM_DIR,
      stdio: 'pipe'
    });

    spinner.succeed('Site Terraform plan created');

    let proceed = true;

    if (!skipPrompts) {
      const result = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'proceed',
          message: 'Do you want to apply these site (per-domain) changes?',
          default: true
        }
      ]);
      proceed = result.proceed;
    } else {
      console.log(chalk.cyan('  Proceeding with site Terraform apply (skip prompts mode)...'));
    }

    if (!proceed) {
      console.log(chalk.yellow('Site Terraform apply cancelled.'));
      return;
    }

    spinner = ora('Applying site Terraform changes...').start();
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

        spinner.fail(`Terraform apply failed - ${errorType} already exist in AWS`);
        console.log(chalk.yellow(`\n⚠️  Some ${errorType} already exist and Terraform tried to create them again.`));
        console.log(chalk.cyan('\n   Attempting to import existing resources and retry...'));
        
        try {
          // Try to import the resources and retry (use parallel import for better performance)
          await importExistingResourcesParallel(config);

          const tfplanPath = path.join(TERRAFORM_DIR, 'tfplan');
          try {
            await fs.remove(tfplanPath);
          } catch {
            // ignore missing or locked tfplan
          }

          // Do not use `terraform apply tfplan` here: a saved plan can still contain CreateRole even after
          // imports refresh state, which reproduces EntityAlreadyExists. A single apply recomputes the plan.
          console.log(chalk.cyan('   Retrying Terraform apply with a freshly computed plan (after imports)...'));
          ({ stdout } = await execa('terraform', ['apply', '-auto-approve'], {
            cwd: TERRAFORM_DIR,
            stdio: 'pipe'
          }));
          
          const importRetryLabel = errorType.toLowerCase();
          spinner.succeed(`Terraform changes applied (after importing existing ${importRetryLabel})`);
          applySucceeded = true;
        } catch (retryError) {
          const failLabel = errorType.toLowerCase();
          spinner.fail(`Terraform apply failed even after importing ${failLabel}`);
          console.log(chalk.yellow(`\n⚠️  Could not automatically fix ${failLabel} conflicts.`));
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
          console.log(
            chalk.cyan(
              `   Then: cd ${TERRAFORM_DIR} && terraform apply -auto-approve   (or: terraform plan -out=tfplan && terraform apply tfplan after deleting any stale tfplan)`
            )
          );
          throw retryError;
        }
      } else if (error.message && error.message.includes('Cannot delete active rule set')) {
        spinner.fail('Terraform apply failed - cannot delete active SES rule set');
        console.log(chalk.yellow('\n⚠️  The SES rule set is currently active and cannot be deleted.'));
        console.log(chalk.yellow('   This usually means the rule set already exists and Terraform is trying to recreate it.'));
        console.log(chalk.cyan('\n   To fix this, you can:'));
        const computedConfig = getConfigWithDefaults(config);
        console.log(
          chalk.cyan(
            `   1. Import the existing rule set into the account stack: cd ${TERRAFORM_ACCOUNT_DIR} && terraform import aws_ses_receipt_rule_set.main ${VCMAIL_SES_RULE_SET_NAME}`
          )
        );
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
  const ssm = new SSMClient({ region: config.awsRegion });
  const computedConfig = getConfigWithDefaults(config);
  const paramName = `${computedConfig.ssmPrefix}/firebase_service_account`;
  
  try {
    // Check if the parameter already exists
    await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: false }));
    console.log(chalk.green(`✓ Firebase service account parameter already exists in SSM: ${paramName}`));
    return;
  } catch (error) {
    if (error.name === 'ParameterNotFound' || error.code === 'ParameterNotFound') {
      // Parameter doesn't exist, show warning
      console.log(chalk.yellow('\n⚠️  Please manually upload Firebase service account to SSM:'));
      console.log(chalk.cyan(`  Parameter: ${paramName}`));
      console.log(chalk.cyan(`  Use: aws ssm put-parameter --name "${paramName}" --type "SecureString" --value "$(cat firebase-service-account.json)"`));
    } else {
      // Other error (permissions, etc.) - show warning anyway but mention the error
      console.log(chalk.yellow(`\n⚠️  Could not verify Firebase service account parameter (${error.name || error.code}):`));
      console.log(chalk.cyan(`  Parameter: ${paramName}`));
      console.log(chalk.yellow(`  If the parameter exists, you can ignore this warning.`));
      console.log(chalk.cyan(`  To create it: aws ssm put-parameter --name "${paramName}" --type "SecureString" --value "$(cat firebase-service-account.json)"`));
    }
  }
}

async function setupFirebaseAuthProviders(config) {
  try {
    // Load Firebase config from SSM before setting up auth
    const firebaseConfig = await loadFirebaseConfigFromSSM(config);
    if (!firebaseConfig || !firebaseConfig.projectId) {
      throw new Error(`Firebase configuration not found in SSM. Please ensure Firebase service account is stored at ${getConfigWithDefaults(config).ssmPrefix}/firebase_service_account`);
    }
    
    // Merge Firebase config into config object for setupFirebaseAuth
    const configWithFirebase = {
      ...config,
      firebaseProjectId: firebaseConfig.projectId,
      firebaseDatabaseURL: firebaseConfig.databaseURL
    };
    
    const { setupFirebaseAuth } = require('../scripts/setup-firebase-auth');
    await setupFirebaseAuth(configWithFirebase);
  } catch (error) {
    // Don't fail setup if auth provider setup fails - it's optional
    console.log(chalk.yellow(`\n⚠️  Could not automatically setup Firebase Authentication providers: ${error.message}`));
    console.log(chalk.cyan('   You can enable them manually in the Firebase Console:'));
    
    // Try to get project ID for helpful error message
    let projectId = 'your-project-id';
    try {
      const firebaseConfig = await loadFirebaseConfigFromSSM(config);
      if (firebaseConfig?.projectId) {
        projectId = firebaseConfig.projectId;
      }
    } catch (e) {
      // Ignore - we'll use default
    }
    
    console.log(chalk.cyan(`   1. Go to https://console.firebase.google.com/`));
    console.log(chalk.cyan(`   2. Select project: ${projectId}`));
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
    
    // Load Firebase config from SSM
    const firebaseConfig = await loadFirebaseConfigFromSSM(config);
    if (!firebaseConfig || !firebaseConfig.databaseURL) {
      throw new Error(`Firebase configuration not found in SSM. Please ensure Firebase service account is stored at ${getConfigWithDefaults(config).ssmPrefix}/firebase_service_account`);
    }
    
    // Get Firebase database URL from SSM config
    const databaseURL = firebaseConfig.databaseURL;
    console.log(`Using Firebase database URL: ${databaseURL}`);
    
    // Initialize Firebase with SSM prefix for loading service account
    const computedConfig = getConfigWithDefaults(config);
    firebaseApp = await firebaseInitializer.get(databaseURL, computedConfig.ssmPrefix);
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

/**
 * Writes Firebase web client fields resolved for the S3 build onto config so vcmail.config.json
 * keeps discovered values (SSM/service account remains authoritative for the private key).
 */
function mergeDiscoveredFirebaseClientIntoConfig(config, firebaseConfigFromSSM, firebaseConfigObj) {
  const bad = new Set(['', 'your-api-key', 'your-firebase-api-key', 'your-firebase-project-id']);
  const pid = firebaseConfigObj.projectId;
  if (pid && !bad.has(pid)) {
    config.firebaseProjectId = pid;
  }
  if (firebaseConfigObj.databaseURL) {
    config.firebaseDatabaseURL = firebaseConfigObj.databaseURL;
  }
  if (firebaseConfigObj.apiKey && !bad.has(firebaseConfigObj.apiKey)) {
    config.firebaseApiKey = firebaseConfigObj.apiKey;
  }
  if (firebaseConfigFromSSM?.firebaseAppId) {
    config.firebaseAppId = firebaseConfigFromSSM.firebaseAppId;
  } else if (firebaseConfigObj.appId && firebaseConfigObj.appId !== pid) {
    config.firebaseAppId = firebaseConfigObj.appId;
  }
  if (firebaseConfigObj.messagingSenderId) {
    config.firebaseMessagingSenderId = firebaseConfigObj.messagingSenderId;
  }
}

async function deployWebmailClient(config) {
  const spinner = ora('Deploying webmail client...').start();
  
  try {
    const configPath = path.join(process.cwd(), CONFIG_FILE);
    if (await fs.pathExists(configPath)) {
      const fileConfig = await fs.readJson(configPath);
      if (fileConfig.googleOAuthClientId) {
        config.googleOAuthClientId = fileConfig.googleOAuthClientId;
      }
      // firebaseProjectId is the Google Cloud project ID for gcloud/APIs (e.g. Calendar); same ID as in Firebase console.
      if (fileConfig.firebaseProjectId) {
        config.firebaseProjectId = String(fileConfig.firebaseProjectId).trim();
      }
      for (const k of ['firebaseApiKey', 'firebaseAppId', 'firebaseMessagingSenderId', 'firebaseDatabaseURL']) {
        if (fileConfig[k]) {
          config[k] = fileConfig[k];
        }
      }
      if (fileConfig.firebaseApiKey || fileConfig.firebaseDatabaseURL) {
        console.log(chalk.green(`✓ Loaded Firebase web client fields from ${CONFIG_FILE}`));
      }
    }
    
    await deployS3Assets(config);
    
    try {
      await fs.writeJson(configPath, config, { spaces: 2 });
      console.log(chalk.green(`✓ Saved Firebase web client settings to ${CONFIG_FILE}`));
    } catch (writeErr) {
      console.log(chalk.yellow(`⚠ Could not update ${CONFIG_FILE}: ${writeErr.message}`));
    }
    
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
  const s3 = new S3Client({ region: computedConfig.awsRegion });
  
  // Verify bucket exists
  try {
    await s3.send(new HeadBucketCommand({ Bucket: webmailBucket }));
    console.log(chalk.green(`✓ Verified S3 bucket exists: ${webmailBucket}`));
  } catch (error) {
    if (error.name === 'NotFound' || error.code === 'NotFound' || error.statusCode === 404 || error.name === '403' || error.code === '403') {
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
  
  // Load Firebase config from SSM
  let firebaseConfigFromSSM = null;
  try {
    // Try to discover Firebase config (including API key) from SSM
    const { discoverFirebaseConfig } = require('../scripts/discover-firebase-config');
    firebaseConfigFromSSM = await discoverFirebaseConfig(config);
  } catch (error) {
    console.log(chalk.yellow(`⚠️  Warning: Could not load Firebase config from SSM: ${error.message}`));
    console.log(chalk.cyan(`   Firebase config will be loaded from SSM at runtime if available.`));
  }
  
  // Prepare Firebase config object - use discovered config or fallback to config file (backward compatibility)
  const firebaseProjectId = firebaseConfigFromSSM?.firebaseProjectId || config.firebaseProjectId || '';
  const firebaseDatabaseURL = firebaseConfigFromSSM?.firebaseDatabaseURL || config.firebaseDatabaseURL || '';
  const firebaseApiKey = firebaseConfigFromSSM?.firebaseApiKey || config.firebaseApiKey || process.env.FIREBASE_API_KEY || '';
  
  const firebaseConfigObj = {
    apiKey: firebaseApiKey,
    authDomain: firebaseProjectId ? `${firebaseProjectId}.firebaseapp.com` : '',
    databaseURL: firebaseDatabaseURL,
    projectId: firebaseProjectId,
    storageBucket: firebaseProjectId ? `${firebaseProjectId}.appspot.com` : '',
    messagingSenderId: firebaseConfigFromSSM?.firebaseMessagingSenderId || config.firebaseMessagingSenderId || '',
    appId: firebaseConfigFromSSM?.firebaseAppId || config.firebaseAppId || firebaseProjectId
  };
  
  mergeDiscoveredFirebaseClientIntoConfig(config, firebaseConfigFromSSM, firebaseConfigObj);
  
  // Validate Firebase API key before deploying
  if (!firebaseApiKey || firebaseApiKey === 'your-api-key' || firebaseApiKey === 'your-firebase-api-key') {
    console.log(chalk.yellow(`⚠️  Warning: Firebase API key is missing or placeholder. Webmail authentication may not work.`));
    console.log(chalk.cyan(`   Firebase API key should be stored in SSM at ${getConfigWithDefaults(config).ssmPrefix}/firebase_api_key`));
    console.log(chalk.cyan(`   Or use the discover-firebase-config script to auto-discover it.`));
  } else {
    console.log(chalk.green(`✓ Using Firebase API key: ${firebaseApiKey.substring(0, 10)}...`));
  }
  
  // Log Firebase config for debugging (without exposing full API key)
  console.log(chalk.cyan(`✓ Firebase config:`));
  console.log(chalk.cyan(`   Project ID: ${firebaseConfigObj.projectId || 'MISSING'}`));
  console.log(chalk.cyan(`   API Key: ${firebaseConfigObj.apiKey ? firebaseConfigObj.apiKey.substring(0, 10) + '...' : 'MISSING'}`));
  console.log(chalk.cyan(`   Auth Domain: ${firebaseConfigObj.authDomain || 'MISSING'}`));
  
  // Inject VCMail configuration into HTML
  const webmailDomain = config.webmailDomain || config.mailDomain || `mail.${config.domain}`;
  const vcmailConfigObj = {
    domain: config.domain,
    webmailDomain: webmailDomain,
    apiEndpoint: '', // Empty string = use relative URLs (CloudFront handles routing)
    storageCacheKey: config.storageCacheKey || 'vcmail_email_cache',
    buildId: buildId,
    googleOAuthClientId: config.googleOAuthClientId || '',
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
  await s3.send(new PutObjectCommand({
    Bucket: webmailBucket,
    Key: 'index.html',
    Body: indexHtml,
    ContentType: 'text/html',
    CacheControl: 'no-cache, no-store, must-revalidate'
  }));
  
  console.log(chalk.green(`✓ Uploaded index.html to S3 (${(indexHtml.length / 1024).toFixed(2)} KB)`));
  
  // Upload favicon.ico
  const faviconPath = path.join(vcmailPackageDir, 'favicon.ico');
  if (await fs.pathExists(faviconPath)) {
    const faviconContent = await fs.readFile(faviconPath);
    await s3.send(new PutObjectCommand({
      Bucket: webmailBucket,
      Key: 'favicon.ico',
      Body: faviconContent,
      ContentType: 'image/x-icon',
      CacheControl: 'public, max-age=31536000' // Cache favicon for 1 year
    }));
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
          
          await s3.send(new PutObjectCommand({
            Bucket: webmailBucket,
            Key: s3Key,
            Body: content,
            ContentType: contentType,
            CacheControl: ext.match(/\.(webp|png|jpg|jpeg|gif|svg|ico|css)$/i) 
              ? 'public, max-age=31536000' // Cache static assets for 1 year
              : 'public, max-age=3600' // Cache other files for 1 hour
          }));
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
        buildId: buildId,
        googleOAuthClientId: config.googleOAuthClientId || ''
      };
      
      firebaseConfig = firebaseConfig.replace(
        /export const vcmailConfig = window\.VCMAIL_CONFIG \|\| \{[\s\S]*?\};/,
        `export const vcmailConfig = window.VCMAIL_CONFIG || ${JSON.stringify(vcmailConfigObjForJs, null, 2)};`
      );
      
      await s3.send(new PutObjectCommand({
        Bucket: webmailBucket,
        Key: 'src/firebaseConfig.js',
        Body: firebaseConfig,
        ContentType: 'application/javascript'
      }));
      
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
        
        const putParams = {
          Bucket: webmailBucket,
          Key: s3Key,
          Body: content,
          ContentType: contentType
        };
        if (ext.match(/\.(css|js)$/)) {
          putParams.CacheControl = 'public, max-age=31536000';
        }
        await s3.send(new PutObjectCommand(putParams));
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
  
  const cloudfront = new CloudFrontClient({});
  const callerReference = `vcmail-${Date.now()}`;
  const distributionId = config.cloudfrontDistributionId;
  
  const spinner = ora(`Invalidating CloudFront cache (${distributionId})...`).start();
  try {
    await cloudfront.send(new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: callerReference,
        Paths: {
          Quantity: 1,
          Items: ['/*']
        }
      }
    }));
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

/**
 * Load Firebase configuration from SSM
 * Returns { projectId, databaseURL } or null if not found
 */
async function loadFirebaseConfigFromSSM(config) {
  try {
    const computedConfig = getConfigWithDefaults(config);
    const ssm = new SSMClient({ region: computedConfig.awsRegion });
    
    // Try firebase_config parameter first
    try {
      const firebaseParamName = `${computedConfig.ssmPrefix}/firebase_config`;
      const result = await ssm.send(new GetParameterCommand({
        Name: firebaseParamName,
        WithDecryption: true
      }));
      
      if (result.Parameter?.Value) {
        const firebaseConfig = JSON.parse(result.Parameter.Value);
        return {
          projectId: firebaseConfig.projectId,
          databaseURL: firebaseConfig.databaseURL
        };
      }
    } catch (error) {
      if (!isParameterNotFound(error)) {
        console.warn(chalk.yellow(`Warning: Could not load firebase_config from SSM: ${error.message}`));
      }
    }
    
    // Fallback: load from firebase_service_account and construct config
    try {
      const serviceAccountParamName = `${computedConfig.ssmPrefix}/firebase_service_account`;
      const result = await ssm.send(new GetParameterCommand({
        Name: serviceAccountParamName,
        WithDecryption: true
      }));
      
      if (result.Parameter?.Value) {
        let paramValue = result.Parameter.Value.trim();
        let serviceAccount;
        
        // Parse service account JSON
        try {
          const parsed = JSON.parse(paramValue);
          if (typeof parsed === 'string') {
            try {
              const decoded = Buffer.from(parsed, 'base64').toString('utf-8');
              serviceAccount = JSON.parse(decoded);
            } catch (e) {
              serviceAccount = parsed;
            }
          } else {
            serviceAccount = parsed;
          }
        } catch (parseError) {
          try {
            const decoded = Buffer.from(paramValue, 'base64').toString('utf-8');
            serviceAccount = JSON.parse(decoded);
          } catch (base64Error) {
            throw new Error('Invalid Firebase service account JSON format');
          }
        }
        
        const projectId = serviceAccount.project_id;
        
        // Try to discover the actual database URL from Firebase API
        // This is more reliable than constructing it
        let databaseURL = null;
        try {
          const { discoverFirebaseConfig } = require('../scripts/discover-firebase-config');
          const tempConfig = {
            ...config,
            firebaseProjectId: projectId,
            ssmPrefix: computedConfig.ssmPrefix
          };
          const discoveredConfig = await discoverFirebaseConfig(tempConfig);
          if (discoveredConfig.firebaseDatabaseURL) {
            databaseURL = discoveredConfig.firebaseDatabaseURL;
            console.log(chalk.green(`✓ Discovered Firebase database URL: ${databaseURL}`));
          }
        } catch (discoverError) {
          // If discovery fails, try common formats
          if (process.env.DEBUG) {
            console.log(chalk.yellow(`Debug: Could not discover database URL from Firebase API: ${discoverError.message}`));
            console.log(chalk.yellow(`Debug: Will try common database URL formats`));
          }
        }
        
        // If discovery failed, try common formats
        // Modern projects: https://{projectId}-default-rtdb.firebaseio.com
        // Legacy projects: https://{projectId}.firebaseio.com
        if (!databaseURL) {
          // Try modern format first (most common for new projects)
          databaseURL = `https://${projectId}-default-rtdb.firebaseio.com`;
          console.log(chalk.yellow(`⚠ Using constructed database URL: ${databaseURL}`));
          console.log(chalk.yellow(`  If this fails, the database might use legacy format: https://${projectId}.firebaseio.com`));
        }
        
        const firebaseConfig = {
          projectId: projectId,
          databaseURL: databaseURL
        };
        
        // Store the discovered Firebase config in SSM for Lambda to use
        // This avoids needing discovery code in Lambda (which requires problematic dependencies)
        try {
          const firebaseConfigParamName = `${computedConfig.ssmPrefix}/firebase_config`;
          await ssm.send(new PutParameterCommand({
            Name: firebaseConfigParamName,
            Value: JSON.stringify(firebaseConfig),
            Type: 'SecureString',
            Overwrite: true,
            Description: `Firebase configuration for ${computedConfig.domain} (discovered automatically)`
          }));
          console.log(chalk.green(`✓ Stored Firebase config in SSM: ${firebaseConfigParamName}`));
        } catch (storeError) {
          console.log(chalk.yellow(`⚠ Could not store firebase_config in SSM: ${storeError.message}`));
          console.log(chalk.yellow(`  Lambda will construct database URL from service account if needed`));
        }
        
        return firebaseConfig;
      }
    } catch (error) {
      if (!isParameterNotFound(error)) {
        console.warn(chalk.yellow(`Warning: Could not load firebase_service_account from SSM: ${error.message}`));
      }
    }
    
    return null;
  } catch (error) {
    console.warn(chalk.yellow(`Warning: Error loading Firebase config from SSM: ${error.message}`));
    return null;
  }
}

async function generateTfvars(config) {
  const computedConfig = getConfigWithDefaults(config);
  
  // Load Firebase config from SSM
  const firebaseConfig = await loadFirebaseConfigFromSSM(config);
  if (!firebaseConfig) {
    throw new Error(`Firebase configuration not found in SSM at ${computedConfig.ssmPrefix}/firebase_config or ${computedConfig.ssmPrefix}/firebase_service_account. Please ensure Firebase service account is stored in SSM.`);
  }
  
  let tfvars = `domain                  = "${computedConfig.domain}"
project_name            = "${computedConfig.projectName}"
mail_domain             = "${computedConfig.webmailDomain}"
aws_region              = "${computedConfig.awsRegion}"
firebase_project_id     = "${firebaseConfig.projectId}"
firebase_database_url   = "${firebaseConfig.databaseURL}"
ssm_prefix              = "${computedConfig.ssmPrefix}"
s3_bucket_name          = "${computedConfig.s3BucketName}"
s3_webmail_bucket_name  = "${computedConfig.s3WebmailBucket}"
`;
  
  // Secondary projects only: omit when this workspace owns aws_ses_receipt_rule_set in Terraform.
  if (config.sharedRuleSetName) {
    tfvars += `shared_rule_set_name     = "${config.sharedRuleSetName}"
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
 * Adds .vcmail-terraform, .vcmail-terraform-account, and vcmail-lambda-package if missing.
 */
async function updateGitignore() {
  const gitignorePath = path.join(process.cwd(), '.gitignore');
  const entriesToAdd = ['.vcmail-terraform', '.vcmail-terraform-account', 'vcmail-lambda-package'];
  
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
    const expectedFunctionName = SHARED_VCMAIL_LAMBDA_FUNCTION_NAME;
    
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
      
      // Verify Lambda exists (no need to check domain-specific config since Lambda loads it from SSM)
      try {
        const lambda = new LambdaClient({ region: computedConfig.awsRegion });
        const { Configuration } = await lambda.send(new GetFunctionCommand({ FunctionName: functionName }));
        const lastModified = Configuration.LastModified
          ? new Date(Configuration.LastModified).toISOString()
          : null;
        console.log(chalk.green(`\n✓ Lambda "${functionName}" exists and is accessible`));
        if (lastModified) {
          console.log(chalk.cyan(`   Last updated: ${lastModified}`));
        }
      } catch (lambdaError) {
        console.log(chalk.yellow(`\n⚠️  Could not verify Lambda exists: ${lambdaError.message}`));
        return false;
      }
    }
    
    console.log(chalk.green(`\n✓ SES receipt rule "${expectedRuleName}" is correctly configured`));
    console.log(chalk.cyan(`   Rule points to shared Lambda "${expectedFunctionName}" which loads domain-specific config from SSM`));
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

