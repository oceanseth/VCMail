/**
 * Script to reprocess email attachments by clearing attachment metadata from Firebase
 * This forces handleLoadEmail to reprocess the email from the SES S3 location
 * 
 * Usage: node scripts/reprocess-email-attachments.js <emailId> <folder> [uid]
 * Example: node scripts/reprocess-email-attachments.js email_1767802922770 emails iOcXQr0GbhPGOwvhhWxdWpMWz833
 */

const admin = require('firebase-admin');
const AWS = require('aws-sdk');
const path = require('path');
const { getConfigWithDefaults, CONFIG_FILE } = require('../lib/config');
const fs = require('fs-extra');

/**
 * Get Firebase service account from SSM Parameter Store
 */
async function getFirebaseServiceAccountFromSSM(config) {
    const ssm = new AWS.SSM({ region: config.awsRegion });
    const computedConfig = getConfigWithDefaults(config);
    const paramName = `${computedConfig.ssmPrefix}/firebase_service_account`;
    
    console.log(`📡 Loading Firebase service account from SSM: ${paramName}`);
    
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
        
        // Parse service account JSON (handle multiple formats)
        try {
            const parsed = JSON.parse(paramValue);
            if (typeof parsed === 'string') {
                // Might be base64 encoded
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
            // Try base64 decoding first, then JSON parse
            try {
                const decoded = Buffer.from(paramValue, 'base64').toString('utf-8');
                serviceAccount = JSON.parse(decoded);
            } catch (base64Error) {
                throw new Error('Invalid Firebase service account JSON format in SSM');
            }
        }
        
        console.log(`✅ Successfully loaded Firebase service account from SSM`);
        return serviceAccount;
    } catch (error) {
        if (error.code === 'ParameterNotFound') {
            throw new Error(`Firebase service account not found in SSM at ${paramName}. Please upload it first.`);
        }
        throw error;
    }
}

// Initialize Firebase Admin (will be done in async function below)
let db = null;

async function initializeFirebase() {
    // Load config from vcmail.config.json
    let config;
    try {
        const configPath = path.join(process.cwd(), CONFIG_FILE);
        if (!fs.existsSync(configPath)) {
            console.error(`❌ Configuration file not found: ${configPath}`);
            console.error('Please run "npx vcmail" first to create vcmail.config.json');
            process.exit(1);
        }
        const fileConfig = await fs.readJson(configPath);
        config = getConfigWithDefaults(fileConfig);
        console.log(`✅ Loaded config from ${CONFIG_FILE}`);
    } catch (error) {
        console.error('❌ Error loading config:', error.message);
        process.exit(1);
    }

    // Initialize AWS region
    const awsRegion = config.awsRegion || process.env.AWS_REGION || 'us-east-1';
    AWS.config.update({ region: awsRegion });

    // Load Firebase service account from SSM
    let serviceAccount;
    try {
        serviceAccount = await getFirebaseServiceAccountFromSSM(config);
    } catch (error) {
        console.error('❌ Error loading Firebase service account from SSM:', error.message);
        console.error('\nMake sure:');
        console.error('1. AWS credentials are configured (run "aws configure")');
        console.error('2. The SSM parameter exists at the configured ssmPrefix');
        console.error(`3. Your AWS account has permission to read SSM parameters`);
        process.exit(1);
    }

    // Initialize Firebase Admin
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: config.firebaseDatabaseURL || process.env.FIREBASE_DATABASE_URL || serviceAccount.databaseURL
    });

    db = admin.database();
    return db;
}

async function reprocessEmailAttachments(emailId, folder, uid) {
    // Initialize Firebase if not already done
    if (!db) {
        await initializeFirebase();
    }
    
    try {
        console.log(`\n📧 Reprocessing attachments for email: ${emailId}`);
        console.log(`   Folder: ${folder}`);
        console.log(`   UID: ${uid}\n`);

        const emailRef = db.ref(`${folder}/${uid}/${emailId}`);
        const snapshot = await emailRef.once('value');
        const emailData = snapshot.val();

        if (!emailData) {
            console.error(`❌ Email not found: ${emailId} in ${folder}/${uid}`);
            process.exit(1);
        }

        console.log('📋 Current email data:');
        console.log(`   Subject: ${emailData.subject || '(no subject)'}`);
        console.log(`   From: ${emailData.from || '(unknown)'}`);
        console.log(`   MessageId: ${emailData.messageId || '(none)'}`);
        console.log(`   Has attachments metadata: ${!!emailData.hasAttachments}`);
        console.log(`   Attachment count: ${emailData.attachmentCount || 0}`);
        console.log(`   attachmentsS3 count: ${emailData.attachmentsS3?.length || 0}`);
        console.log(`   structure.attachments count: ${emailData.structure?.attachments?.length || 0}`);

        if (!emailData.messageId) {
            console.error('❌ Email has no messageId - cannot reprocess from SES location');
            process.exit(1);
        }

        // Clear attachment metadata to force reprocessing
        const updates = {};
        
        // Clear attachment flags
        if (emailData.hasAttachments !== undefined) {
            updates.hasAttachments = null;
        }
        if (emailData.attachmentCount !== undefined) {
            updates.attachmentCount = null;
        }
        
        // Clear attachmentsS3 array
        if (emailData.attachmentsS3 !== undefined) {
            updates.attachmentsS3 = null;
        }
        
        // Clear structure.attachments (but keep structure if it has other data)
        if (emailData.structure) {
            if (emailData.structure.attachments !== undefined) {
                updates['structure/attachments'] = null;
            }
            // Also clear structure.hasAttachments if it exists
            if (emailData.structure.hasAttachments !== undefined) {
                updates['structure/hasAttachments'] = null;
            }
        }

        // Optionally clear content to force reload from S3 (uncomment if needed)
        // if (emailData.content) {
        //     console.log('   Clearing content field to force reload from S3...');
        //     updates.content = null;
        // }

        console.log('\n🔄 Clearing attachment metadata...');
        await emailRef.update(updates);

        console.log('✅ Successfully cleared attachment metadata!');
        console.log('\n📝 Next steps:');
        console.log('   1. Reload the email in the web interface');
        console.log('   2. The API will detect missing attachments and reprocess from SES S3 location');
        console.log('   3. All attachments will be saved to S3 with presigned URLs');
        console.log(`\n   Email will be reprocessed from: ${emailData.messageId}`);

    } catch (error) {
        console.error('❌ Error reprocessing email:', error);
        process.exit(1);
    }
}

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length < 2) {
    console.error('Usage: node scripts/reprocess-email-attachments.js <emailId> <folder> [uid]');
    console.error('Example: node scripts/reprocess-email-attachments.js email_1767802922770 emails iOcXQr0GbhPGOwvhhWxdWpMWz833');
    process.exit(1);
}

const emailId = args[0];
const folder = args[1];
const uid = args[2];

if (!uid) {
    console.error('❌ UID is required');
    console.error('Usage: node scripts/reprocess-email-attachments.js <emailId> <folder> <uid>');
    process.exit(1);
}

if (!['emails', 'inbox', 'sent'].includes(folder)) {
    console.error('❌ Folder must be one of: emails, inbox, sent');
    process.exit(1);
}

(async () => {
    try {
        await reprocessEmailAttachments(emailId, folder, uid);
        console.log('\n✅ Done!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    }
})();

