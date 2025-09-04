const AWS = require('aws-sdk');
const s3 = new AWS.S3({
    region: 'us-east-1',
    signatureVersion: 'v4',
    endpoint: 'https://s3.us-east-1.amazonaws.com'  // Specify regional endpoint
});
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
const firebaseInitializer = require('../firebaseInit');


let firebaseApp;

exports.handler = async (event, context) => {
    //console.log('Lambda started - full event:', JSON.stringify(event, null, 2));
    firebaseApp = await firebaseInitializer.get(firebaseConfig.databaseURL);
    if (event.Records && event.Records[0].eventSource === 'aws:ses') {
        return await handleSesEvent(event);
    }
    
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With',
        'Access-Control-Max-Age': '86400'
    };

    // Handle OPTIONS requests for CORS
    if (event.httpMethod === 'OPTIONS') {
        console.log('Handling OPTIONS request for CORS');
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With',
                'Access-Control-Max-Age': '86400',
                'Access-Control-Allow-Credentials': 'false'
            },
            body: ''
        };
    }

    try {
        console.log('Full event:', JSON.stringify(event, null, 2));
        const path = event.pathParameters?.proxy;
        console.log('Proxy path:', path);
        
        if (!path) {
            console.log('No proxy path found, returning 404');
            return {
                statusCode: 404,
                headers,
                body: JSON.stringify({ error: 'No path specified' })
            };
        }

        switch (path) {
            case 'upload':
                const token = event.headers?.Authorization?.split(' ')[1];
                const decodedToken = await firebaseApp.auth().verifyIdToken(token);
                return await handleUpload(event, decodedToken.uid, headers);
            case 'setupEmail':
                const setupToken = event.headers?.Authorization?.split(' ')[1];
                const setupDecodedToken = await firebaseApp.auth().verifyIdToken(setupToken);
                return await handleSetupEmail(event, setupDecodedToken, headers);
            
            case 'getEmails':
                const emailToken = event.headers?.Authorization?.split(' ')[1];
                const emailDecodedToken = await firebaseApp.auth().verifyIdToken(emailToken);
                return await handleGetEmails(event, emailDecodedToken.uid, headers);
            
            case 'getEmailStats':
                const statsToken = event.headers?.Authorization?.split(' ')[1];
                const statsDecodedToken = await firebaseApp.auth().verifyIdToken(statsToken);
                return await handleGetEmailStats(event, statsDecodedToken.uid, headers);
            
            case 'sendEmail':
                const sendToken = event.headers?.Authorization?.split(' ')[1];
                const sendDecodedToken = await firebaseApp.auth().verifyIdToken(sendToken);
                return await handleSendEmail(event, sendDecodedToken, headers);
            
            case 'deleteEmail':
                const deleteToken = event.headers?.Authorization?.split(' ')[1];
                const deleteDecodedToken = await firebaseApp.auth().verifyIdToken(deleteToken);
                return await handleDeleteEmail(event, deleteDecodedToken.uid, headers);
            
            default:
                return {
                    statusCode: 404,
                    headers,
                    body: JSON.stringify({ error: 'Not Found' })
                };
        }
    } catch (error) {
        console.error('Handler error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};
async function handleSesEvent(event) {
    console.log('=== SES EVENT RECEIVED ===');
    console.log('Full SES event:', JSON.stringify(event, null, 2));
    console.log('Number of records:', event.Records ? event.Records.length : 0);
    
    let processedCount = 0;
    let errorCount = 0;
    
    // Process each record in the SES event
    for (const record of event.Records) {
        console.log('--- Processing SES Record ---');
        console.log('Record type:', record.eventSource);
        console.log('Full record:', JSON.stringify(record, null, 2));
        
        const ses = record.ses;
        console.log('SES data:', JSON.stringify(ses, null, 2));
        
        try {
            console.log('--- Processing SES Record Content ---');
            
            // Use messageId to read email from S3 bucket
            if (ses.mail && ses.mail.messageId) {
                console.log('✅ Found messageId:', ses.mail.messageId);
                
                const s3Key = ses.mail.messageId;
                const bucketName = 'voicecert-mail-inbox';
                
                console.log(`📦 Reading email from S3: s3://${bucketName}/${s3Key}`);
                
                try {
                    // Read email content from S3
                    const s3Params = {
                        Bucket: bucketName,
                        Key: s3Key
                    };
                    
                    const s3Result = await s3.getObject(s3Params).promise();
                    console.log('✅ Successfully read email from S3');
                    
                    // Parse the email content from S3
                    const emailContent = s3Result.Body.toString('utf-8');
                    console.log('Email content from S3:', emailContent.substring(0, 500) + '...');
                    
                    // First, parse the email to get headers and raw body
                    const emailData = parseEmailContent(emailContent);
                    
                    // Check if this is a multipart email
                    const contentType = emailData.headers['content-type'] || '';
                    const boundary = extractBoundary(contentType);
                    
                    if (boundary) {
                        // This is a multipart email, extract the preferred part
                        console.log('Processing multipart email with boundary:', boundary);
                        const { body, content_type } = extractMimePart(emailData.body, boundary, true);
                        emailData.body = body;
                        emailData.headers.content_type = content_type;
                    } else {
                        // This is a simple email, just decode if needed
                        const transferEncoding = emailData.headers['content-transfer-encoding'] || '';
                        if (transferEncoding.toLowerCase() === 'quoted-printable') {
                            console.log('Decoding quoted-printable simple email...');
                            emailData.body = decodeQuotedPrintable(emailData.body);
                        }
                        emailData.headers.content_type = contentType;
                    }
                    
                    console.log('Parsed email data:', JSON.stringify(emailData, null, 2));
                    
                    // Process each recipient
                    console.log('Processing recipients:', ses.mail.destination);
                    for (const recipient of ses.mail.destination) {
                        console.log('Checking recipient:', recipient);
                        if (recipient.endsWith('@voicecert.com')) {
                            const username = recipient.split('@')[0];
                            console.log('✅ Found @voicecert.com recipient:', username);
                            await storeEmailForUser(username, ses.mail.messageId, emailData);
                            processedCount++;
                        } else {
                            console.log('❌ Recipient not @voicecert.com:', recipient);
                        }
                    }
                } catch (s3Error) {
                    console.error('❌ Error reading email from S3:', s3Error);
                    errorCount++;
                }
            } else {
                console.log('❌ No messageId found in SES mail data');
            }
            
            // Process receipt action if available
            if (ses.receipt) {
                console.log('📋 Receipt action:', {
                    action: ses.receipt.action,
                    recipient: ses.receipt.recipients,
                    timestamp: ses.receipt.timestamp,
                    processingTimeMillis: ses.receipt.processingTimeMillis
                });
            } else {
                console.log('❌ No receipt action found');
            }
        } catch (error) {
            console.error('❌ Error processing SES record:', error);
            errorCount++;
        }
    }
    
    console.log('=== SES EVENT PROCESSING COMPLETE ===');
    console.log(`Processed: ${processedCount}, Errors: ${errorCount}`);
    
    return {
        statusCode: 200,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With',
            'Access-Control-Max-Age': '86400'
        },
        body: JSON.stringify({ 
            message: 'SES event received and processed',
            recordsProcessed: event.Records.length,
            processedCount: processedCount,
            errorCount: errorCount,
            timestamp: new Date().toISOString()
        })
    };
}

async function storeEmailForUser(username, messageId, emailData) {
    console.log(`📧 Storing email for user: ${username}`);
    console.log(`Message ID: ${messageId}`);
    
    try {
        // First, look up the UID for this username using the new usernames structure
        console.log(`Looking up UID for username: ${username}`);
        const usernameRef = firebaseApp.database().ref(`usernames/${username}`);
        const usernameSnapshot = await usernameRef.once('value');
        
        if (!usernameSnapshot.exists()) {
            console.log(`❌ No user found for username: ${username}`);
            return;
        }
        
        const uid = usernameSnapshot.val();
        console.log(`✅ Found UID for ${username}: ${uid}`);
        
        if (!uid) {
            console.log(`❌ No UID found for username: ${username}`);
            return;
        }
        
        // Parse the complete multipart structure if it's a multipart email
        let emailStructure = null;
        let preferredContent = emailData.body;
        let contentType = emailData.headers.content_type || emailData.headers['content-type'] || '';
        
        if (contentType.includes('multipart/')) {
            const boundary = extractBoundary(contentType);
            if (boundary) {
                console.log('Parsing complete multipart structure...');
                emailStructure = parseMultipartStructure(emailData.body, boundary);
                if (emailStructure.preferredContent) {
                    preferredContent = emailStructure.preferredContent.content;
                    contentType = emailStructure.preferredContent.type;
                }
            }
        }
        
        // Create email record with comprehensive structure
        const emailRecord = {
            messageId: messageId,
            from: emailData.from,
            to: emailData.to,
            subject: emailData.subject,
            timestamp: Date.now(),
            content: preferredContent, // The preferred content (HTML or text)
            contentType: contentType,
            headers: {
                'content_type': emailData.headers.content_type || emailData.headers['content-type'] || '',
                'mime_version': emailData.headers['mime-version'] || '',
                'date': emailData.headers['date'] || '',
                'message_id': emailData.headers['message-id'] || ''
            },
            username: username,
            hasAttachments: emailStructure ? emailStructure.attachments.length > 0 : false,
            attachmentCount: emailStructure ? emailStructure.attachments.length : 0
        };
        
        // Add the complete structure if it exists
        if (emailStructure) {
            emailRecord.structure = emailStructure;
        }
        
        // Store email in Firebase using timestamp as key
        const emailKey = `email_${Date.now()}`;
        const firebasePath = `emails/${uid}/${emailKey}`;
        console.log(`📝 Storing email in Firebase at path: ${firebasePath}`);
        console.log(`📧 Email record preview:`, {
            messageId: emailRecord.messageId,
            subject: emailRecord.subject,
            contentType: emailRecord.contentType,
            hasAttachments: emailRecord.hasAttachments,
            attachmentCount: emailRecord.attachmentCount
        });
        
        const emailRef = firebaseApp.database().ref(firebasePath);
        await emailRef.set(emailRecord);
        console.log(`✅ Email stored in Firebase successfully`);
        
        // Update email count for inbox
        const emailCountsRef = firebaseApp.database().ref(`users/${uid}/emailCounts/inbox`);
        await emailCountsRef.transaction((currentCount) => {
            return (currentCount || 0) + 1;
        });
        console.log(`✅ Inbox email count updated`);
        
        // Log attachment details if any
        if (emailStructure && emailStructure.attachments.length > 0) {
            console.log(`📎 Attachments found:`, emailStructure.attachments.map(att => ({
                filename: att.filename,
                contentType: att.contentType,
                size: att.size
            })));
        }
        
        console.log(`📊 Updating user email statistics...`);
        // Update user's email statistics
        const userStatsRef = firebaseApp.database().ref(`users/${uid}/emailStats`);
        await userStatsRef.transaction((currentStats) => {
            if (currentStats === null) {
                return { totalEmails: 1, lastEmailTimestamp: emailRecord.timestamp };
            }
            return {
                totalEmails: currentStats.totalEmails + 1,
                lastEmailTimestamp: emailRecord.timestamp
            };
        });
        console.log(`✅ Email statistics updated`);
        
        console.log(`🎉 Email stored successfully for user ${username} (UID: ${uid}) in Firebase (S3 already handled by SES)`);
        
    } catch (error) {
        console.error(`Error storing email for user ${username}:`, error);
    }
}



function decodeQuotedPrintable(str) {
    if (!str) return str;
    
    console.log('Decoding quoted-printable string, length:', str.length);
    
    // Remove soft line breaks first (=\r\n, =\n, =\r)
    let decoded = str.replace(/=\r?\n/g, '');
    
    // Build a buffer from the hex sequences
    const buffer = Buffer.alloc(decoded.length);
    let bufferIndex = 0;
    let i = 0;
    
    while (i < decoded.length) {
        if (decoded[i] === '=' && i + 2 < decoded.length) {
            const hex = decoded.substring(i + 1, i + 3);
            if (/^[A-Fa-f0-9]{2}$/.test(hex)) {
                try {
                    buffer[bufferIndex++] = parseInt(hex, 16);
                    i += 3;
                    continue;
                } catch (e) {
                    console.warn('Failed to decode hex sequence:', hex);
                }
            }
        }
        buffer[bufferIndex++] = decoded.charCodeAt(i);
        i++;
    }
    
    // Convert buffer to UTF-8 string
    try {
        decoded = buffer.slice(0, bufferIndex).toString('utf8');
    } catch (e) {
        console.warn('Failed to convert buffer to UTF-8:', e);
        // Fallback to original method
        decoded = str.replace(/=\r?\n/g, '').replace(/=([A-Fa-f0-9]{2})/g, (match, hex) => {
            try {
                return String.fromCharCode(parseInt(hex, 16));
            } catch (e) {
                return match;
            }
        });
    }
    
    console.log('Decoded string preview:', decoded.substring(0, 200) + '...');
    return decoded;
}

function decodeHtmlEntities(str) {
    if (!str) return str;
    
    // Common HTML entities
    const htmlEntities = {
        '&quot;': '"',
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&nbsp;': ' ',
        '&apos;': "'",
        '&#39;': "'",
        '&ldquo;': '"',
        '&rdquo;': '"',
        '&lsquo;': "'",
        '&rsquo;': "'",
        '&mdash;': '—',
        '&ndash;': '–',
        '&hellip;': '…',
        '&copy;': '©',
        '&reg;': '®',
        '&trade;': '™'
    };
    
    // Replace HTML entities
    let decoded = str;
    for (const [entity, replacement] of Object.entries(htmlEntities)) {
        decoded = decoded.replace(new RegExp(entity, 'g'), replacement);
    }
    
    // Also handle numeric HTML entities like &#8217; (right single quotation mark)
    decoded = decoded.replace(/&#(\d+);/g, (match, num) => {
        try {
            return String.fromCharCode(parseInt(num, 10));
        } catch (e) {
            return match; // Return original if decoding fails
        }
    });
    
    // Handle hex HTML entities like &#x2019; (right single quotation mark)
    decoded = decoded.replace(/&#x([A-Fa-f0-9]+);/g, (match, hex) => {
        try {
            return String.fromCharCode(parseInt(hex, 16));
        } catch (e) {
            return match; // Return original if decoding fails
        }
    });
    
    return decoded;
}

// Decode RFC 2047 encoded subjects (e.g., =?UTF-8?Q?Subject?=)
function decodeRfc2047(str) {
    if (!str) return str;
    
    // Pattern to match RFC 2047 encoded words: =?charset?encoding?encoded-text?=
    const rfc2047Pattern = /=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi;
    
    return str.replace(rfc2047Pattern, (match, charset, encoding, encodedText) => {
        try {
            let decodedText;
            
            if (encoding.toUpperCase() === 'B') {
                // Base64 encoding
                decodedText = Buffer.from(encodedText, 'base64').toString(charset.toLowerCase());
            } else if (encoding.toUpperCase() === 'Q') {
                // For quoted-printable, we need to decode the bytes first, then convert charset
                let decodedBytes;
                
                // Remove soft line breaks first (=\r\n, =\n, =\r)
                let cleanedText = encodedText.replace(/=\r?\n/g, '');
                
                // Build a buffer from the hex sequences
                const buffer = Buffer.alloc(cleanedText.length);
                let bufferIndex = 0;
                let i = 0;
                
                while (i < cleanedText.length) {
                    if (cleanedText[i] === '=' && i + 2 < cleanedText.length) {
                        const hex = cleanedText.substring(i + 1, i + 3);
                        if (/^[A-Fa-f0-9]{2}$/.test(hex)) {
                            try {
                                buffer[bufferIndex++] = parseInt(hex, 16);
                                i += 3;
                                continue;
                            } catch (e) {
                                console.warn('Failed to decode hex sequence:', hex);
                            }
                        }
                    }
                    buffer[bufferIndex++] = cleanedText.charCodeAt(i);
                    i++;
                }
                
                // Convert from the specified charset to UTF-8
                try {
                    const charsetLower = charset.toLowerCase();
                    if (charsetLower === 'iso-8859-1' || charsetLower === 'latin1') {
                        decodedText = buffer.slice(0, bufferIndex).toString('latin1');
                    } else if (charsetLower === 'utf-8') {
                        decodedText = buffer.slice(0, bufferIndex).toString('utf8');
                    } else {
                        // Fallback to UTF-8
                        decodedText = buffer.slice(0, bufferIndex).toString('utf8');
                    }
                } catch (e) {
                    console.warn('Failed to convert charset:', charset, e);
                    decodedText = buffer.slice(0, bufferIndex).toString('utf8');
                }
                
                // Convert underscores to spaces (RFC 2047 specific)
                decodedText = decodedText.replace(/_/g, ' ');
            } else {
                // Unknown encoding, return original
                return match;
            }
            
            return decodedText;
        } catch (e) {
            console.warn('Failed to decode RFC 2047:', match, e);
            return match; // Return original if decoding fails
        }
    });
}

function extractBoundary(contentType) {
    // e.g., multipart/alternative; boundary="000000000000196439063986888e"
    // or multipart/alternative; boundary=----_NmP-e952c569eecf1ee8-Part_1
    const match = contentType.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i);
    if (match) {
        console.log('Extracted boundary:', match[1]);
        return match[1];
    }
    console.log('No boundary found in content type:', contentType);
    return null;
}

function extractMimePart(rawBody, boundary, preferHtml = true) {
    if (!boundary) return { body: rawBody, content_type: 'text/plain' };
    
    console.log('Extracting MIME parts with boundary:', boundary);
    console.log('Raw body preview:', rawBody.substring(0, 200) + '...');
    
    // Split by boundary, handling both \r\n and \n line endings
    // The boundary in the content already includes the -- prefix
    const boundaryPattern = new RegExp(`${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[\r\n]*`, 'g');
    const parts = rawBody.split(boundaryPattern);
    
    console.log('Found', parts.length, 'parts');
    
    let htmlPart = null, textPart = null;
    
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const trimmed = part.trim();
        
        // Skip empty parts or boundary markers
        if (!trimmed || trimmed === '--' || trimmed === '') continue;
        
        console.log(`Processing part ${i}:`, trimmed.substring(0, 100) + '...');
        
        // Find Content-Type and Content-Transfer-Encoding for this part
        const typeMatch = trimmed.match(/Content-Type:\s*([^\s;]+)/i);
        const encodingMatch = trimmed.match(/Content-Transfer-Encoding:\s*([^\s]+)/i);
        const contentType = typeMatch ? typeMatch[1].toLowerCase() : '';
        const encoding = encodingMatch ? encodingMatch[1].toLowerCase() : '';
        
        console.log('Part content type:', contentType, 'encoding:', encoding);
        
        // Extract the body (after the first blank line)
        const bodyMatch = trimmed.match(/\r?\n\r?\n(.*)/s);
        if (!bodyMatch) {
            console.log('No body found in part, skipping');
            continue;
        }
        
        const body = bodyMatch[1].trim();
        console.log('Body length:', body.length);
        
        // Check if this is a nested multipart
        if (contentType.startsWith('multipart/')) {
            console.log('Found nested multipart, extracting boundary and recursing...');
            const nestedBoundary = extractBoundary(trimmed);
            if (nestedBoundary) {
                console.log('Recursively extracting nested multipart with boundary:', nestedBoundary);
                const nestedResult = extractMimePart(body, nestedBoundary, preferHtml);
                if (nestedResult.content_type === 'text/html' && !htmlPart) {
                    htmlPart = { body: nestedResult.body, encoding };
                    console.log('Found HTML part from nested multipart');
                } else if (nestedResult.content_type === 'text/plain' && !textPart) {
                    textPart = { body: nestedResult.body, encoding };
                    console.log('Found text part from nested multipart');
                }
            }
        } else if (contentType === 'text/html' && body && !htmlPart) {
            htmlPart = { body, encoding };
            console.log('Found HTML part');
        } else if (contentType === 'text/plain' && body && !textPart) {
            textPart = { body, encoding };
            console.log('Found text part');
        } else {
            console.log('Unknown content type or empty body:', contentType);
        }
    }
    
    if (preferHtml && htmlPart) {
        let body = htmlPart.body;
        console.log('Processing HTML part with encoding:', htmlPart.encoding);
        
        if (htmlPart.encoding === 'quoted-printable') {
            console.log('Decoding quoted-printable HTML...');
            body = decodeQuotedPrintable(body);
        }
        
        // Decode HTML entities for HTML content
        console.log('Decoding HTML entities...');
        body = decodeHtmlEntities(body);
        
        // Clean up any remaining boundary markers
        body = body.replace(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}--?$`, 'g'), '').trim();
        
        console.log('Final HTML body preview:', body.substring(0, 200) + '...');
        return { body, content_type: 'text/html' };
    }
    
    if (textPart) {
        let body = textPart.body;
        console.log('Processing text part with encoding:', textPart.encoding);
        
        if (textPart.encoding === 'quoted-printable') {
            console.log('Decoding quoted-printable text...');
            body = decodeQuotedPrintable(body);
        }
        
        // Clean up any remaining boundary markers
        body = body.replace(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}--?$`, 'g'), '').trim();
        
        console.log('Final text body preview:', body.substring(0, 200) + '...');
        return { body, content_type: 'text/plain' };
    }
    
    console.log('No valid parts found, returning raw body');
    return { body: rawBody, content_type: 'text/plain' };
}

function parseEmailContent(content) {
    try {
        const lines = content.split('\n');
        const headers = {};
        let body = '';
        let subject = '';
        let inBody = false;
        let transferEncoding = '';
        let currentHeader = null;
        let currentValue = '';

        for (const line of lines) {
            if (!inBody) {
                if (line.trim() === '') {
                    inBody = true;
                    // Save the last header if we have one
                    if (currentHeader) {
                        headers[currentHeader] = currentValue.trim();
                        if (currentHeader === 'content-transfer-encoding') {
                            transferEncoding = currentValue.trim().toLowerCase();
                        }
                    }
                    continue;
                }
                
                // Check if this is a continuation line (starts with whitespace)
                if (line.match(/^\s/) && currentHeader) {
                    // This is a continuation of the previous header
                    currentValue += ' ' + line.trim();
                } else {
                    // Save the previous header if we have one
                    if (currentHeader) {
                        headers[currentHeader] = currentValue.trim();
                        if (currentHeader === 'content-transfer-encoding') {
                            transferEncoding = currentValue.trim().toLowerCase();
                        }
                    }
                    
                    // Start a new header
                    const colonIndex = line.indexOf(':');
                    if (colonIndex > 0) {
                        currentHeader = line.substring(0, colonIndex).trim().toLowerCase();
                        currentValue = line.substring(colonIndex + 1).trim();
                    } else {
                        currentHeader = null;
                        currentValue = '';
                    }
                }
            } else {
                body += line + '\n';
            }
        }

        // Decode quoted-printable if needed
        if (transferEncoding === 'quoted-printable') {
            subject = decodeQuotedPrintable(headers['subject']);
            body = decodeQuotedPrintable(body);
        } else {
            subject = headers['subject'] || '';
        }
        
        // Decode RFC 2047 encoded subject
        subject = decodeRfc2047(subject);

        return {
            from: headers['from'] || '',
            to: headers['to'] || '',
            subject: subject,
            headers: headers,
            body: body.trim()
        };
    } catch (error) {
        console.error('Error parsing email content:', error);
        return {
            from: '',
            to: '',
            subject: '',
            headers: {},
            body: content
        };
    }
}
async function handleUpload(event, userId, headers) {
    console.log('Raw event body:', event.body);
    console.log('Is base64 encoded:', event.isBase64Encoded);
    
    let body;
    try {
        // Decode base64 if necessary before parsing
        const decodedBody = event.isBase64Encoded 
            ? Buffer.from(event.body, 'base64').toString('utf-8')
            : event.body;
            
        console.log('Decoded body:', decodedBody);
        body = typeof decodedBody === 'string' ? JSON.parse(decodedBody) : decodedBody;
        console.log('Parsed body:', body);
    } catch (error) {
        console.error('Error parsing request body:', error);
        console.error('Failed to parse body:', event.body);
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Invalid request body' })
        };
    }

    const contentType = body.contentType;
    const userRef = firebaseInitializer.firebaseApp.database().ref(`users/${userId}/currentChallenge`);
    const snapshot = await userRef.once('value');
    let challengeId = snapshot.val();
    if(!challengeId) { challengeId = '0'; }
    
    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'video/mp4'];
    if (!allowedTypes.includes(contentType)) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Invalid file type' })
        };
    }

    // Generate a unique filename using userId, challengeId and timestamp
    const timestamp = Date.now();
    const fileExtension = getFileExtension(contentType);
    const filename = `challenges/${userId}/${challengeId}/${timestamp}${fileExtension}`;

    console.log('Generating presigned URL with params:', {
        Bucket: 'www.voicecert.com',
        Key: filename,
        ContentType: contentType,
        Expires: 300
    });

    // Generate presigned URL for upload
    const presignedUrl = await s3.getSignedUrlPromise('putObject', {
        Bucket: 'www.voicecert.com',
        Key: filename,
        ContentType: contentType,
        Expires: 300
    });

    console.log('Generated presigned URL:', presignedUrl);

    // Return the upload URL and the final file URL
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            uploadUrl: presignedUrl,
            fileUrl: `https://www.voicecert.com/${filename}`
        })
    };
}

// Helper function to get file extension from MIME type
function getFileExtension(mimeType) {
    const mimeToExt = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'video/mp4': '.mp4'
    };
    return mimeToExt[mimeType] || '';
}

async function handleSetupEmail(event, decodedToken, headers) {
    try {
        let body;
        try {
            const decodedBody = event.isBase64Encoded 
                ? Buffer.from(event.body, 'base64').toString('utf-8')
                : event.body;
            body = typeof decodedBody === 'string' ? JSON.parse(decodedBody) : decodedBody;
        } catch (error) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Invalid request body' })
            };
        }

        const { username } = body;
        const uid = decodedToken.uid;
        const email = `${username}@voicecert.com`;

        if (!username) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Username is required' })
            };
        }

        // Check if this email is already mapped to another user
        const existingRef = firebaseApp.database().ref(`userEmails/${email}`);
        const existingSnapshot = await existingRef.once('value');
        
        if (existingSnapshot.exists()) {
            const existingData = existingSnapshot.val();
            if (existingData.uid !== uid) {
                return {
                    statusCode: 409,
                    headers,
                    body: JSON.stringify({ error: 'Email already mapped to another user' })
                };
            }
        }

        // Store the email mapping
        await existingRef.set({ uid: uid });

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ 
                message: 'Email setup successful',
                email: email,
                username: username
            })
        };

    } catch (error) {
        console.error('Error setting up email:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
}

async function handleGetEmails(event, uid, headers) {
    try {
        // Parse query parameters for pagination
        const queryParams = event.queryStringParameters || {};
        const limit = parseInt(queryParams.limit) || 20; // Default 20 emails per page
        const startAfter = queryParams.startAfter; // Timestamp to start after
        const endBefore = queryParams.endBefore; // Timestamp to end before
        const searchTerm = queryParams.search; // Search in subject or content
        
        // Validate limit
        if (limit > 100) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Limit cannot exceed 100' })
            };
        }
        
        let emailsRef = firebaseApp.database().ref(`emails/${uid}`).orderByChild('timestamp');
        
        // Apply pagination filters
        if (startAfter) {
            emailsRef = emailsRef.startAfter(parseInt(startAfter));
        }
        if (endBefore) {
            emailsRef = emailsRef.endBefore(parseInt(endBefore));
        }
        
        // Get emails (most recent first, so we use limitToLast)
        const snapshot = await emailsRef.limitToLast(limit).once('value');
        
        const emails = [];
        snapshot.forEach((childSnapshot) => {
            const email = {
                id: childSnapshot.key,
                ...childSnapshot.val()
            };
            
            // Apply search filter if provided
            if (!searchTerm || 
                email.subject?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                email.content?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                email.from?.toLowerCase().includes(searchTerm.toLowerCase())) {
                emails.push(email);
            }
        });
        
        // Reverse to get most recent first
        emails.reverse();
        
        // Get pagination metadata
        const hasMore = emails.length === limit;
        const firstTimestamp = emails.length > 0 ? emails[0].timestamp : null;
        const lastTimestamp = emails.length > 0 ? emails[emails.length - 1].timestamp : null;
        
        // Get total count for this user (cached in user stats)
        const userStatsRef = firebaseApp.database().ref(`users/${uid}/emailStats`);
        const statsSnapshot = await userStatsRef.once('value');
        const stats = statsSnapshot.val() || { totalEmails: 0 };
        
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ 
                emails: emails,
                pagination: {
                    hasMore: hasMore,
                    totalEmails: stats.totalEmails,
                    returned: emails.length,
                    limit: limit,
                    nextPageStartAfter: hasMore ? lastTimestamp : null,
                    prevPageEndBefore: firstTimestamp
                }
            })
        };

    } catch (error) {
        console.error('Error getting emails:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
}

async function handleGetEmailStats(event, uid, headers) {
    try {
        const userStatsRef = firebaseApp.database().ref(`users/${uid}/emailStats`);
        const statsSnapshot = await userStatsRef.once('value');
        const stats = statsSnapshot.val() || { totalEmails: 0, lastEmailTimestamp: null };
        
        // Get recent email activity (last 7 days)
        const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        const recentEmailsRef = firebaseApp.database().ref(`emails/${uid}`)
            .orderByChild('timestamp')
            .startAt(sevenDaysAgo);
        
        const recentSnapshot = await recentEmailsRef.once('value');
        let recentCount = 0;
        recentSnapshot.forEach(() => { recentCount++; });
        
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ 
                stats: {
                    totalEmails: stats.totalEmails,
                    recentEmails: recentCount,
                    lastEmailTimestamp: stats.lastEmailTimestamp,
                    lastEmailDate: stats.lastEmailTimestamp ? new Date(stats.lastEmailTimestamp).toISOString() : null
                }
            })
        };

    } catch (error) {
        console.error('Error getting email stats:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
}

async function handleSendEmail(event, decodedToken, headers) {
    try {
        let body;
        try {
            const decodedBody = event.isBase64Encoded 
                ? Buffer.from(event.body, 'base64').toString('utf-8')
                : event.body;
            body = typeof decodedBody === 'string' ? JSON.parse(decodedBody) : decodedBody;
        } catch (error) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Invalid request body' })
            };
        }

        const { to, subject, body: emailBody } = body;
        const uid = decodedToken.uid;

        if (!to || !subject || !emailBody) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'to, subject, and body are required' })
            };
        }

        // Basic email validation
        if (!to.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Invalid email address format' })
            };
        }

        // Get sender's username from profile
        const profileRef = firebaseApp.database().ref(`users/${uid}/profile`);
        const profileSnapshot = await profileRef.once('value');
        
        if (!profileSnapshot.exists() || !profileSnapshot.val().username) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'User profile not found or username not set' })
            };
        }

        const senderUsername = profileSnapshot.val().username;
        const senderEmail = `${senderUsername}@voicecert.com`;

        // Send email via SES
        const ses = new AWS.SES({ region: 'us-east-1' });
        
        const emailParams = {
            Source: senderEmail,
            Destination: {
                ToAddresses: [to]
            },
            Message: {
                Subject: {
                    Data: subject,
                    Charset: 'UTF-8'
                },
                Body: {
                    Text: {
                        Data: emailBody,
                        Charset: 'UTF-8'
                    }
                }
            }
        };

        console.log('Attempting to send email via SES with params:', JSON.stringify(emailParams, null, 2));
        
        const sesResult = await ses.sendEmail(emailParams).promise();
        console.log('Email sent via SES successfully:', sesResult);
        console.log('Email will be processed by SES receipt rule and stored in Firebase automatically');
        
        // Update sent email count
        const sentCountsRef = firebaseApp.database().ref(`users/${uid}/emailCounts/sent`);
        await sentCountsRef.transaction((currentCount) => {
            return (currentCount || 0) + 1;
        });
        console.log(`✅ Sent email count updated`);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ 
                message: 'Email sent successfully',
                messageId: sesResult.MessageId
            })
        };

    } catch (error) {
        console.error('Error sending email:', error);
        
        // Handle SES-specific errors
        if (error.code === 'MessageRejected') {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ 
                    error: 'Email rejected by SES. The domain may not be verified or SES may be in sandbox mode.',
                    details: error.message 
                })
            };
        } else if (error.code === 'ConfigurationSetDoesNotExist') {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ 
                    error: 'SES configuration error. Please contact support.',
                    details: error.message 
                })
            };
        }
        
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ 
                error: 'Failed to send email',
                details: error.message 
            })
        };
    }
}

function parseMultipartStructure(rawBody, boundary) {
    if (!boundary) {
        return {
            type: 'simple',
            content: rawBody,
            headers: {}
        };
    }
    
    console.log('Parsing multipart structure with boundary:', boundary);
    
    // Split by boundary, handling both \r\n and \n line endings
    const boundaryPattern = new RegExp(`${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[\r\n]*`, 'g');
    const parts = rawBody.split(boundaryPattern);
    
    console.log('Found', parts.length, 'parts in multipart structure');
    
    const structure = {
        type: 'multipart',
        boundary: boundary,
        parts: {},
        attachments: [],
        preferredContent: null
    };
    
    let partIndex = 0;
    
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const trimmed = part.trim();
        
        // Skip empty parts or boundary markers
        if (!trimmed || trimmed === '--' || trimmed === '') continue;
        
        console.log(`Processing part ${partIndex}:`, trimmed.substring(0, 100) + '...');
        
        // Parse headers for this part
        const headers = {};
        const bodyMatch = trimmed.match(/\r?\n\r?\n(.*)/s);
        
        if (!bodyMatch) {
            console.log('No body found in part, skipping');
            continue;
        }
        
        // Extract headers (everything before the first blank line)
        const headerSection = trimmed.substring(0, trimmed.indexOf('\r\n\r\n') !== -1 ? 
            trimmed.indexOf('\r\n\r\n') : trimmed.indexOf('\n\n'));
        
        // Parse headers
        const headerLines = headerSection.split(/\r?\n/);
        let currentHeader = null;
        let currentValue = '';
        
        for (const line of headerLines) {
            if (line.match(/^\s/) && currentHeader) {
                // Continuation line
                currentValue += ' ' + line.trim();
            } else {
                // Save previous header if we have one
                if (currentHeader) {
                    headers[currentHeader.toLowerCase()] = currentValue.trim();
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
            headers[currentHeader.toLowerCase()] = currentValue.trim();
        }
        
        const body = bodyMatch[1].trim();
        const contentType = headers['content-type'] || '';
        const contentDisposition = headers['content-disposition'] || '';
        const filename = extractFilename(contentDisposition);
        
        // Create part object
        const partKey = `part_${partIndex}`;
        const partObj = {
            headers: headers,
            body: body,
            contentType: contentType,
            contentDisposition: contentDisposition,
            filename: filename,
            encoding: headers['content-transfer-encoding'] || '',
            size: body.length
        };
        
        // Check if this is a nested multipart
        if (contentType.startsWith('multipart/')) {
            const nestedBoundary = extractBoundary(contentType);
            if (nestedBoundary) {
                console.log('Found nested multipart, recursing...');
                const nestedStructure = parseMultipartStructure(body, nestedBoundary);
                partObj.nestedStructure = nestedStructure;
                
                // Set preferred content from nested structure
                if (nestedStructure.preferredContent) {
                    structure.preferredContent = nestedStructure.preferredContent;
                }
            }
        } else {
            // This is a content part
            partObj.decodedBody = decodePartContent(body, headers['content-transfer-encoding'] || '');
            
            // Set preferred content (HTML first, then text)
            if (contentType.includes('text/html')) {
                // Always prefer HTML over text/plain
                structure.preferredContent = {
                    type: 'text/html',
                    content: partObj.decodedBody,
                    partKey: partKey
                };
            } else if (contentType.includes('text/plain') && !structure.preferredContent) {
                // Only use text/plain if we don't have HTML
                structure.preferredContent = {
                    type: 'text/plain',
                    content: partObj.decodedBody,
                    partKey: partKey
                };
            }
        }
        
        // Check if this is an attachment
        if (contentDisposition.includes('attachment') || 
            (contentType && !contentType.includes('text/') && !contentType.includes('multipart/'))) {
            
            const attachment = {
                partKey: partKey,
                filename: filename,
                contentType: contentType,
                size: body.length,
                contentDisposition: contentDisposition
            };
            
            // For text-based attachments, include decoded content
            if (contentType.includes('text/') || contentType.includes('application/json') || 
                contentType.includes('application/xml') || contentType.includes('message/')) {
                attachment.content = partObj.decodedBody;
            } else {
                // For binary attachments, store base64 content
                attachment.content = body;
                attachment.encoding = 'base64';
            }
            
            structure.attachments.push(attachment);
            partObj.isAttachment = true;
        }
        
        structure.parts[partKey] = partObj;
        partIndex++;
    }
    
    console.log(`Parsed structure with ${Object.keys(structure.parts).length} parts and ${structure.attachments.length} attachments`);
    return structure;
}

function extractFilename(contentDisposition) {
    if (!contentDisposition) return null;
    
    // Try to extract filename from Content-Disposition header
    const filenameMatch = contentDisposition.match(/filename\s*=\s*"?([^";\r\n]+)"?/i);
    if (filenameMatch) {
        return filenameMatch[1];
    }
    
    return null;
}

function decodePartContent(body, encoding) {
    if (!encoding) return body;
    
    switch (encoding.toLowerCase()) {
        case 'quoted-printable':
            return decodeQuotedPrintable(body);
        case 'base64':
            try {
                return Buffer.from(body, 'base64').toString('utf-8');
            } catch (e) {
                console.warn('Failed to decode base64 content:', e);
                return body;
            }
        default:
            return body;
    }
}

async function handleDeleteEmail(event, uid, headers) {
    try {
        let body;
        try {
            const decodedBody = event.isBase64Encoded 
                ? Buffer.from(event.body, 'base64').toString('utf-8')
                : event.body;
            body = typeof decodedBody === 'string' ? JSON.parse(decodedBody) : decodedBody;
        } catch (error) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Invalid request body' })
            };
        }

        const { emailId, folder } = body;

        if (!emailId || !folder) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'emailId and folder are required' })
            };
        }

        if (!['inbox', 'sent'].includes(folder)) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'folder must be either "inbox" or "sent"' })
            };
        }

        // Delete the email
        const emailRef = firebaseApp.database().ref(`${folder}/${uid}/${emailId}`);
        await emailRef.remove();

        // Decrement the email count
        const emailCountsRef = firebaseApp.database().ref(`users/${uid}/emailCounts/${folder}`);
        await emailCountsRef.transaction((currentCount) => {
            return Math.max(0, (currentCount || 0) - 1);
        });

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ 
                message: 'Email deleted successfully'
            })
        };

    } catch (error) {
        console.error('Error deleting email:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
}

// Export functions for testing
module.exports = {
    handler: exports.handler,
    decodeQuotedPrintable,
    decodeHtmlEntities,
    decodeRfc2047,
    extractBoundary,
    extractMimePart,
    parseEmailContent,
    parseMultipartStructure,
    extractFilename,
    decodePartContent
};