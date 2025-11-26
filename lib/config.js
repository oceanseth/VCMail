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
    webmailDomain: config.webmailDomain || config.mailDomain || `mail.${config.domain || 'example.com'}`,
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
 * Sanitize domain name for use in AWS resource names
 * Replaces dots with hyphens and converts to lowercase
 */
function sanitizeDomainForAWS(domain) {
  if (!domain) return 'example-com';
  return domain.replace(/\./g, '-').toLowerCase();
}

/**
 * Derive project name from domain (for AWS resource naming)
 * Appends "-mail" to distinguish mail infrastructure projects
 */
function deriveProjectName(domain) {
  return `${sanitizeDomainForAWS(domain || 'example.com')}-mail`;
}

/**
 * Derive SSM prefix from domain
 */
function deriveSSMPrefix(domain) {
  return `/${sanitizeDomainForAWS(domain || 'example.com')}/prod`;
}

/**
 * Derive S3 bucket name for mail inbox from domain
 */
function deriveS3BucketName(domain) {
  return `${sanitizeDomainForAWS(domain || 'example.com')}-mail-inbox`;
}

/**
 * Get configuration with defaults applied
 * Derived values (projectName, ssmPrefix, s3BucketName, s3WebmailBucket) are computed from domain
 */
function getConfigWithDefaults(config = {}) {
  const domain = config.domain || 'example.com';
  // Support legacy mailDomain for backward compatibility
  const webmailDomain = config.webmailDomain || config.mailDomain || `mail.${domain}`;
  
  // Derive values from domain (not stored in config file)
  const projectName = deriveProjectName(domain);
  const ssmPrefix = deriveSSMPrefix(domain);
  const s3BucketName = deriveS3BucketName(domain);
  const s3WebmailBucket = webmailDomain; // Derived from webmailDomain
  
  return {
    domain: domain,
    projectName: projectName,
    awsRegion: config.awsRegion || 'us-east-1',
    webmailDomain: webmailDomain,
    firebaseProjectId: config.firebaseProjectId || '',
    firebaseDatabaseURL: config.firebaseDatabaseURL || '',
    firebaseApiKey: config.firebaseApiKey || '',
    firebaseAppId: config.firebaseAppId || config.firebaseProjectId || '',
    firebaseMessagingSenderId: config.firebaseMessagingSenderId || '',
    awsAccountId: config.awsAccountId || '',
    ssmPrefix: ssmPrefix,
    s3BucketName: s3BucketName,
    s3WebmailBucket: s3WebmailBucket,
    cloudfrontDistributionId: config.cloudfrontDistributionId || '',
    cloudfrontDomainName: config.cloudfrontDomainName || '',
    apiEndpoint: config.apiEndpoint || '',
    storageCacheKey: config.storageCacheKey || `${projectName}_email_cache`.replace(/[^a-zA-Z0-9_]/g, '_')
  };
}

module.exports = {
  loadConfig,
  loadClientConfig,
  clearCache,
  getConfigWithDefaults,
  sanitizeDomainForAWS,
  deriveProjectName,
  deriveSSMPrefix,
  deriveS3BucketName,
  CONFIG_FILE
};

