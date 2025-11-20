/**
 * VCMail Configuration Loader
 * Loads configuration from vcmail.config.json file
 */

const path = require('path');
const fs = require('fs-extra');

const CONFIG_FILE = 'vcmail.config.json';

let cachedConfig = null;

/**
 * Load configuration from vcmail.config.json
 * @param {string} projectRoot - Root directory of the project (defaults to process.cwd())
 * @returns {Object} Configuration object
 */
function loadConfig(projectRoot = process.cwd()) {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = path.join(projectRoot, CONFIG_FILE);

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Configuration file not found: ${CONFIG_FILE}\n` +
      `Please run 'npx vcmail' to create the configuration file.`
    );
  }

  try {
    const config = fs.readJsonSync(configPath);
    cachedConfig = config;
    return config;
  } catch (error) {
    throw new Error(`Failed to load configuration from ${CONFIG_FILE}: ${error.message}`);
  }
}

/**
 * Load configuration for browser/client-side use
 * Returns only the configuration needed for client-side code
 */
function loadClientConfig(projectRoot = process.cwd()) {
  const config = loadConfig(projectRoot);
  
  return {
    domain: config.domain,
    emailDomain: config.emailDomain || config.domain,
    mailDomain: config.mailDomain,
    apiEndpoint: config.apiEndpoint,
    firebaseProjectId: config.firebaseProjectId,
    firebaseDatabaseURL: config.firebaseDatabaseURL,
    storageCacheKey: config.storageCacheKey || 'vcmail_email_cache'
  };
}

/**
 * Clear cached configuration (useful for testing or reloading)
 */
function clearCache() {
  cachedConfig = null;
}

/**
 * Get configuration with defaults applied
 */
function getConfigWithDefaults(config = {}) {
  return {
    domain: config.domain || 'example.com',
    projectName: config.projectName || 'vcmail',
    awsRegion: config.awsRegion || 'us-east-1',
    mailDomain: config.mailDomain || `mail.${config.domain || 'example.com'}`,
    firebaseProjectId: config.firebaseProjectId || '',
    firebaseDatabaseURL: config.firebaseDatabaseURL || '',
    firebaseApiKey: config.firebaseApiKey || '',
    firebaseAppId: config.firebaseAppId || config.firebaseProjectId || '',
    firebaseMessagingSenderId: config.firebaseMessagingSenderId || '',
    awsAccountId: config.awsAccountId || '',
    ssmPrefix: config.ssmPrefix || `/${config.projectName || 'vcmail'}/prod`,
    s3BucketName: config.s3BucketName || `${config.projectName || 'vcmail'}-mail-inbox`,
    s3WebmailBucket: config.s3WebmailBucket || config.mailDomain || `mail.${config.domain || 'example.com'}`,
    cloudfrontDistributionId: config.cloudfrontDistributionId || '',
    cloudfrontDomainName: config.cloudfrontDomainName || '',
    apiEndpoint: config.apiEndpoint || '',
    storageCacheKey: config.storageCacheKey || 'vcmail_email_cache',
    emailDomain: config.emailDomain || config.domain || 'example.com'
  };
}

module.exports = {
  loadConfig,
  loadClientConfig,
  clearCache,
  getConfigWithDefaults,
  CONFIG_FILE
};

