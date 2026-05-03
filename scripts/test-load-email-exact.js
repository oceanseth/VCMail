/**
 * Test script that simulates the exact API call to loadEmail
 * This replicates the exact request: /api/loadEmail?emailId=email_1767802922770&folder=emails
 */

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');

// Load configuration
const { loadConfig } = require('../lib/config');
const firebaseInitializer = require('../firebaseInit');

// Import the handleLoadEmail function
// We'll need to extract it or mock the event structure

const emailId = 'email_1767802922770';
const folder = 'emails';
const uid = 'iOcXQr0GbhPGOwvhhWxdWpMWz833'; // From the logs

async function testLoadEmailExact() {
    try {
        console.log('🔧 Loading configuration...');
        const config = loadConfig(process.cwd());
        console.log('✅ Configuration loaded');

        // Initialize S3
        const s3 = new S3Client({
            region: config.awsRegion || 'us-east-1'
        });
        const bucketName = config.s3BucketName;

        // Initialize Firebase
        console.log('🔧 Initializing Firebase...');
        if (!config.firebaseDatabaseURL) {
            throw new Error('firebaseDatabaseURL not found in config');
        }
        const firebaseApp = await firebaseInitializer.get(config.firebaseDatabaseURL);
        console.log('✅ Firebase initialized');

        console.log(`\n📧 Loading email ${emailId} from ${folder} folder for user ${uid}...\n`);

        // Get email metadata from Firebase (same as handleLoadEmail)
        let firebasePath = folder === 'emails' ? `emails/${uid}/${emailId}` : `sent/${uid}/${emailId}`;
        let emailRef = firebaseApp.database().ref(firebasePath);
        let emailSnapshot = await emailRef.once('value');
        let emailData = null;
        let actualEmailId = emailId;

        if (!emailSnapshot.exists()) {
            throw new Error('Email not found');
        }
        emailData = emailSnapshot.val();

        console.log('[EMAIL] Email metadata from Firebase:', JSON.stringify({
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

        // Check if we need attachment parsing
        const needsAttachmentParsing = emailData.messageId && 
            (!emailData.hasAttachments || emailData.attachmentCount === 0 || 
             (!emailData.attachmentsS3 || emailData.attachmentsS3.length === 0) ||
             (!emailData.structure || !emailData.structure.attachments || emailData.structure.attachments.length === 0));
        
        console.log('[SEARCH] Attachment parsing check:', JSON.stringify({
            hasMessageId: !!emailData.messageId,
            hasAttachments: emailData.hasAttachments,
            attachmentCount: emailData.attachmentCount || 0,
            attachmentsS3Count: emailData.attachmentsS3?.length || 0,
            structureAttachmentsCount: emailData.structure?.attachments?.length || 0,
            needsAttachmentParsing: needsAttachmentParsing
        }, null, 2));

        if (needsAttachmentParsing && emailData.messageId) {
            console.log(`\n[EMAIL] Parsing from old SES location to extract attachments (messageId: ${emailData.messageId})\n`);
            
            try {
                console.log(`[EMAIL] Loading raw email from old SES location: ${emailData.messageId}`);
                const rawEmailResult = await s3.send(new GetObjectCommand({
                    Bucket: bucketName,
                    Key: emailData.messageId
                }));
                
                const rawEmailContent = await rawEmailResult.Body.transformToString('utf-8');
                console.log(`[OK] Loaded raw email from SES location (${rawEmailContent.length} chars)`);
                
                // Import parsing functions
                const { parseEmailContent, parseMultipartStructure, extractBoundary } = require('../api/api');
                
                // Parse the raw email to extract content and attachments
                const parsedEmailData = parseEmailContent(rawEmailContent);
                console.log(`[OK] Parsed email content`);
                
                // Check if multipart and parse structure
                let parsedContent = parsedEmailData.body;
                let parsedContentType = emailData.contentType || 'text/plain';
                let parsedAttachments = [];
                
                const contentType = parsedEmailData.headers['content-type'] || parsedEmailData.headers['Content-Type'] || '';
                console.log(`[EMAIL] Email content type: ${contentType}`);
                
                if (contentType.includes('multipart/')) {
                    const boundary = extractBoundary(contentType);
                    if (boundary) {
                        console.log(`[EMAIL] Parsing multipart email with boundary: ${boundary}`);
                        // Extract body section (after headers) for parsing
                        const bodyStart = rawEmailContent.indexOf('\r\n\r\n');
                        const bodySection = bodyStart !== -1 ? rawEmailContent.substring(bodyStart + 4) : rawEmailContent;
                        console.log(`[EMAIL] Body section length: ${bodySection.length} chars`);
                        
                        const emailStructure = parseMultipartStructure(bodySection, boundary);
                        
                        console.log(`[EMAIL] Parsed structure:`, JSON.stringify({
                            type: emailStructure.type,
                            partsCount: Object.keys(emailStructure.parts || {}).length,
                            attachmentsCount: emailStructure.attachments?.length || 0,
                            hasPreferredContent: !!emailStructure.preferredContent
                        }, null, 2));
                        
                        if (emailStructure.attachments && emailStructure.attachments.length > 0) {
                            console.log(`\n[ATTACH] Found ${emailStructure.attachments.length} attachments!\n`);
                            emailStructure.attachments.forEach((att, idx) => {
                                console.log(`Attachment ${idx + 1}:`);
                                console.log(`  Filename: ${att.filename ? att.filename.replace(/[^\x00-\x7F]/g, '?') : 'unnamed'}`);
                                console.log(`  Content-Type: ${att.contentType ? att.contentType.replace(/[^\x00-\x7F]/g, '?') : 'unknown'}`);
                                console.log(`  Size: ${att.size} bytes`);
                                console.log(`  Has content: ${!!att.content}`);
                                console.log(`  Has decodedContent: ${!!att.decodedContent}`);
                                console.log('');
                            });
                            
                            // Process attachments (simplified - just check if processing would work)
                            console.log(`[TOOL] Processing ${emailStructure.attachments.length} attachments...`);
                            for (let idx = 0; idx < emailStructure.attachments.length; idx++) {
                                const att = emailStructure.attachments[idx];
                                const attSize = att.size || 0;
                                
                                console.log(`[ATTACH] Processing attachment ${idx}:`, JSON.stringify({
                                    filename: att.filename ? att.filename.replace(/[^\x00-\x7F]/g, '?') : null,
                                    contentType: att.contentType ? att.contentType.replace(/[^\x00-\x7F]/g, '?') : null,
                                    size: attSize,
                                    hasContent: !!att.content,
                                    hasDecodedContent: !!att.decodedContent
                                }, null, 2));
                                
                                // Check if large attachment (>5MB)
                                if (attSize > 5 * 1024 * 1024) {
                                    console.log(`[PACKAGE] Attachment ${idx} is large (${(attSize / 1024 / 1024).toFixed(2)}MB), would save to S3`);
                                } else {
                                    console.log(`[OK] Small attachment ${idx} would be included in response`);
                                }
                            }
                        } else {
                            console.log(`[ATTACH] No attachments found in parsed structure`);
                        }
                    }
                }
                
                console.log('\n✅ Test completed successfully!');
                
            } catch (error) {
                console.error('\n❌ Error during parsing:', error.message);
                console.error(error.stack);
                throw error;
            }
        } else {
            console.log('\n⚠️ Attachment parsing not needed or messageId missing');
        }

    } catch (error) {
        console.error('\n❌ Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

testLoadEmailExact();


