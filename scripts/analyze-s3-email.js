#!/usr/bin/env node

/**
 * Script to analyze a specific email file in S3 and identify attachments
 * Usage: node scripts/analyze-s3-email.js <messageId> [bucketName]
 */

const AWS = require('aws-sdk');
const path = require('path');

// Load email parsing functions from the API
const { 
    parseEmailContent, 
    extractBoundary, 
    parseMultipartStructure,
    extractFilename,
    decodePartContent
} = require('../api/api');

// Initialize S3
const s3 = new AWS.S3({
    region: process.env.AWS_REGION || 'us-east-1',
    signatureVersion: 'v4'
});

async function analyzeEmail(messageId, bucketName = 'voicecert-com-mail-inbox') {
    console.log('📧 Analyzing email from S3');
    console.log(`📦 Bucket: ${bucketName}`);
    console.log(`🔑 Key: ${messageId}`);
    console.log('');
    
    try {
        // Download the email from S3
        console.log('⬇️  Downloading email from S3...');
        const result = await s3.getObject({
            Bucket: bucketName,
            Key: messageId
        }).promise();
        
        const rawEmail = result.Body.toString('utf-8');
        const fileSize = rawEmail.length;
        console.log(`✅ Downloaded email (${fileSize} bytes / ${(fileSize / 1024).toFixed(2)} KB)`);
        console.log('');
        
        // Parse email headers
        console.log('📋 Parsing email headers...');
        const emailData = parseEmailContent(rawEmail);
        console.log(`From: ${emailData.from}`);
        console.log(`To: ${emailData.to}`);
        console.log(`Subject: ${emailData.subject}`);
        console.log('');
        
        // Check Content-Type
        const contentType = emailData.headers['content-type'] || emailData.headers['Content-Type'] || '';
        console.log(`Content-Type: ${contentType}`);
        console.log('');
        
        // Check if multipart
        if (contentType.includes('multipart/')) {
            const boundary = extractBoundary(contentType);
            console.log(`✅ Email is MULTIPART`);
            console.log(`Boundary: ${boundary}`);
            console.log('');
            
            if (boundary) {
                console.log('📎 Parsing multipart structure...');
                const structure = parseMultipartStructure(rawEmail, boundary);
                
                console.log(`📊 Structure Analysis:`);
                console.log(`   Type: ${structure.type}`);
                console.log(`   Parts found: ${Object.keys(structure.parts || {}).length}`);
                console.log(`   Attachments found: ${structure.attachments?.length || 0}`);
                console.log('');
                
                // Show all parts
                console.log('📦 Parts:');
                console.log('─'.repeat(80));
                let partIndex = 0;
                for (const [partKey, part] of Object.entries(structure.parts || {})) {
                    partIndex++;
                    console.log(`\nPart ${partIndex} (${partKey}):`);
                    console.log(`  Content-Type: ${part.contentType || 'N/A'}`);
                    console.log(`  Content-Disposition: ${part.contentDisposition || 'N/A'}`);
                    console.log(`  Filename: ${part.filename || 'N/A'}`);
                    console.log(`  Encoding: ${part.encoding || 'N/A'}`);
                    console.log(`  Size: ${part.size || 0} bytes`);
                    console.log(`  Is Attachment: ${part.isAttachment ? 'YES ✅' : 'NO'}`);
                    console.log(`  Is Inline: ${part.isInline ? 'YES' : 'NO'}`);
                    
                    if (part.contentDisposition) {
                        const extractedFilename = extractFilename(part.contentDisposition);
                        if (extractedFilename && extractedFilename !== part.filename) {
                            console.log(`  Extracted Filename: ${extractedFilename}`);
                        }
                    }
                }
                
                // Show attachments specifically
                if (structure.attachments && structure.attachments.length > 0) {
                    console.log('\n');
                    console.log('📎 ATTACHMENTS FOUND:');
                    console.log('═'.repeat(80));
                    structure.attachments.forEach((att, idx) => {
                        console.log(`\nAttachment ${idx + 1}:`);
                        console.log(`  Filename: ${att.filename || 'UNNAMED'}`);
                        console.log(`  Content-Type: ${att.contentType || 'N/A'}`);
                        console.log(`  Size: ${att.size || 0} bytes (${((att.size || 0) / 1024 / 1024).toFixed(2)} MB)`);
                        console.log(`  Encoding: ${att.encoding || 'N/A'}`);
                        console.log(`  Is Inline: ${att.isInline ? 'YES' : 'NO'}`);
                        console.log(`  Content-Disposition: ${att.contentDisposition || 'N/A'}`);
                        console.log(`  Has Content: ${att.content ? 'YES' : 'NO'}`);
                        if (att.content) {
                            const contentLength = typeof att.content === 'string' ? att.content.length : att.content.length;
                            console.log(`  Content Length: ${contentLength} chars/bytes`);
                            
                            // For base64, show decoded size estimate
                            if (att.encoding === 'base64' && typeof att.content === 'string') {
                                try {
                                    const decoded = Buffer.from(att.content, 'base64');
                                    console.log(`  Decoded Size: ${decoded.length} bytes (${(decoded.length / 1024 / 1024).toFixed(2)} MB)`);
                                } catch (e) {
                                    console.log(`  ⚠️  Could not decode base64 content`);
                                }
                            }
                        }
                    });
                } else {
                    console.log('\n❌ NO ATTACHMENTS FOUND IN STRUCTURE');
                    console.log('This might indicate:');
                    console.log('  1. Attachments are marked as inline');
                    console.log('  2. Parsing logic is not detecting attachments correctly');
                    console.log('  3. Email structure is different than expected');
                }
                
                // Show preferred content
                if (structure.preferredContent) {
                    console.log('\n');
                    console.log('📄 Preferred Content:');
                    console.log(`   Type: ${structure.preferredContent.type}`);
                    console.log(`   Part Key: ${structure.preferredContent.partKey}`);
                    console.log(`   Content Length: ${structure.preferredContent.content?.length || 0} chars`);
                }
            } else {
                console.log('❌ Multipart email but no boundary found');
            }
        } else {
            console.log('ℹ️  Email is NOT multipart (single part)');
            console.log('   This means there are no attachments, or attachments are embedded inline');
        }
        
        // Show first 500 chars of raw email for inspection
        console.log('\n');
        console.log('📄 Raw Email Preview (first 500 chars):');
        console.log('─'.repeat(80));
        console.log(rawEmail.substring(0, 500));
        console.log('...');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.code === 'NoSuchKey') {
            console.error(`\nEmail not found in bucket ${bucketName} with key ${messageId}`);
            console.error('Please verify:');
            console.error('  1. The bucket name is correct');
            console.error('  2. The messageId/key is correct');
            console.error('  3. You have AWS credentials configured');
        } else if (error.code === 'NoSuchBucket') {
            console.error(`\nBucket ${bucketName} does not exist`);
            console.error('Please verify the bucket name');
        } else {
            console.error('\nFull error:', error);
        }
        process.exit(1);
    }
}

// Get command line arguments
const messageId = process.argv[2];
const bucketName = process.argv[3] || 'voicecert-com-mail-inbox';

if (!messageId) {
    console.error('Usage: node scripts/analyze-s3-email.js <messageId> [bucketName]');
    console.error('');
    console.error('Example:');
    console.error('  node scripts/analyze-s3-email.js ng5khvjqvgcg7fqerigjh97uvkebnb95j0forco1');
    console.error('  node scripts/analyze-s3-email.js ng5khvjqvgcg7fqerigjh97uvkebnb95j0forco1 voicecert-com-mail-inbox');
    process.exit(1);
}

analyzeEmail(messageId, bucketName).catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});


