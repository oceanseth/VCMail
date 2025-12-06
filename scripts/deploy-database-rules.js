const firebaseInitializer = require('../firebaseInit');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../lib/config');

async function deployDatabaseRules() {
  console.log('🚀 Deploying Firebase database rules...');
  let firebaseApp = null;
  
  try {
    // Load VCMail config to get Firebase database URL
    const config = loadConfig(process.cwd());
    const databaseURL = config.firebaseDatabaseURL || `https://${config.firebaseProjectId}.firebaseio.com`;
    
    console.log(`📋 Using Firebase database URL: ${databaseURL}`);
    
    // Initialize Firebase using the same method as setup.js
    firebaseApp = await firebaseInitializer.get(databaseURL);
    const db = firebaseApp.database();
    console.log('✅ Firebase initialized successfully');
    
    // Read the database rules file
    const rulesPath = path.join(__dirname, '..', 'database.rules.json');
    if (!fs.existsSync(rulesPath)) {
      throw new Error(`Database rules file not found: ${rulesPath}`);
    }
    
    const rulesContent = fs.readFileSync(rulesPath, 'utf8');
    const rules = JSON.parse(rulesContent);
    
    console.log('📋 Deploying rules from:', rulesPath);
    
    // Deploy the rules
    await db.setRules(JSON.stringify(rules));
    
    console.log('✅ Database rules deployed successfully!');
    
  } catch (error) {
    console.error('❌ Failed to deploy database rules:', error.message);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  } finally {
    // Clean up Firebase app to allow process to exit
    if (firebaseApp) {
      try {
        await firebaseApp.delete();
      } catch (deleteError) {
        // Ignore errors when deleting Firebase app
        console.log('Note: Could not clean up Firebase app (this is usually harmless)');
      }
    }
  }
}

// Run the deployment
deployDatabaseRules().catch(console.error);
