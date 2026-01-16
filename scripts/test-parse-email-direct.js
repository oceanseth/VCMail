/**
 * Direct test of email parsing from S3
 * Usage: node scripts/test-parse-email-direct.js <messageId> [bucketName]
 * Example: node scripts/test-parse-email-direct.js ng5khvjqvgcg7fqerigjh97uvkebnb95j0forco1 voicecert-com-mail-inbox
 */

const AWS = require('aws-sdk');

// Get command line arguments
const messageId = process.argv[2];
const bucketName = process.argv[3] || 'voicecert-com-mail-inbox';

if (!messageId) {
    console.error('Usage: node scripts/test-parse-email-direct.js <messageId> [bucketName]');
    console.error('Example: node scripts/test-parse-email-direct.js ng5khvjqvgcg7fqerigjh97uvkebnb95j0forco1 voicecert-com-mail-inbox');
    process.exit(1);
}

async function testParseEmail() {
    try {
        console.log(`🔧 Loading email from S3...`);
        console.log(`   Bucket: ${bucketName}`);
        console.log(`   Key: ${messageId}\n`);

        // Initialize S3
        const s3 = new AWS.S3({
            region: 'us-east-1',
            signatureVersion: 'v4'
        });

        // Load raw email from S3
        const rawEmailObject = await s3.getObject({
            Bucket: bucketName,
            Key: messageId
        }).promise();

        const rawEmailContent = rawEmailObject.Body.toString('utf-8');
        console.log(`✅ Loaded raw email from S3 (${rawEmailContent.length} bytes)\n`);

        // Parse email headers to extract content-type
        const headerEnd = rawEmailContent.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
            console.log('⚠️  Could not find header/body separator');
            return;
        }

        // Extract and parse headers
        const headersSection = rawEmailContent.substring(0, headerEnd);
        const bodySection = rawEmailContent.substring(headerEnd + 4);

        // Parse headers (handle continuation lines properly)
        const headers = {};
        const headerLines = headersSection.split(/\r?\n/);
        let currentHeader = null;
        let currentValue = '';

        for (const line of headerLines) {
            // Check if this is a continuation line (starts with whitespace)
            if (line.match(/^\s/) && currentHeader) {
                // Continuation line - append to current value (preserve whitespace)
                currentValue += '\r\n' + line;
            } else {
                // Save previous header if we have one
                if (currentHeader) {
                    // Clean up the value (remove extra whitespace but preserve structure)
                    const cleanedValue = currentValue.replace(/\r?\n\s*/g, ' ').trim();
                    headers[currentHeader.toLowerCase()] = cleanedValue;
                }

                // Start new header
                const colonIndex = line.indexOf(':');
                if (colonIndex > 0) {
                    currentHeader = line.substring(0, colonIndex).trim().toLowerCase();
                    currentValue = line.substring(colonIndex + 1).trim();
                } else {
                    currentHeader = null;
                    currentValue = '';
                }
            }
        }

        // Save the last header
        if (currentHeader) {
            const cleanedValue = currentValue.replace(/\r?\n\s*/g, ' ').trim();
            headers[currentHeader.toLowerCase()] = cleanedValue;
        }

        const contentType = headers['content-type'] || '';
        console.log(`📧 Content-Type: ${contentType}\n`);

        if (!contentType.includes('multipart/')) {
            console.log('⚠️  Email is not multipart');
            return;
        }

        // Import parsing functions from api.js
        console.log('🔧 Loading parsing functions from api.js...\n');
        const { parseMultipartStructure, extractBoundary } = require('../api/api');

        const boundary = extractBoundary(contentType);
        if (!boundary) {
            console.log('⚠️  Could not extract boundary from Content-Type');
            return;
        }

        console.log(`📧 Boundary: ${boundary}\n`);
        console.log('🔧 Parsing multipart structure...\n');

        // Parse the multipart structure
        const structure = parseMultipartStructure(bodySection, boundary);

        console.log('📊 Parsing Results:');
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
                console.log(`      Content-Disposition: ${att.contentDisposition || 'none'}`);
            });
            console.log(`\n✅ Successfully detected ${structure.attachments.length} attachments!`);
        } else {
            console.log('\n⚠️  No attachments detected!');
            console.log('   This indicates an issue with attachment detection logic.\n');
            
            // Show what parts we found
            console.log('📋 Parts found:');
            Object.keys(structure.parts || {}).forEach((partKey, idx) => {
                const part = structure.parts[partKey];
                console.log(`\n   Part ${idx + 1} (${partKey}):`);
                console.log(`      Content-Type: ${part.contentType || 'none'}`);
                console.log(`      Content-Disposition: ${part.contentDisposition || 'none'}`);
                console.log(`      Filename: ${part.filename || 'none'}`);
                console.log(`      Is inline: ${part.isInline}`);
                console.log(`      Is attachment: ${part.isAttachment || false}`);
                console.log(`      Body length: ${part.body?.length || 0}`);
            });
        }

        console.log('\n✅ Test complete!');

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

testParseEmail();

