const AWS = require('aws-sdk');
const admin = require('firebase-admin');

// Load configuration
let config = {};
try {
  if (process.env.VCMAIL_CONFIG) {
    config = JSON.parse(process.env.VCMAIL_CONFIG);
  } else {
    const { loadConfig } = require('./lib/config');
    config = loadConfig(process.cwd());
  }
} catch (error) {
  console.warn('Could not load VCMail config in firebaseInit, using defaults:', error.message);
  config = {
    ssmPrefix: process.env.SSM_PREFIX || '/vcmail/prod',
    awsRegion: process.env.AWS_REGION || 'us-east-1'
  };
}

const awsRegion = config.awsRegion || process.env.AWS_REGION || 'us-east-1';
AWS.config.update({ region: awsRegion });

class FirebaseInitializer {
  constructor() {
    this.ssm = new AWS.SSM({ region: awsRegion });
    this.firebaseAppMap = new Map();
  }

  async get(databaseURL) {
    try {
      // Return existing instance if already initialized
      if (this.firebaseAppMap.has(databaseURL)) {
        return this.firebaseAppMap.get(databaseURL);
      }

      const ssmPrefix = config.ssmPrefix || process.env.SSM_PREFIX || '/vcmail/prod';
      const params = {
        Name: `${ssmPrefix}/firebase_service_account`,
        WithDecryption: true
      };

      const result = await this.ssm.getParameter(params).promise();
      
      if (!result?.Parameter?.Value) {
        throw new Error('Firebase service account credentials not found in SSM');
      }

      let serviceAccount;
      let paramValue = result.Parameter.Value.trim();
      
      // Try multiple parsing strategies
      // Strategy 1: Direct JSON parse (if stored as plain JSON)
      try {
        const parsed = JSON.parse(paramValue);
        // If result is a string, it might be a JSON-encoded base64 string
        if (typeof parsed === 'string') {
          // Try base64 decoding the string
          try {
            const decoded = Buffer.from(parsed, 'base64').toString('utf-8');
            serviceAccount = JSON.parse(decoded);
          } catch (e) {
            // Not base64, try parsing the string as JSON again (double-encoded JSON)
            try {
              serviceAccount = JSON.parse(parsed);
            } catch (e2) {
              throw new Error('Service account parameter contains a JSON string, not a JSON object');
            }
          }
        } else {
          // It's already a JSON object
          serviceAccount = parsed;
        }
      } catch (directParseError) {
        // Strategy 2: Try base64 decoding first, then JSON parse
        try {
          const decoded = Buffer.from(paramValue, 'base64').toString('utf-8');
          serviceAccount = JSON.parse(decoded);
        } catch (base64Error) {
          // All strategies failed
          console.error('Failed to parse Firebase service account JSON.');
          console.error('Value preview (first 100 chars):', paramValue.substring(0, 100));
          console.error('Direct parse error:', directParseError.message);
          console.error('Base64 decode error:', base64Error.message);
          throw new Error(`Invalid JSON in Firebase service account parameter. The parameter value appears to be incorrectly formatted. Expected valid JSON object or base64-encoded JSON. Original error: ${directParseError.message}`);
        }
      }

    this.firebaseAppMap.set(databaseURL, admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL
      }));

      return this.firebaseAppMap.get(databaseURL);
    } catch (error) {
      console.error('Failed to initialize Firebase:', error);
      throw error;
    }
  }
}

module.exports = new FirebaseInitializer();