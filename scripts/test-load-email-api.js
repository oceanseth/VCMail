/**
 * Test script to simulate handleLoadEmail API locally
 * Usage: node scripts/test-load-email-api.js <emailId> <folder> [uid]
 * Example: node scripts/test-load-email-api.js email_1767802922770 emails
 */

const path = require('path');
const AWS = require('aws-sdk');

// Load configuration
const { loadConfig } = require('../lib/config');
const firebaseInitializer = require('../firebaseInit');

// Import functions from api.js (we'll need to extract them or require the module)
// For now, we'll copy the necessary logic

// Get command line arguments
const emailId = process.argv[2];
const folder = process.argv[3] || 'emails';
const uid = process.argv[4] || null;

if (!emailId) {
    console.error('Usage: node scripts/test-load-email-api.js <emailId> <folder> [uid]');
    console.error('Example: node scripts/test-load-email-api.js email_1767802922770 emails');
    process.exit(1);
}

async function testLoadEmail() {
    try {
        console.log('🔧 Loading configuration...');
        const config = loadConfig(process.cwd());
        console.log('✅ Configuration loaded:', {
            domain: config.domain,
            s3BucketName: config.s3BucketName,
            firebaseDatabaseURL: config.firebaseDatabaseURL ? '***' : 'not set'
        });

        // Initialize S3
        console.log('🔧 Initializing S3...');
        const s3 = new AWS.S3({
            region: config.awsRegion || 'us-east-1',
            signatureVersion: 'v4'
        });
        const bucketName = config.s3BucketName;

        // Initialize Firebase
        console.log('🔧 Initializing Firebase...');
        if (!config.firebaseDatabaseURL) {
            throw new Error('firebaseDatabaseURL not found in config');
        }
        const firebaseApp = await firebaseInitializer.get(config.firebaseDatabaseURL);
        console.log('✅ Firebase initialized');

        // Get UID if not provided
        let actualUid = uid;
        if (!actualUid) {
            console.log('🔍 UID not provided, trying to find user...');
            // Try to get the first user or use a test UID
            // For now, we'll need the user to provide it or we can search
            const emailsRef = firebaseApp.database().ref(folder === 'emails' ? 'emails' : 'sent');
            const snapshot = await emailsRef.limitToFirst(1).once('value');
            snapshot.forEach((userSnapshot) => {
                actualUid = userSnapshot.key;
                return true; // Stop iteration
            });
            if (!actualUid) {
                throw new Error('No users found. Please provide UID as third argument.');
            }
            console.log(`✅ Found UID: ${actualUid}`);
        }

        console.log(`\n📧 Loading email ${emailId} from ${folder} folder for user ${actualUid}...\n`);

        // Get email metadata from Firebase
        let firebasePath = folder === 'emails' ? `emails/${actualUid}/${emailId}` : `sent/${actualUid}/${emailId}`;
        let emailRef = firebaseApp.database().ref(firebasePath);
        let emailSnapshot = await emailRef.once('value');
        let emailData = null;
        let actualEmailId = emailId;

        // If not found, try searching by messageId
        if (!emailSnapshot.exists() && emailId.length > 20) {
            console.log(`⚠️ Email not found at ${firebasePath}, trying to search by messageId...`);
            const emailsRef = firebaseApp.database().ref(folder === 'emails' ? `emails/${actualUid}` : `sent/${actualUid}`);
            const allEmailsSnapshot = await emailsRef.once('value');
            
            let foundEmail = null;
            let foundEmailId = null;
            
            allEmailsSnapshot.forEach((childSnapshot) => {
                const email = childSnapshot.val();
                if (email.messageId === emailId || childSnapshot.key === emailId) {
                    foundEmail = email;
                    foundEmailId = childSnapshot.key;
                    return true;
                }
            });
            
            if (foundEmail) {
                console.log(`✅ Found email by messageId lookup: ${foundEmailId}`);
                emailData = foundEmail;
                actualEmailId = foundEmailId;
            } else {
                throw new Error('Email not found');
            }
        } else if (!emailSnapshot.exists()) {
            throw new Error('Email not found');
        } else {
            emailData = emailSnapshot.val();
        }

        console.log('📧 Email metadata from Firebase:');
        console.log(JSON.stringify({
            emailId: actualEmailId,
            subject: emailData.subject,
            from: emailData.from,
            to: emailData.to,
            contentS3Key: emailData.contentS3Key,
            hasContent: !!emailData.content,
            contentLength: emailData.content?.length || 0,
            hasAttachments: emailData.hasAttachments,
            attachmentCount: emailData.attachmentCount || 0,
            hasAttachmentsS3: !!(emailData.attachmentsS3 && emailData.attachmentsS3.length > 0),
            attachmentsS3Count: emailData.attachmentsS3?.length || 0,
            hasStructure: !!emailData.structure,
            structureAttachments: emailData.structure?.attachments?.length || 0,
            messageId: emailData.messageId,
            contentType: emailData.contentType,
            timestamp: emailData.timestamp
        }, null, 2));

        // Now we need to load the actual parsing functions from api.js
        // For now, let's require the api module and extract what we need
        console.log('\n🔧 Loading parsing functions from api.js...');
        
        // We'll need to dynamically require and extract the functions
        // Since api.js exports a handler, we need to extract the internal functions
        // Let's create a mock event and call the handler, or better yet, extract the logic
        
        // For now, let's read the raw email from S3 if messageId exists
        if (emailData.messageId && !emailData.contentS3Key) {
            console.log(`\n📥 Loading raw email from S3 using messageId: ${emailData.messageId}`);
            try {
                const rawEmailKey = emailData.messageId;
                const rawEmailObject = await s3.getObject({
                    Bucket: bucketName,
                    Key: rawEmailKey
                }).promise();
                
                const rawEmailContent = rawEmailObject.Body.toString('utf-8');
                console.log(`✅ Loaded raw email from S3 (${rawEmailContent.length} bytes)`);
                
                // Now we need to parse it - let's require the parsing functions
                // We'll need to extract parseMultipartStructure and related functions
                // For now, let's just show what we have
                console.log('\n📄 Raw email preview (first 500 chars):');
                console.log(rawEmailContent.substring(0, 500));
                console.log('\n...\n');
                
                // Parse email headers to extract content-type
                const headerEnd = rawEmailContent.indexOf('\r\n\r\n');
                if (headerEnd === -1) {
                    console.log('⚠️  Could not find header/body separator');
                } else {
                    // Extract and parse headers
                    const headersSection = rawEmailContent.substring(0, headerEnd);
                    const bodySection = rawEmailContent.substring(headerEnd + 4);
                    
                    // Parse headers
                    const headers = {};
                    headersSection.split(/\r?\n/).forEach(line => {
                        const colonIndex = line.indexOf(':');
                        if (colonIndex > 0) {
                            const key = line.substring(0, colonIndex).trim().toLowerCase();
                            const value = line.substring(colonIndex + 1).trim();
                            headers[key] = value;
                        }
                    });
                    
                    const contentType = headers['content-type'] || '';
                    console.log(`📧 Content-Type: ${contentType}`);
                    
                    if (contentType.includes('multipart/')) {
                        // Import parsing functions from api.js
                        const { parseMultipartStructure, extractBoundary } = require('../api/api');
                        
                        const boundary = extractBoundary(contentType);
                        if (boundary) {
                            console.log(`📧 Boundary: ${boundary}`);
                            console.log('\n🔧 Parsing multipart structure...\n');
                            
                            // Parse the multipart structure
                            const structure = parseMultipartStructure(bodySection, boundary);
                            
                            console.log('\n📊 Parsing Results:');
                            console.log(`   Type: ${structure.type}`);
                            console.log(`   Parts: ${Object.keys(structure.parts || {}).length}`);
                            console.log(`   Attachments: ${structure.attachments?.length || 0}`);
                            console.log(`   Has preferred content: ${!!structure.preferredContent}`);
                            
                            if (structure.attachments && structure.attachments.length > 0) {
                                console.log('\n📎 Attachments found:');
                                structure.attachments.forEach((att, idx) => {
                                    console.log(`\n   Attachment ${idx + 1}:`);
                                    console.log(`      Filename: ${att.filename}`);
                                    console.log(`      Content-Type: ${att.contentType}`);
                                    console.log(`      Size: ${att.size} bytes`);
                                    console.log(`      Encoding: ${att.encoding || att.originalEncoding || 'none'}`);
                                    console.log(`      Has content: ${!!att.content}`);
                                    console.log(`      Has decodedContent: ${!!att.decodedContent}`);
                                    console.log(`      Is inline: ${att.isInline}`);
                                });
                            } else {
                                console.log('\n⚠️  No attachments detected!');
                                console.log('   This might indicate an issue with attachment detection logic.');
                            }
                        } else {
                            console.log('⚠️  Could not extract boundary from Content-Type');
                        }
                    } else {
                        console.log('⚠️  Email is not multipart');
                    }
                }
                
            } catch (s3Error) {
                console.error(`❌ Error loading raw email from S3:`, s3Error.message);
            }
        }

        console.log('\n✅ Test complete!');
        console.log('\n📝 Summary:');
        console.log(`   - Email ID: ${actualEmailId}`);
        console.log(`   - Folder: ${folder}`);
        console.log(`   - Has contentS3Key: ${!!emailData.contentS3Key}`);
        console.log(`   - Has messageId: ${!!emailData.messageId}`);
        console.log(`   - Has attachmentsS3: ${!!(emailData.attachmentsS3 && emailData.attachmentsS3.length > 0)}`);
        console.log(`   - Structure attachments: ${emailData.structure?.attachments?.length || 0}`);

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

testLoadEmail();

