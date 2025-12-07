/**
 * Setup Firebase Authentication Providers
 * Enables Email/Password and Google Sign-In via Firebase Management REST API
 */

const AWS = require('aws-sdk');
const https = require('https');
const { loadConfig, getConfigWithDefaults, CONFIG_FILE } = require('../lib/config');
const path = require('path');
const fs = require('fs-extra');

// Use jsonwebtoken for JWT signing (lighter weight than google-auth-library)
let jwt;
try {
  jwt = require('jsonwebtoken');
} catch (e) {
  // jsonwebtoken not available - will try to use crypto module
  jwt = null;
}

/**
 * Get Firebase service account from SSM
 */
async function getFirebaseServiceAccount(config) {
  const ssm = new AWS.SSM({ region: config.awsRegion });
  const computedConfig = getConfigWithDefaults(config);
  const paramName = `${computedConfig.ssmPrefix}/firebase_service_account`;
  
  try {
    const result = await ssm.getParameter({
      Name: paramName,
      WithDecryption: true
    }).promise();
    
    if (!result?.Parameter?.Value) {
      throw new Error('Firebase service account not found in SSM');
    }
    
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
          serviceAccount = JSON.parse(parsed);
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
    
    return serviceAccount;
  } catch (error) {
    if (error.code === 'ParameterNotFound') {
      throw new Error(`Firebase service account not found in SSM at ${paramName}. Please upload it first.`);
    }
    throw error;
  }
}

/**
 * Get OAuth2 access token using service account
 */
async function getAccessToken(serviceAccount) {
  if (!jwt) {
    throw new Error('jsonwebtoken package is required. Install it with: npm install jsonwebtoken');
  }
  
  const now = Math.floor(Date.now() / 1000);
  
  const claim = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
    scope: 'https://www.googleapis.com/auth/cloud-platform'
  };
  
  // Sign JWT with service account private key
  const token = jwt.sign(claim, serviceAccount.private_key, {
    algorithm: 'RS256'
  });
  
  // Exchange JWT for access token
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: token
    });
    
    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.access_token) {
            resolve(response.access_token);
          } else {
            reject(new Error(`Failed to get access token: ${response.error || data}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse token response: ${e.message}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Add authorized domain to Firebase Authentication
 */
async function addAuthorizedDomain(projectId, accessToken, domain) {
  return new Promise((resolve, reject) => {
    // First get current config
    getAuthConfig(projectId, accessToken).then(currentConfig => {
      if (!currentConfig) {
        // Config doesn't exist yet - can't add domains
        reject(new Error('Authentication config not found. Please initialize Authentication in Firebase Console first.'));
        return;
      }
      
      const authorizedDomains = currentConfig.authorizedDomains || ['localhost'];
      
      // Check if domain already exists
      if (authorizedDomains.includes(domain)) {
        resolve({ alreadyExists: true });
        return;
      }
      
      // Add the new domain
      authorizedDomains.push(domain);
      
      // Update config with new authorized domains
      const updateMask = 'authorizedDomains';
      const patchData = JSON.stringify({
        authorizedDomains: authorizedDomains
      });
      
      const options = {
        hostname: 'identitytoolkit.googleapis.com',
        path: `/admin/v2/projects/${projectId}/config?updateMask=${updateMask}`,
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(patchData)
        }
      };
      
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode === 200 || res.statusCode === 204) {
              resolve(JSON.parse(data || '{}'));
            } else {
              const error = JSON.parse(data);
              reject(new Error(`Failed to add authorized domain: ${error.error?.message || data}`));
            }
          } catch (e) {
            if (res.statusCode === 200 || res.statusCode === 204) {
              resolve({});
            } else {
              reject(new Error(`Failed to parse add domain response: ${e.message}`));
            }
          }
        });
      });
      
      req.on('error', reject);
      req.write(patchData);
      req.end();
    }).catch(reject);
  });
}

/**
 * Get current Firebase auth config
 */
async function getAuthConfig(projectId, accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'identitytoolkit.googleapis.com',
      path: `/admin/v2/projects/${projectId}/config`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            const error = JSON.parse(data);
            const errorCode = error.error?.code || error.error?.status;
            const errorMessage = error.error?.message || data;
            
            // CONFIGURATION_NOT_FOUND means Authentication service isn't initialized yet
            // This is a valid state - return null instead of rejecting
            if (res.statusCode === 404 || errorCode === 404 || errorMessage.includes('CONFIGURATION_NOT_FOUND') || errorMessage.includes('NOT_FOUND')) {
              resolve(null); // Return null to indicate config doesn't exist yet
            } else {
              reject(new Error(`Failed to get auth config: ${errorMessage}`));
            }
          }
        } catch (e) {
          reject(new Error(`Failed to parse auth config response: ${e.message}`));
        }
      });
    });
    
    req.on('error', reject);
    req.end();
  });
}

/**
 * Get Google Identity Provider config
 * Checks both defaultSupportedIdpConfigs and oauthIdpConfigs
 */
async function getGoogleIdpConfig(projectId, accessToken) {
  return new Promise((resolve, reject) => {
    // First try defaultSupportedIdpConfigs (for default Google provider)
    const options = {
      hostname: 'identitytoolkit.googleapis.com',
      path: `/admin/v2/projects/${projectId}/defaultSupportedIdpConfigs/google.com`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const config = JSON.parse(data);
            resolve(config);
          } else if (res.statusCode === 404) {
            // Try oauthIdpConfigs instead (custom OAuth config)
            const oauthOptions = {
              hostname: 'identitytoolkit.googleapis.com',
              path: `/admin/v2/projects/${projectId}/oauthIdpConfigs/google.com`,
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
              }
            };
            
            const oauthReq = https.request(oauthOptions, (oauthRes) => {
              let oauthData = '';
              oauthRes.on('data', (chunk) => { oauthData += chunk; });
              oauthRes.on('end', () => {
                try {
                  if (oauthRes.statusCode === 200) {
                    resolve(JSON.parse(oauthData));
                  } else {
                    resolve(null); // Not configured yet
                  }
                } catch (e) {
                  resolve(null);
                }
              });
            });
            
            oauthReq.on('error', () => resolve(null));
            oauthReq.end();
          } else {
            const error = JSON.parse(data);
            reject(new Error(`Failed to get Google IdP config: ${error.error?.message || data}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse Google IdP config response: ${e.message}`));
        }
      });
    });
    
    req.on('error', reject);
    req.end();
  });
}

/**
 * Enable Email/Password authentication
 */
async function enableEmailPasswordAuth(projectId, accessToken) {
  return new Promise((resolve, reject) => {
    const updateMask = 'signIn.email.enabled';
    
    const patchData = JSON.stringify({
      signIn: {
        email: {
          enabled: true,
          passwordRequired: true
        }
      }
    });
    
    const options = {
      hostname: 'identitytoolkit.googleapis.com',
      path: `/admin/v2/projects/${projectId}/config?updateMask=${updateMask}`,
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(patchData)
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode === 200 || res.statusCode === 204) {
            resolve(JSON.parse(data || '{}'));
          } else {
            const error = JSON.parse(data);
            const errorMessage = error.error?.message || data;
            
            // If CONFIGURATION_NOT_FOUND, Authentication service needs to be initialized
            // This typically requires manual initialization in Firebase Console first
            if (res.statusCode === 404 || errorMessage.includes('CONFIGURATION_NOT_FOUND') || errorMessage.includes('NOT_FOUND')) {
              reject(new Error(`CONFIGURATION_NOT_FOUND: Firebase Authentication service is not initialized for this project. Please enable Authentication manually in Firebase Console first:\n\n1. Go to https://console.firebase.google.com/\n2. Select project: ${projectId}\n3. Go to Authentication\n4. Click "Get Started" to initialize Authentication\n5. Then run this script again`));
            } else {
              reject(new Error(`Failed to enable Email/Password: ${errorMessage}`));
            }
          }
        } catch (e) {
          if (res.statusCode === 200 || res.statusCode === 204) {
            resolve({});
          } else {
            reject(new Error(`Failed to parse Email/Password response: ${e.message}`));
          }
        }
      });
    });
    
    req.on('error', reject);
    req.write(patchData);
    req.end();
  });
}

/**
 * Enable Google Sign-In (default provider - uses Firebase's OAuth client)
 * Note: Google Sign-In requires OAuth setup which typically needs to be done manually
 * in Firebase Console first. This function attempts to enable it but may fail if
 * OAuth credentials aren't configured.
 */
async function enableGoogleSignIn(projectId, accessToken) {
  return new Promise((resolve, reject) => {
    // Google Sign-In uses the defaultSupportedIdpConfigs endpoint
    // However, it requires OAuth credentials which are typically set up in Console
    const patchData = JSON.stringify({
      enabled: true
    });
    
    const options = {
      hostname: 'identitytoolkit.googleapis.com',
      path: `/admin/v2/projects/${projectId}/defaultSupportedIdpConfigs/google.com`,
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(patchData)
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode === 200 || res.statusCode === 204) {
            resolve(JSON.parse(data || '{}'));
          } else {
            const error = JSON.parse(data);
            const errorMessage = error.error?.message || data;
            
            // If client_id is required, Google Sign-In needs manual setup
            if (errorMessage.includes('client_id') || errorMessage.includes('INVALID_CONFIG')) {
              reject(new Error(`Google Sign-In requires OAuth credentials setup. Please enable it manually in Firebase Console:\n\n1. Go to https://console.firebase.google.com/\n2. Select project: ${projectId}\n3. Go to Authentication > Sign-in method\n4. Click on Google\n5. Enable it and follow the OAuth setup wizard\n\nAlternatively, Google Sign-In can be enabled programmatically after OAuth credentials are configured.`));
            } else if (res.statusCode === 404) {
              // If 404, try creating it (but this will likely also fail without OAuth credentials)
              reject(new Error(`Google Sign-In configuration not found. Please enable it manually in Firebase Console first (Authentication > Sign-in method > Google).`));
            } else {
              reject(new Error(`Failed to enable Google Sign-In: ${errorMessage}`));
            }
          }
        } catch (e) {
          if (res.statusCode === 200 || res.statusCode === 204) {
            resolve({});
          } else {
            reject(new Error(`Failed to parse Google Sign-In response: ${e.message}`));
          }
        }
      });
    });
    
    req.on('error', reject);
    req.write(patchData);
    req.end();
  });
}

/**
 * Setup Firebase Authentication providers
 */
async function setupFirebaseAuth(config = null) {
  // Load ES modules dynamically
  const chalkModule = await import('chalk');
  const oraModule = await import('ora');
  const chalk = chalkModule.default || chalkModule;
  const ora = oraModule.default || oraModule;
  
  try {
    // Load config if not provided
    if (!config) {
      const configPath = path.join(process.cwd(), CONFIG_FILE);
      if (!await fs.pathExists(configPath)) {
        throw new Error(`Configuration file ${CONFIG_FILE} not found. Please run 'npx vcmail' first.`);
      }
      const fileConfig = await fs.readJson(configPath);
      config = getConfigWithDefaults(fileConfig);
    } else {
      config = getConfigWithDefaults(config);
    }
    
    if (!config.firebaseProjectId) {
      throw new Error('Firebase project ID is required');
    }
    
    const spinner = ora('Setting up Firebase Authentication providers...').start();
    
    try {
      // Get service account from SSM
      spinner.text = 'Retrieving Firebase service account from SSM...';
      const serviceAccount = await getFirebaseServiceAccount(config);
      
      // Get access token
      spinner.text = 'Authenticating with Google Cloud...';
      const accessToken = await getAccessToken(serviceAccount);
      
      // Check current auth config FIRST - we must verify state before updating
      spinner.text = 'Checking current authentication configuration...';
      let currentConfig = null;
      
      try {
        currentConfig = await getAuthConfig(config.firebaseProjectId, accessToken);
      } catch (error) {
        // Other errors - we cannot safely update without knowing current state
        spinner.fail('Could not read current authentication configuration');
        throw new Error(`Failed to retrieve current auth config: ${error.message}. Cannot safely enable providers without checking current state.`);
      }
      
      // currentConfig will be null if Authentication service isn't initialized yet
      // This is a valid state for new projects
      const configNotFound = currentConfig === null;
      
      if (configNotFound) {
        console.log(chalk.yellow(`\n⚠️  Authentication service not yet initialized for this project.`));
        console.log(chalk.cyan(`   This is normal for new projects. We'll enable it now.\n`));
      }
      
      // If config was found, verify we got a valid response
      if (currentConfig && typeof currentConfig !== 'object') {
        spinner.fail('Invalid authentication configuration response');
        throw new Error('Received invalid auth config response from Firebase API');
      }
      
      // Check if providers are already enabled (only if config exists)
      const emailEnabled = currentConfig?.signIn?.email?.enabled === true;
      
      // Check Google Sign-In via IdP config endpoint (not in main config)
      let googleEnabled = false;
      let googleConfig = null;
      if (currentConfig) {
        try {
          googleConfig = await getGoogleIdpConfig(config.firebaseProjectId, accessToken);
          googleEnabled = googleConfig?.enabled === true;
        } catch (googleError) {
          // Google might not be configured yet
          googleEnabled = false;
        }
      }
      
      // Log current state (only if config was found)
      if (!configNotFound) {
        console.log(chalk.cyan('\n   Current auth provider status:'));
        const emailStatus = emailEnabled ? chalk.green('Enabled') : chalk.yellow('Disabled');
        const googleStatus = googleEnabled ? chalk.green('Enabled') : chalk.yellow('Disabled');
        console.log(chalk.cyan(`   Email/Password: ${emailStatus}`));
        console.log(chalk.cyan(`   Google Sign-In: ${googleStatus}`));
        
        // If both are already enabled, skip update
        if (emailEnabled && googleEnabled) {
          spinner.succeed('Firebase Authentication providers are already enabled');
          console.log(chalk.green('\n✓ Email/Password authentication: Already enabled'));
          console.log(chalk.green('✓ Google Sign-In: Already enabled'));
          console.log(chalk.cyan('\n   No changes needed.'));
          return { success: true, alreadyEnabled: true };
        }
      }
      
      // Enable providers separately (they use different API endpoints)
      spinner.text = 'Enabling Email/Password authentication...';
      try {
        await enableEmailPasswordAuth(config.firebaseProjectId, accessToken);
        console.log(chalk.green('✓ Email/Password authentication enabled'));
      } catch (error) {
        spinner.fail('Failed to enable Email/Password');
        throw new Error(`Failed to enable Email/Password: ${error.message}`);
      }
      
      // Add webmail domain to authorized domains
      const webmailDomain = config.webmailDomain || config.mailDomain || `mail.${config.domain}`;
      spinner.text = `Adding authorized domain: ${webmailDomain}...`;
      try {
        const domainResult = await addAuthorizedDomain(config.firebaseProjectId, accessToken, webmailDomain);
        if (domainResult.alreadyExists) {
          console.log(chalk.green(`✓ Domain ${webmailDomain} already authorized`));
        } else {
          console.log(chalk.green(`✓ Added authorized domain: ${webmailDomain}`));
        }
      } catch (error) {
        spinner.warn('Failed to add authorized domain');
        console.log(chalk.yellow(`⚠️  Could not add authorized domain: ${error.message}`));
        console.log(chalk.cyan(`   Please add ${webmailDomain} manually in Firebase Console:`));
        console.log(chalk.cyan('   Authentication > Settings > Authorized domains'));
        // Don't fail - this is not critical for Email/Password auth
      }
      
      spinner.text = 'Enabling Google Sign-In...';
      try {
        await enableGoogleSignIn(config.firebaseProjectId, accessToken);
        console.log(chalk.green('✓ Google Sign-In enabled'));
      } catch (error) {
        spinner.warn('Failed to enable Google Sign-In');
        console.log(chalk.yellow(`⚠️  Could not enable Google Sign-In: ${error.message}`));
        console.log(chalk.cyan('   You may need to enable it manually in Firebase Console.'));
        // Don't fail completely - Email/Password is more critical
      }
      
      // Verify the update was successful by checking config again
      spinner.text = 'Verifying authentication providers were enabled...';
      let updatedConfig;
      let googleNowEnabled = false;
      let googleConfigAfterUpdate = null;
      
      try {
        updatedConfig = await getAuthConfig(config.firebaseProjectId, accessToken);
        const emailNowEnabled = updatedConfig?.signIn?.email?.enabled === true;
        
        // Check Google Sign-In via IdP config endpoint (not in main config)
        try {
          googleConfigAfterUpdate = await getGoogleIdpConfig(config.firebaseProjectId, accessToken);
          googleNowEnabled = googleConfigAfterUpdate?.enabled === true;
        } catch (googleError) {
          // Google might not be enabled yet, that's okay
          googleNowEnabled = false;
        }
        
        // Success if Email/Password is enabled (Google is optional)
        if (emailNowEnabled) {
          spinner.succeed('Firebase Authentication setup completed');
          console.log(chalk.green('\n✓ Email/Password authentication: Enabled'));
          
          if (googleNowEnabled) {
            console.log(chalk.green('✓ Google Sign-In: Enabled'));
            if (googleConfigAfterUpdate?.clientId) {
              console.log(chalk.green(`   OAuth Client ID: ${googleConfigAfterUpdate.clientId.substring(0, 20)}...`));
            }
          } else {
            console.log(chalk.yellow('⚠ Google Sign-In: Not enabled or OAuth not configured'));
            console.log(chalk.cyan('   Google Sign-In requires OAuth credentials setup in Firebase Console.'));
            console.log(chalk.cyan('   This is optional - Email/Password authentication is working.'));
          }
          
          return { success: true, alreadyEnabled: false };
        } else {
          // Email/Password is critical - fail if not enabled
          spinner.fail('Failed to verify Email/Password authentication');
          console.log(chalk.yellow(`\n⚠️  Email/Password authentication verification failed`));
          console.log(chalk.cyan('\n   Please check Firebase Console:'));
          console.log(chalk.cyan('   https://console.firebase.google.com/'));
          console.log(chalk.cyan(`   Project: ${config.firebaseProjectId}`));
          console.log(chalk.cyan('   Authentication > Sign-in method'));
          return { success: false, error: 'Email/Password verification failed' };
        }
      } catch (verifyError) {
        // Update might have succeeded but we can't verify
        spinner.warn('Update completed but could not verify');
        console.log(chalk.yellow(`\n⚠️  Could not verify auth providers were enabled: ${verifyError.message}`));
        console.log(chalk.cyan('\n   Please check Firebase Console to confirm:'));
        console.log(chalk.cyan('   https://console.firebase.google.com/'));
        console.log(chalk.cyan(`   Project: ${config.firebaseProjectId}`));
        console.log(chalk.cyan('   Authentication > Sign-in method'));
        return { success: false, error: 'Could not verify update', warning: true };
      }
    } catch (error) {
      spinner.fail('Failed to setup Firebase Authentication');
      
      // Provide helpful error messages
      if (error.message.includes('ParameterNotFound') || error.message.includes('not found in SSM')) {
        console.log(chalk.yellow('\n⚠️  Firebase service account not found in SSM.'));
        console.log(chalk.cyan('\n   To enable authentication providers manually:'));
        console.log(chalk.cyan('   1. Go to https://console.firebase.google.com/'));
        console.log(chalk.cyan(`   2. Select project: ${config.firebaseProjectId}`));
        console.log(chalk.cyan('   3. Go to Authentication > Sign-in method'));
        console.log(chalk.cyan('   4. Enable "Email/Password"'));
        console.log(chalk.cyan('   5. Enable "Google"'));
      } else if (error.message.includes('permission') || error.message.includes('403')) {
        console.log(chalk.yellow('\n⚠️  Insufficient permissions to update Firebase auth config.'));
        console.log(chalk.cyan('\n   The service account needs the "Firebase Admin" role.'));
        console.log(chalk.cyan('   You can enable auth providers manually in the Firebase Console.'));
      } else {
        console.log(chalk.red(`\n❌ Error: ${error.message}`));
        console.log(chalk.cyan('\n   You can enable authentication providers manually:'));
        console.log(chalk.cyan('   1. Go to https://console.firebase.google.com/'));
        console.log(chalk.cyan(`   2. Select project: ${config.firebaseProjectId}`));
        console.log(chalk.cyan('   3. Go to Authentication > Sign-in method'));
        console.log(chalk.cyan('   4. Enable "Email/Password"'));
        console.log(chalk.cyan('   5. Enable "Google"'));
      }
      
      return { success: false, error: error.message };
    }
  } catch (error) {
    console.error(chalk.red(`\n❌ Failed to setup Firebase Authentication: ${error.message}`));
    return { success: false, error: error.message };
  }
}

// Run if called directly
if (require.main === module) {
  setupFirebaseAuth().then((result) => {
    process.exit(result.success ? 0 : 1);
  }).catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
}

module.exports = { setupFirebaseAuth };

