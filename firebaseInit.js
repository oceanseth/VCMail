const AWS = require('aws-sdk');
const admin = require('firebase-admin');
AWS.config.update({ region: 'us-east-1' });

class FirebaseInitializer {
  constructor() {
    this.ssm = new AWS.SSM();
    this.firebaseAppMap = new Map();
  }

  async get(databaseURL) {
    try {
      // Return existing instance if already initialized
      if (this.firebaseAppMap.has(databaseURL)) {
        return this.firebaseAppMap.get(databaseURL);
      }

      const params = {
        Name: '/voicecert/prod/firebase_service_account',
        WithDecryption: true
      };

      const result = await this.ssm.getParameter(params).promise();
      
      if (!result?.Parameter?.Value) {
        throw new Error('Firebase service account credentials not found in SSM');
      }

      const serviceAccount = JSON.parse(result.Parameter.Value);

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