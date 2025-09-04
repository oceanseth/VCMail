const firebaseInitializer = require('../firebaseInit');
const fs = require('fs');
const path = require('path');
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
let db;

async function initializeFirebase() {
  try {
    const firebaseApp = await firebaseInitializer.initialize(firebaseConfig.databaseURL);
    db = firebaseApp.database();
    console.log('✅ Firebase initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize Firebase:', error);
    throw error;
  }
}

async function deployDatabaseRules() {
  console.log('🚀 Deploying database rules...');
  
  try {
    // Initialize Firebase first
    await initializeFirebase();
    // Read the database rules file
    const rulesPath = path.join(__dirname, '..', 'database.rules.json');
    const rulesContent = fs.readFileSync(rulesPath, 'utf8');
    const rules = JSON.parse(rulesContent);
    
    console.log('📋 Rules content:', JSON.stringify(rules, null, 2));
    
    // Deploy the rules
    await db.setRules(JSON.stringify(rules));
    
    console.log('✅ Database rules deployed successfully!');
    
  } catch (error) {
    console.error('❌ Failed to deploy database rules:', error);
  } finally {
    // Close the app
    if (firebaseInitializer.firebaseApp) {
      await firebaseInitializer.firebaseApp.delete();
    }
  }
}

// Run the deployment
deployDatabaseRules().catch(console.error);
