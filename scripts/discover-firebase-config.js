/**
 * Discover Firebase Configuration from Service Account
 * Automatically retrieves Firebase config values using the service account
 */

const AWS = require('aws-sdk');
const https = require('https');
const { getConfigWithDefaults, CONFIG_FILE } = require('../lib/config');
const path = require('path');
const fs = require('fs-extra');

// Use jsonwebtoken for JWT signing
let jwt;
try {
  jwt = require('jsonwebtoken');
} catch (e) {
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
      throw new Error(`Firebase service account not found in SSM at ${paramName}`);
    }
    throw error;
  }
}

/**
 * Get OAuth2 access token using service account
 */
async function getAccessToken(serviceAccount) {
  if (!jwt) {
    throw new Error('jsonwebtoken package is required');
  }
  
  const now = Math.floor(Date.now() / 1000);
  
  const claim = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase'
  };
  
  const token = jwt.sign(claim, serviceAccount.private_key, {
    algorithm: 'RS256'
  });
  
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
 * Get Firebase project configuration
 */
async function getFirebaseProjectConfig(projectId, accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'firebase.googleapis.com',
      path: `/v1beta1/projects/${projectId}`,
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
            reject(new Error(`Failed to get project config: ${error.error?.message || data}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse project config response: ${e.message}`));
        }
      });
    });
    
    req.on('error', reject);
    req.end();
  });
}

/**
 * Get Firebase Realtime Database instances
 */
async function getRealtimeDatabaseInstances(projectId, accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'firebasedatabase.googleapis.com',
      path: `/v1beta/projects/${projectId}/locations/-/instances`,
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
            // If 404, database might not exist yet - return empty array
            if (res.statusCode === 404) {
              resolve({ instances: [] });
            } else {
              const error = JSON.parse(data);
              reject(new Error(`Failed to get database instances: ${error.error?.message || data}`));
            }
          }
        } catch (e) {
          reject(new Error(`Failed to parse database instances response: ${e.message}`));
        }
      });
    });
    
    req.on('error', reject);
    req.end();
  });
}

/**
 * Get Firebase Web Apps (to get API key and App ID)
 */
async function getFirebaseWebApps(projectId, accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'firebase.googleapis.com',
      path: `/v1beta1/projects/${projectId}/webApps`,
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
            // If 404 or empty, return empty array
            if (res.statusCode === 404) {
              resolve({ apps: [] });
            } else {
              const error = JSON.parse(data);
              reject(new Error(`Failed to get web apps: ${error.error?.message || data}`));
            }
          }
        } catch (e) {
          reject(new Error(`Failed to parse web apps response: ${e.message}`));
        }
      });
    });
    
    req.on('error', reject);
    req.end();
  });
}

/**
 * Get Firebase Web App configuration (includes API key)
 */
async function getFirebaseWebAppConfig(projectId, appId, accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'firebase.googleapis.com',
      path: `/v1beta1/projects/${projectId}/webApps/${appId}/config`,
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
            reject(new Error(`Failed to get web app config: ${error.error?.message || data}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse web app config response: ${e.message}`));
        }
      });
    });
    
    req.on('error', reject);
    req.end();
  });
}

/**
 * Discover Firebase configuration from service account
 */
async function discoverFirebaseConfig(config = null) {
  const chalkModule = await import('chalk');
  const chalk = chalkModule.default || chalkModule;
  
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
    
    console.log(chalk.blue('🔍 Discovering Firebase configuration from service account...\n'));
    
    // Get service account from SSM
    const serviceAccount = await getFirebaseServiceAccount(config);
    
    // Extract project ID from service account
    const projectId = serviceAccount.project_id;
    console.log(chalk.green(`✓ Found project ID: ${projectId}`));
    
    // Get access token
    const accessToken = await getAccessToken(serviceAccount);
    
    const discoveredConfig = {
      firebaseProjectId: projectId
    };
    
    // Try to get database URL
    try {
      console.log(chalk.cyan('   Checking Realtime Database instances...'));
      const dbInstances = await getRealtimeDatabaseInstances(projectId, accessToken);
      
      if (dbInstances.instances && dbInstances.instances.length > 0) {
        // Use the first instance (usually default)
        const instance = dbInstances.instances[0];
        // Database URL format: https://<databaseId>-<region>.firebasedatabase.app
        // Or legacy: https://<projectId>.firebaseio.com
        if (instance.databaseUrl) {
          discoveredConfig.firebaseDatabaseURL = instance.databaseUrl;
          console.log(chalk.green(`✓ Found database URL: ${instance.databaseUrl}`));
        } else {
          // Fallback to legacy format
          discoveredConfig.firebaseDatabaseURL = `https://${projectId}.firebaseio.com`;
          console.log(chalk.yellow(`⚠ Using default database URL: ${discoveredConfig.firebaseDatabaseURL}`));
        }
      } else {
        // No database instances found - use default
        discoveredConfig.firebaseDatabaseURL = `https://${projectId}.firebaseio.com`;
        console.log(chalk.yellow(`⚠ No database instances found, using default: ${discoveredConfig.firebaseDatabaseURL}`));
      }
    } catch (error) {
      // Fallback to default
      discoveredConfig.firebaseDatabaseURL = `https://${projectId}.firebaseio.com`;
      console.log(chalk.yellow(`⚠ Could not query database instances: ${error.message}`));
      console.log(chalk.yellow(`   Using default: ${discoveredConfig.firebaseDatabaseURL}`));
    }
    
    // Try to get web app config (API key, App ID, Messaging Sender ID)
    try {
      console.log(chalk.cyan('   Checking Firebase Web Apps...'));
      const webApps = await getFirebaseWebApps(projectId, accessToken);
      
      if (webApps.apps && webApps.apps.length > 0) {
        // Use the first web app
        const webApp = webApps.apps[0];
        discoveredConfig.firebaseAppId = webApp.appId;
        console.log(chalk.green(`✓ Found App ID: ${webApp.appId}`));
        
        // Get web app config for API key
        try {
          const appConfig = await getFirebaseWebAppConfig(projectId, webApp.appId, accessToken);
          
          if (appConfig.apiKey) {
            discoveredConfig.firebaseApiKey = appConfig.apiKey;
            console.log(chalk.green(`✓ Found API Key: ${appConfig.apiKey.substring(0, 10)}...`));
          }
          
          if (appConfig.messagingSenderId) {
            discoveredConfig.firebaseMessagingSenderId = appConfig.messagingSenderId;
            console.log(chalk.green(`✓ Found Messaging Sender ID: ${appConfig.messagingSenderId}`));
          }
        } catch (configError) {
          console.log(chalk.yellow(`⚠ Could not get web app config: ${configError.message}`));
        }
      } else {
        console.log(chalk.yellow(`⚠ No web apps found. You may need to create one in Firebase Console.`));
      }
    } catch (error) {
      console.log(chalk.yellow(`⚠ Could not query web apps: ${error.message}`));
    }
    
    console.log(chalk.green('\n✓ Firebase configuration discovery complete!\n'));
    
    return discoveredConfig;
  } catch (error) {
    console.error(chalk.red(`\n❌ Failed to discover Firebase configuration: ${error.message}`));
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  discoverFirebaseConfig().then((config) => {
    console.log('\nDiscovered configuration:');
    console.log(JSON.stringify(config, null, 2));
    process.exit(0);
  }).catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
}

module.exports = { discoverFirebaseConfig };

