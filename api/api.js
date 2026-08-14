const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const crypto = require('crypto');
const path = require('path');

// Inline image token: signed token for cid: image URLs so img src can use a stable, cacheable URL
const INLINE_IMAGE_TOKEN_EXPIRY_SEC = 24 * 60 * 60; // 24 hours - same URL for a day = good browser cache
const INLINE_IMAGE_CACHE_MAX_AGE = 60 * 60; // 1 hour - Cache-Control for the image response

function getInlineImageSecret(config) {
    return process.env.INLINE_IMAGE_SECRET || (config && config.firebaseConfig && config.firebaseConfig.projectId) || 'vcmail-inline-image-default';
}

function createInlineImageToken(uid, emailId, contentId, folder, config) {
    const exp = Math.floor(Date.now() / 1000) + INLINE_IMAGE_TOKEN_EXPIRY_SEC;
    const payload = { uid, emailId, contentId: String(contentId), folder, exp };
    const payloadStr = JSON.stringify(payload);
    const payloadB64 = Buffer.from(payloadStr, 'utf-8').toString('base64url');
    const secret = getInlineImageSecret(config);
    const sig = crypto.createHmac('sha256', secret).update(payloadStr).digest('base64url');
    return `${payloadB64}.${sig}`;
}

function verifyInlineImageToken(token, config) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    try {
        const payloadStr = Buffer.from(parts[0], 'base64url').toString('utf-8');
        const payload = JSON.parse(payloadStr);
        const secret = getInlineImageSecret(config);
        const expectedSig = crypto.createHmac('sha256', secret).update(payloadStr).digest('base64url');
        if (expectedSig !== parts[1]) return null;
        if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
        return payload;
    } catch (e) {
        return null;
    }
}

// Load base configuration - in Lambda, we don't use config files
// Domain-specific config is loaded from SSM at runtime
let baseConfig = {};
try {
    // In Lambda, AWS_REGION is automatically provided by the runtime
    // We don't need to load from config file - domain-specific config comes from SSM
    baseConfig = {
        awsRegion: process.env.AWS_REGION || 'us-east-1'
    };
} catch (error) {
    console.warn('Could not load base config, using defaults:', error.message);
    baseConfig = {
        awsRegion: process.env.AWS_REGION || 'us-east-1'
    };
}

// Domain-specific config cache (keyed by domain)
// Each cached config includes: domain config, Firebase app, and AWS service clients
const domainConfigCache = new Map();

// SSM client for loading domain-specific config (reused across all domains)
const ssm = new SSMClient({
    region: baseConfig.awsRegion || process.env.AWS_REGION || 'us-east-1'
});

function isParameterNotFound(err) {
    return err && (err.name === 'ParameterNotFound' || err.code === 'ParameterNotFound');
}

function isS3NotFound(err) {
    return err && (
        err.name === 'NotFound' ||
        err.name === 'NoSuchKey' ||
        err.code === 'NotFound' ||
        err.code === 'NoSuchKey' ||
        err.$metadata?.httpStatusCode === 404
    );
}

function exposeErrorDetailsToClient() {
    return (
        process.env.VCMAIL_EXPOSE_ERROR_DETAILS === '1' ||
        process.env.NODE_ENV === 'development'
    );
}

/**
 * JSON body for API Gateway proxy errors. Clients often surface `message` only; we mirror the real
 * text there and in `error`, plus `errorCode` and `requestId` (Lambda) for CloudWatch correlation.
 */
function buildApiErrorJsonBody(err, context) {
    const msg = err && err.message ? String(err.message) : String(err || 'Unexpected error');
    const code = err && (err.code || err.name) ? String(err.code || err.name) : 'Error';
    const body = {
        error: msg,
        message: msg,
        errorCode: code
    };
    if (context && context.awsRequestId) {
        body.requestId = context.awsRequestId;
    }
    if (exposeErrorDetailsToClient() && err && err.stack) {
        body.details = String(err.stack).slice(0, 4000);
    }
    return JSON.stringify(body);
}

function json500Headers(baseHeaders) {
    return {
        ...baseHeaders,
        'Content-Type': 'application/json'
    };
}

async function s3BodyToBuffer(body) {
    if (!body) return Buffer.alloc(0);
    if (typeof body.transformToByteArray === 'function') {
        return Buffer.from(await body.transformToByteArray());
    }
    const chunks = [];
    for await (const chunk of body) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function s3BodyToUtf8(body) {
    if (!body) return '';
    if (typeof body.transformToString === 'function') {
        return body.transformToString('utf-8');
    }
    return (await s3BodyToBuffer(body)).toString('utf-8');
}

/** Browser fetch() to S3 presigned URLs usually fails CORS; inline small .ics bodies in loadEmail JSON instead. */
const ICS_ATTACHMENT_INLINE_MAX_BYTES = 512 * 1024;

function isIcsLikeAttachmentMeta({ filename, contentType }) {
    const fn = (filename || '').toLowerCase();
    const ct = (contentType || '').toLowerCase();
    return fn.endsWith('.ics') || ct.includes('text/calendar') || ct === 'application/ics';
}

async function tryAddInlineIcsBodyToAttachmentEntry(attEntry, s3Key, sizeHint, s3Client, bucketName, logPrefix = '') {
    if (!s3Key || !attEntry || !isIcsLikeAttachmentMeta(attEntry)) return;
    const hint = Number(sizeHint) || 0;
    if (hint > ICS_ATTACHMENT_INLINE_MAX_BYTES) {
        console.log(`[EMAIL] ICS skip inline (declared size): ${logPrefix}${attEntry.filename}`);
        return;
    }
    if (!hint || hint <= 0) {
        try {
            const head = await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: s3Key }));
            const cl = head.ContentLength || 0;
            if (cl > ICS_ATTACHMENT_INLINE_MAX_BYTES) {
                console.log(`[EMAIL] ICS skip inline (S3 size ${cl}): ${logPrefix}${attEntry.filename}`);
                return;
            }
        } catch (e) {
            console.warn(`[EMAIL] ICS HeadObject failed, skip inline (${s3Key}):`, e.message);
            return;
        }
    }
    try {
        const result = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: s3Key }));
        const bodyBuf = await s3BodyToBuffer(result.Body);
        if (bodyBuf.length > ICS_ATTACHMENT_INLINE_MAX_BYTES) {
            console.warn(`[EMAIL] ICS skip inline (read ${bodyBuf.length}b): ${attEntry.filename}`);
            return;
        }
        attEntry.content = bodyBuf.toString('base64');
        attEntry.encoding = 'base64';
        console.log(`[OK] Inlined ICS (${bodyBuf.length}b) ${logPrefix}${attEntry.filename}`);
    } catch (e) {
        console.warn(`[EMAIL] Inline ICS GetObject failed (${attEntry.filename}):`, e.message);
    }
}

async function presignGetObject(s3Client, { bucket, key, expiresIn, responseContentDisposition }) {
    const input = { Bucket: bucket, Key: key };
    if (responseContentDisposition) {
        input.ResponseContentDisposition = responseContentDisposition;
    }
    return getSignedUrl(s3Client, new GetObjectCommand(input), { expiresIn });
}

async function presignPutObject(s3Client, { bucket, key, contentType, expiresIn }) {
    return getSignedUrl(
        s3Client,
        new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
        { expiresIn }
    );
}

// Helper functions (inlined to avoid requiring lib/config.js which needs fs-extra)
function sanitizeDomainForAWS(domain) {
    if (!domain) return 'example-com';
    return domain.replace(/\./g, '-').toLowerCase();
}

function deriveSSMPrefix(domain) {
    return `/${sanitizeDomainForAWS(domain || 'example.com')}/prod`;
}

function deriveS3BucketName(domain) {
    return `${sanitizeDomainForAWS(domain || 'example.com')}-mail-inbox`;
}

function deriveProjectName(domain) {
    return `${sanitizeDomainForAWS(domain || 'example.com')}-mail`;
}

/**
 * Extract domain from Host header (for API Gateway/CloudFront requests)
 * Examples:
 *   mail.example.com -> example.com
 *   mail.subdomain.example.com -> subdomain.example.com
 *   example.com -> example.com
 */
function extractDomainFromHost(host) {
    if (!host) return null;
    
    // Remove port if present
    const hostWithoutPort = host.split(':')[0];
    
    // If it starts with "mail.", remove that prefix
    if (hostWithoutPort.startsWith('mail.')) {
        return hostWithoutPort.substring(5);
    }
    
    // Otherwise, return as-is (assuming it's the domain)
    return hostWithoutPort;
}

/**
 * Extract domain from SES recipient email
 */
function extractDomainFromRecipient(recipient) {
    if (!recipient || !recipient.includes('@')) return null;
    return recipient.split('@')[1];
}

/**
 * Load domain-specific configuration from SSM
 */
async function loadDomainConfig(domain) {
    if (!domain) {
        throw new Error('Domain is required to load configuration');
    }
    
    // Check cache first
    if (domainConfigCache.has(domain)) {
        return domainConfigCache.get(domain);
    }
    
    console.log(`[CONFIG] Loading configuration for domain: ${domain}`);
    
    // Derive SSM prefix from domain
    const ssmPrefix = deriveSSMPrefix(domain);
    const s3BucketName = deriveS3BucketName(domain);
    const projectName = deriveProjectName(domain);
    const awsRegion = baseConfig.awsRegion || process.env.AWS_REGION || 'us-east-1';
    
    // Load Firebase config from SSM
    // Try firebase_config first (contains databaseURL and projectId)
    // If that doesn't exist, load firebase_service_account and construct databaseURL
    let firebaseConfig = null;
    try {
        const firebaseParamName = `${ssmPrefix}/firebase_config`;
        console.log(`[CONFIG] Loading Firebase config from SSM: ${firebaseParamName}`);
        const firebaseResult = await ssm.send(new GetParameterCommand({
            Name: firebaseParamName,
            WithDecryption: true
        }));
        
        if (firebaseResult.Parameter?.Value) {
            firebaseConfig = JSON.parse(firebaseResult.Parameter.Value);
            console.log(`[CONFIG] Loaded Firebase config from firebase_config parameter`);
        }
    } catch (error) {
        if (isParameterNotFound(error)) {
            console.log(`[CONFIG] firebase_config parameter not found, trying firebase_service_account`);
        } else {
            console.warn(`[CONFIG] Could not load Firebase config from SSM: ${error.message}`);
        }
        
        // Try alternative: load service account and construct config
        try {
            const altParamName = `${ssmPrefix}/firebase_service_account`;
            console.log(`[CONFIG] Loading Firebase service account from SSM: ${altParamName}`);
            const altResult = await ssm.send(new GetParameterCommand({
                Name: altParamName,
                WithDecryption: true
            }));
            
            if (altResult.Parameter?.Value) {
                let paramValue = altResult.Parameter.Value.trim();
                let serviceAccount;
                
                // Parse service account JSON (handle base64 encoding)
                try {
                    const parsed = JSON.parse(paramValue);
                    if (typeof parsed === 'string') {
                        // Might be base64 encoded
                        try {
                            const decoded = Buffer.from(parsed, 'base64').toString('utf-8');
                            serviceAccount = JSON.parse(decoded);
                        } catch (e) {
                            serviceAccount = parsed;
                        }
                    } else {
                        serviceAccount = parsed;
                    }
                } catch (parseError) {
                    // Try base64 decoding
                    try {
                        const decoded = Buffer.from(paramValue, 'base64').toString('utf-8');
                        serviceAccount = JSON.parse(decoded);
                    } catch (base64Error) {
                        throw new Error('Invalid Firebase service account JSON format');
                    }
                }
                
                // Construct Firebase config from service account
                // NOTE: This is a fallback - the setup script should store the complete Firebase config
                // in SSM as {ssmPrefix}/firebase_config after discovering the correct database URL.
                // If this constructed URL is wrong (e.g., legacy format or custom database name),
                // manually store firebase_config in SSM with the correct databaseURL.
                const projectId = serviceAccount.project_id;
                firebaseConfig = {
                    projectId: projectId,
                    databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`
                };
                console.log(`[CONFIG] Constructed Firebase config from service account (fallback - prefer storing firebase_config in SSM)`);
            }
        } catch (altError) {
            console.warn(`[CONFIG] Could not load Firebase config from alternative SSM parameter: ${altError.message}`);
            // firebaseConfig remains null - will be handled by caller
        }
    }
    
    // Build domain-specific config
    const domainConfig = {
        domain: domain,
        s3BucketName: s3BucketName,
        ssmPrefix: ssmPrefix,
        awsRegion: awsRegion,
        projectName: projectName,
        configurationSetName: `${projectName}-email-config`,
        firebaseConfig: firebaseConfig
    };
    
    // Initialize Firebase app and add to config (if Firebase config is available)
    if (firebaseConfig && firebaseConfig.databaseURL) {
        try {
            console.log(`[CONFIG] Initializing Firebase app for domain: ${domain}`);
            domainConfig.firebaseApp = await firebaseInitializer.get(firebaseConfig.databaseURL, ssmPrefix);
            console.log(`[CONFIG] Firebase app initialized and cached for domain: ${domain}`);
        } catch (error) {
            console.error(`[CONFIG] Failed to initialize Firebase app for domain ${domain}:`, error);
            // Don't throw - let caller handle missing Firebase app
            domainConfig.firebaseApp = null;
        }
    } else {
        domainConfig.firebaseApp = null;
    }
    
    // Initialize and cache AWS service clients per domain
    // S3 client (region-specific)
    domainConfig.s3Client = new S3Client({ region: awsRegion });
    
    // SES client (region-specific, for sending emails)
    domainConfig.sesClient = new SESClient({ region: awsRegion });
    
    console.log(`[CONFIG] AWS service clients initialized for domain: ${domain}`);
    
    // Cache the complete config (includes Firebase app and AWS clients)
    domainConfigCache.set(domain, domainConfig);
    console.log(`[CONFIG] Complete configuration loaded and cached for domain: ${domain}`);
    
    return domainConfig;
}

// Initialize S3 client with base region (will be updated per request if needed)
const s3 = new S3Client({
    region: baseConfig.awsRegion || process.env.AWS_REGION || 'us-east-1'
});

// Parse Firebase config - don't throw at module load time, handle in handler
let firebaseConfig = null;
try {
    if (process.env.FIREBASE_CONFIG) {
        firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
    }
} catch (error) {
    console.error('Failed to parse FIREBASE_CONFIG at module load:', error);
    // Don't throw - let handler handle it
}

const firebaseInitializer = require('../firebaseInit');
const { decodeQuotedPrintable: decodeQuotedPrintableNew } = require('../decodeQuotedPrintable');

// Helper function to sanitize strings for logging (removes non-ASCII characters)
function sanitizeForLog(obj) {
    if (typeof obj === 'string') {
        return obj.replace(/[^\x00-\x7F]/g, '?');
    }
    if (Array.isArray(obj)) {
        return obj.map(item => sanitizeForLog(item));
    }
    if (obj && typeof obj === 'object') {
        const sanitized = {};
        for (const key in obj) {
            sanitized[key] = sanitizeForLog(obj[key]);
        }
        return sanitized;
    }
    return obj;
}

// Safe logging function that catches encoding errors
function safeLog(prefix, ...args) {
    try {
        // Stringify all arguments to avoid Unicode encoding issues
        // This prevents Node.js from trying to serialize objects which can cause encoding errors
        const stringArgs = args.map(arg => {
            try {
                const sanitized = sanitizeForLog(arg);
                // Always stringify objects/arrays to prevent Node.js serialization issues
                if (typeof sanitized === 'object' && sanitized !== null) {
                    return JSON.stringify(sanitized, null, 0);
                }
                return String(sanitized);
            } catch (e) {
                return '[Unable to serialize]';
            }
        });
        // Join all string arguments and log as a single string to avoid any encoding issues
        const logMessage = stringArgs.length > 0 
            ? `${prefix} ${stringArgs.join(' ')}`
            : prefix;
        console.log(logMessage);
    } catch (error) {
        // If logging fails, try to log at least the error message
        try {
            console.log(`${prefix} [LOG ERROR]: ${error.message}`);
        } catch (e) {
            // If even that fails, silently continue - don't let logging break the function
        }
    }
}


// Firebase initializer (Firebase apps are now cached within domain config objects)

exports.handler = async (event, context) => {
    // Define headers outside try-catch so they're always available
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With',
        'Access-Control-Max-Age': '86400',
        'Access-Control-Allow-Credentials': 'false'
    };
    
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With',
        'Access-Control-Max-Age': '86400'
    };
    
    // Domain-specific config for this request
    let config = null;
    let firebaseConfig = null;
    let firebaseApp = null;
    
    // Wrap entire handler in try-catch to catch any unhandled exceptions
    try {
        //console.log('Lambda started - full event:', JSON.stringify(event, null, 2));
        
        // Handle SES events first (these don't need Firebase)
        if (event.Records && event.Records[0].eventSource === 'aws:ses') {
            // Extract domain from SES recipients
            const ses = event.Records[0].ses;
            const recipients = ses?.mail?.destination || [];
            let detectedDomain = null;
            
            // Try to extract domain from first recipient
            for (const recipient of recipients) {
                const domain = extractDomainFromRecipient(recipient);
                if (domain) {
                    detectedDomain = domain;
                    break;
                }
            }
            
            if (!detectedDomain) {
                console.error('[ERROR] Could not detect domain from SES recipients');
                return {
                    statusCode: 500,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ 
                        error: 'Could not detect domain from SES event',
                        errorCode: 'ConfigurationError'
                    })
                };
            }
            
            console.log(`[SES] Detected domain from recipients: ${detectedDomain}`);
            
            // Load domain-specific config
            try {
                config = await loadDomainConfig(detectedDomain);
                firebaseConfig = config.firebaseConfig;
            } catch (error) {
                console.error(`[ERROR] Failed to load config for domain ${detectedDomain}:`, error);
                return {
                    statusCode: 500,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ 
                        error: `Failed to load configuration for domain ${detectedDomain}: ${error.message}`,
                        errorCode: 'ConfigurationError'
                    })
                };
            }
            
            if (!firebaseConfig || !firebaseConfig.databaseURL) {
                console.error('[ERROR] Firebase config not available for domain:', detectedDomain);
                return {
                    statusCode: 500,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ 
                        error: `Firebase configuration not found for domain ${detectedDomain}`,
                        errorCode: 'ConfigurationError'
                    })
                };
            }
            
            // Config is now loaded with Firebase app and AWS clients cached
            // Check if Firebase app is available
            if (!config.firebaseApp) {
                console.error('[ERROR] Firebase app not available for domain:', detectedDomain);
                return {
                    statusCode: 500,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ 
                        error: `Firebase app not initialized for domain ${detectedDomain}`,
                        errorCode: 'ConfigurationError'
                    })
                };
            }
            
            // Pass config (which includes firebaseApp) to handleSesEvent
            return await handleSesEvent(event, config);
        }

        // Handle OPTIONS requests for CORS (check multiple possible event formats)
        const httpMethod = event.httpMethod || 
                           event.requestContext?.http?.method || 
                           event.requestContext?.httpMethod ||
                           (event.requestContext?.routeKey?.includes('OPTIONS') ? 'OPTIONS' : null);
        
        if (httpMethod === 'OPTIONS') {
            console.log('Handling OPTIONS request for CORS');
            return {
                statusCode: 200,
                headers: corsHeaders,
                body: ''
            };
        }
        
        // Extract domain from Host header for API Gateway requests
        // CloudFront forwards requests, so we need to check multiple header sources
        const hostHeader = event.headers?.Host || 
                          event.headers?.host || 
                          event.headers?.['Host'] ||
                          event.headers?.['host'] ||
                          event.requestContext?.domainName ||
                          null;
        
        console.log('[API] Host header:', hostHeader);
        console.log('[API] All headers:', JSON.stringify(event.headers || {}, null, 2));
        
        // Helper to extract header value (handles both string and array formats)
        const getHeaderValue = (headerName) => {
            const value = event.headers?.[headerName] || 
                         event.headers?.[headerName.toLowerCase()] ||
                         null;
            // Handle array format (CloudFront sometimes sends headers as arrays)
            if (Array.isArray(value)) {
                return value[0] || null;
            }
            return value;
        };
        
        let detectedDomain = null;
        let domainSource = null;
        
        // First, check if Host header is API Gateway domain - if so, ignore it and check custom headers
        if (hostHeader && hostHeader.includes('execute-api')) {
            console.log('[API] Host header is API Gateway domain, checking custom headers...');
            
            // Try CloudFront custom header (configured in Terraform to forward mail_domain)
            const originalHost = getHeaderValue('X-Original-Host');
            console.log('[API] X-Original-Host header:', originalHost);
            if (originalHost) {
                detectedDomain = extractDomainFromHost(originalHost);
                domainSource = 'X-Original-Host';
                console.log('[API] Extracted domain from X-Original-Host header:', detectedDomain);
            }
            
            // Try X-Forwarded-Host header
            if (!detectedDomain) {
                const forwardedHost = getHeaderValue('X-Forwarded-Host');
                console.log('[API] X-Forwarded-Host header:', forwardedHost);
                if (forwardedHost) {
                    detectedDomain = extractDomainFromHost(forwardedHost);
                    domainSource = 'X-Forwarded-Host';
                    console.log('[API] Extracted domain from X-Forwarded-Host:', detectedDomain);
                }
            }
            
            // Try other custom headers (if configured via Lambda@Edge)
            if (!detectedDomain) {
                const customDomain = getHeaderValue('X-Custom-Domain');
                if (customDomain) {
                    detectedDomain = extractDomainFromHost(customDomain);
                    domainSource = 'X-Custom-Domain';
                    console.log('[API] Extracted domain from X-Custom-Domain header:', detectedDomain);
                }
            }
        } else if (hostHeader) {
            // Host header is not API Gateway domain, try to extract from it
            detectedDomain = extractDomainFromHost(hostHeader);
            domainSource = 'Host';
            console.log('[API] Extracted domain from Host header:', detectedDomain);
        }
        
        // If still no domain, try requestContext as last resort
        if (!detectedDomain) {
            const apiDomain = event.requestContext?.domainName;
            if (apiDomain && !apiDomain.includes('execute-api')) {
                detectedDomain = extractDomainFromHost(apiDomain);
                domainSource = 'requestContext.domainName';
                console.log('[API] Extracted domain from requestContext.domainName:', detectedDomain);
            }
        }
        
        console.log(`[API] Final detected domain: ${detectedDomain} (source: ${domainSource})`);
        
        if (!detectedDomain) {
            console.error('[ERROR] Could not detect domain from request headers');
            console.error('[ERROR] Host header:', hostHeader);
            console.error('[ERROR] Available headers:', Object.keys(event.headers || {}));
            console.error('[ERROR] Header values:', JSON.stringify(event.headers || {}, null, 2));
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ 
                    error: `Could not detect domain from request. Host header was: ${hostHeader}. Please configure CloudFront to forward the original Host header or include domain in request body.`,
                    errorCode: 'ConfigurationError',
                    debug: {
                        hostHeader: hostHeader,
                        availableHeaders: Object.keys(event.headers || {}),
                        headerValues: event.headers
                    }
                })
            };
        }
        
        // Load domain-specific config
        try {
            config = await loadDomainConfig(detectedDomain);
            firebaseConfig = config.firebaseConfig;
        } catch (error) {
            console.error(`[ERROR] Failed to load config for domain ${detectedDomain}:`, error);
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ 
                    error: `Failed to load configuration for domain ${detectedDomain}: ${error.message}`,
                    errorCode: 'ConfigurationError'
                })
            };
        }
        
        // Helper function to get Authorization header (case-insensitive)
        const getAuthToken = () => {
            const authHeader = event.headers?.Authorization || 
                              event.headers?.authorization ||
                              event.headers?.['authorization'] ||
                              event.headers?.['Authorization'];
            return authHeader?.split(' ')[1];
        };

        try {
            console.log('Full event:', JSON.stringify(event, null, 2));
            const path = event.pathParameters?.proxy;
            console.log('Proxy path:', path);
            
            // Health check endpoint - no auth required, helps debug API Gateway -> Lambda connection
            // This endpoint works even if Firebase is not initialized - check it FIRST, before Firebase init
            if (path === 'health' || path === 'test') {
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ 
                        status: 'ok',
                        message: 'API is working',
                        timestamp: new Date().toISOString(),
                        path: path,
                        eventPath: event.path,
                        pathParameters: event.pathParameters,
                        httpMethod: event.httpMethod,
                        requestContext: event.requestContext ? {
                            requestId: event.requestContext.requestId,
                            stage: event.requestContext.stage,
                            apiId: event.requestContext.apiId
                        } : null,
                        detectedDomain: detectedDomain,
                        config: config ? {
                            domain: config.domain,
                            awsRegion: config.awsRegion,
                            s3BucketName: config.s3BucketName
                        } : null
                    })
                };
            }
            
            // Now initialize Firebase for all other endpoints
            if (!firebaseConfig || !firebaseConfig.databaseURL) {
                console.error('[ERROR] Firebase config not available for domain:', detectedDomain);
                return {
                    statusCode: 500,
                    headers,
                    body: JSON.stringify({ 
                        error: `Firebase configuration not found for domain ${detectedDomain}`,
                        errorCode: 'ConfigurationError'
                    })
                };
            }
            
            // Config is already loaded from loadDomainConfig(detectedDomain) above
            // It includes firebaseApp and AWS clients, all cached
            
            // Check if Firebase app is available
            if (!config.firebaseApp) {
                console.error('[ERROR] Firebase app not available for domain:', detectedDomain);
                return {
                    statusCode: 500,
                    headers,
                    body: JSON.stringify({ 
                        error: `Firebase app not initialized for domain ${detectedDomain}`,
                        errorCode: 'ConfigurationError'
                    })
                };
            }
            
            // Use Firebase app from config
            const firebaseApp = config.firebaseApp;
            
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
                    const token = getAuthToken();
                    if (!token) {
                        return {
                            statusCode: 401,
                            headers,
                            body: JSON.stringify({ error: 'Authorization token required' })
                        };
                    }
                    const decodedToken = await firebaseApp.auth().verifyIdToken(token);
                    return await handleUpload(event, decodedToken.uid, headers, config);
                case 'setupEmail':
                    const setupToken = getAuthToken();
                    if (!setupToken) {
                        return {
                            statusCode: 401,
                            headers,
                            body: JSON.stringify({ error: 'Authorization token required' })
                        };
                    }
                    const setupDecodedToken = await firebaseApp.auth().verifyIdToken(setupToken);
                    return await handleSetupEmail(event, setupDecodedToken, headers, config);
                
                case 'getEmails':
                    const emailToken = getAuthToken();
                    if (!emailToken) {
                        return {
                            statusCode: 401,
                            headers,
                            body: JSON.stringify({ error: 'Authorization token required' })
                        };
                    }
                    const emailDecodedToken = await firebaseApp.auth().verifyIdToken(emailToken);
                    return await handleGetEmails(event, emailDecodedToken.uid, headers, config);
                
                case 'getEmailStats':
                    const statsToken = getAuthToken();
                    if (!statsToken) {
                        return {
                            statusCode: 401,
                            headers,
                            body: JSON.stringify({ error: 'Authorization token required' })
                        };
                    }
                    const statsDecodedToken = await firebaseApp.auth().verifyIdToken(statsToken);
                    return await handleGetEmailStats(event, statsDecodedToken.uid, headers, config);
                
                case 'sendEmail':
                    const sendToken = getAuthToken();
                    if (!sendToken) {
                        return {
                            statusCode: 401,
                            headers,
                            body: JSON.stringify({ error: 'Authorization token required' })
                        };
                    }
                    try {
                        // Parse request body to check if domain is provided by frontend
                        let requestBody;
                        try {
                            const decodedBody = event.isBase64Encoded 
                                ? Buffer.from(event.body, 'base64').toString('utf-8')
                                : event.body;
                            requestBody = typeof decodedBody === 'string' ? JSON.parse(decodedBody) : decodedBody;
                        } catch (parseError) {
                            console.error('[SENDEMAIL] Error parsing request body:', parseError);
                        }
                        
                        // If domain is provided in request body, use it (frontend can pass it)
                        let requestDomain = requestBody?.domain || null;
                        let finalDomain = detectedDomain;
                        let finalConfig = config;
                        
                        if (requestDomain) {
                            console.log(`[SENDEMAIL] Domain provided in request body: ${requestDomain}`);
                            // Validate that the domain matches the detected domain or is a valid alternative
                            // For now, we'll use it if header detection failed
                            if (!detectedDomain || detectedDomain.includes('execute-api')) {
                                console.log(`[SENDEMAIL] Using domain from request body: ${requestDomain}`);
                                finalDomain = extractDomainFromHost(requestDomain);
                                // Reload config with the domain from request (includes firebaseApp)
                                try {
                                    finalConfig = await loadDomainConfig(finalDomain);
                                    console.log(`[SENDEMAIL] Reloaded config for domain: ${finalDomain}`);
                                } catch (reloadError) {
                                    console.error(`[SENDEMAIL] Failed to reload config for domain ${finalDomain}:`, reloadError);
                                    return {
                                        statusCode: 500,
                                        headers,
                                        body: JSON.stringify({ 
                                            error: `Invalid domain provided: ${requestDomain}`,
                                            errorCode: 'ConfigurationError'
                                        })
                                    };
                                }
                            }
                        }
                        
                        const sendDecodedToken = await finalConfig.firebaseApp.auth().verifyIdToken(sendToken);
                        
                        // Validate that user has permission for this domain
                        // Check if user's email domain matches the detected domain
                        const userEmail = sendDecodedToken.email || '';
                        const userDomain = userEmail.includes('@') ? userEmail.split('@')[1] : null;
                        
                        console.log(`[SENDEMAIL] User email: ${userEmail}, User domain: ${userDomain}, Detected domain: ${finalDomain}`);
                        
                        // Allow if user's email domain matches, or if user has a profile with this domain
                        // For now, we'll allow it - you can add more sophisticated domain validation here
                        if (userDomain && userDomain !== finalDomain) {
                            console.log(`[SENDEMAIL] User domain (${userDomain}) doesn't match detected domain (${finalDomain}), but allowing (profile check can be added)`);
                        }
                        
                        return await handleSendEmail(event, sendDecodedToken, headers, finalConfig);
                    } catch (tokenError) {
                        console.error('Error verifying token for sendEmail:', tokenError);
                        console.error('Token error details:', {
                            name: tokenError.name,
                            code: tokenError.code,
                            message: tokenError.message,
                            stack: tokenError.stack
                        });
                        return {
                            statusCode: 401,
                            headers,
                            body: JSON.stringify({ error: 'Invalid or expired token', details: tokenError.message })
                        };
                    }
                
                case 'deleteEmail':
                    const deleteToken = getAuthToken();
                    if (!deleteToken) {
                        return {
                            statusCode: 401,
                            headers,
                            body: JSON.stringify({ error: 'Authorization token required' })
                        };
                    }
                    const deleteDecodedToken = await firebaseApp.auth().verifyIdToken(deleteToken);
                    return await handleDeleteEmail(event, deleteDecodedToken.uid, headers, config);
                
                case 'loadEmail':
                    const loadToken = getAuthToken();
                    if (!loadToken) {
                        return {
                            statusCode: 401,
                            headers,
                            body: JSON.stringify({ error: 'Authorization token required' })
                        };
                    }
                    const loadDecodedToken = await firebaseApp.auth().verifyIdToken(loadToken);
                    return await handleLoadEmail(event, loadDecodedToken.uid, headers, config, context);

                case 'inlineImage':
                    // No Bearer required: auth is via signed token in query (for img src cacheable URLs)
                    return await handleInlineImage(event, headers, config);
                
                default:
                    return {
                        statusCode: 404,
                        headers,
                        body: JSON.stringify({ error: 'Not Found' })
                    };
            }
        } catch (error) {
            console.error('Handler error:', error);
            console.error('Error name:', error.name);
            console.error('Error code:', error.code);
            console.error('Error message:', error.message);
            console.error('Error stack:', error.stack);
            console.error('Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            
            return {
                statusCode: 500,
                headers: json500Headers(headers),
                body: buildApiErrorJsonBody(error, context)
            };
        }
        } catch (error) {
            // Outer catch block - catches any unhandled exceptions from the entire handler
            console.error('Unhandled exception in Lambda handler:', error);
            console.error('Error name:', error.name);
            console.error('Error code:', error.code);
            console.error('Error message:', error.message);
            console.error('Error stack:', error.stack);
            console.error('Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            
            return {
                statusCode: 500,
                headers: json500Headers({
                    'Access-Control-Allow-Origin': '*'
                }),
                body: buildApiErrorJsonBody(error, context)
            };
        }
};
async function handleSesEvent(event, domainConfig) {
    // Use the passed-in domain config (no module-level config in Lambda)
    const config = domainConfig;
    if (!config) {
        console.error('[ERROR] handleSesEvent called without domainConfig');
        return { statusCode: 500, body: JSON.stringify({ error: 'Configuration not available' }) };
    }
    
    console.log('=== SES EVENT RECEIVED ===');
    console.log('Full SES event:', JSON.stringify(event, null, 2));
    console.log('Number of records:', event.Records ? event.Records.length : 0);
    console.log(`[CONFIG] Using domain: ${config.domain}`);
    
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
                console.log('[OK] Found messageId:', ses.mail.messageId);
                
                const s3Key = ses.mail.messageId;
                const bucketName = config.s3BucketName || process.env.S3_BUCKET_NAME || 'vcmail-mail-inbox';
                
                console.log(`[S3] Reading email from S3: s3://${bucketName}/${s3Key}`);
                
                try {
                    // Read email content from S3
                    const s3Params = {
                        Bucket: bucketName,
                        Key: s3Key
                    };
                    
                    // Use cached S3 client from config
                    const s3Client = config.s3Client || s3;
                    const s3Result = await s3Client.send(new GetObjectCommand(s3Params));
                    console.log('[OK] Successfully read email from S3');
                    
                    // Parse the email content from S3
                    const emailContent = await s3BodyToUtf8(s3Result.Body);
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
                        if (transferEncoding) {
                            console.log(`Decoding simple email with encoding: ${transferEncoding}`);
                            emailData.body = decodePartContent(emailData.body, transferEncoding);
                        }
                        emailData.headers.content_type = contentType;
                    }
                    
                    console.log('Parsed email data:', JSON.stringify(emailData, null, 2));
                    
                    // Process each recipient
                    const emailDomain = config.domain || 'example.com';
                    console.log(`[INFO] Lambda configured for domain: ${emailDomain}`);
                    console.log('Processing recipients:', ses.mail.destination);
                    
                    let hasMatchingRecipient = false;
                    for (const recipient of ses.mail.destination) {
                        console.log('Checking recipient:', recipient);
                        if (recipient.endsWith(`@${emailDomain}`)) {
                            const username = recipient.split('@')[0];
                            console.log(`[OK] Found @${emailDomain} recipient:`, username);
                            await storeEmailForUser(username, ses.mail.messageId, emailData, config);
                            processedCount++;
                            hasMatchingRecipient = true;
                        } else {
                            const recipientDomain = recipient.split('@')[1];
                            console.log(`[INFO] Recipient ${recipient} is for domain ${recipientDomain}, not ${emailDomain}`);
                            console.log(`[INFO] This Lambda handles ${emailDomain} only. Email will be processed by the Lambda for ${recipientDomain}`);
                        }
                    }
                    
                    if (!hasMatchingRecipient) {
                        console.log(`[INFO] No recipients matched this Lambda's domain (${emailDomain}). This is expected if SES routed the email incorrectly or if multiple Lambdas share the same rule set.`);
                        console.log(`[INFO] Returning success - the correct Lambda for this domain should process it.`);
                    }
                } catch (s3Error) {
                    console.error('[ERROR] Error reading email from S3:', s3Error);
                    errorCount++;
                }
            } else {
                console.log('[ERROR] No messageId found in SES mail data');
            }
            
            // Process receipt action if available
            if (ses.receipt) {
                console.log('[INFO] Receipt action:', {
                    action: ses.receipt.action,
                    recipient: ses.receipt.recipients,
                    timestamp: ses.receipt.timestamp,
                    processingTimeMillis: ses.receipt.processingTimeMillis
                });
            } else {
                console.log('[ERROR] No receipt action found');
            }
        } catch (error) {
            console.error('[ERROR] Error processing SES record:', error);
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

// Helper: save email content to S3
async function saveEmailContentToS3(uid, emailId, content, folder = 'emails', configParam = null) {
    try {
        // Use provided config or fallback to environment variable
        const bucketName = (configParam && configParam.s3BucketName) || process.env.S3_BUCKET_NAME || 'vcmail-mail-inbox';
        const s3Key = `${folder}/${uid}/${emailId}/body`;
        console.log(`[PACKAGE] Saving email content to S3: s3://${bucketName}/${s3Key}`);
        
        // Use cached S3 client from config if available, otherwise use global fallback
        const s3Client = (configParam && configParam.s3Client) || s3;
        
        // Ensure content is a Buffer with proper UTF-8 encoding
        const contentBuffer = Buffer.from(content, 'utf-8');
        
        const s3Params = {
            Bucket: bucketName,
            Key: s3Key,
            Body: contentBuffer,
            ContentType: 'text/plain; charset=utf-8',
            ContentEncoding: 'utf-8',
            ServerSideEncryption: 'AES256'
        };
        
        await s3Client.send(new PutObjectCommand(s3Params));
        console.log(`[OK] Email content saved to S3 (${contentBuffer.length} bytes)`);
        
        return s3Key;
    } catch (error) {
        console.error('[ERROR] Error saving email content to S3:', error);
        throw error;
    }
}

// Helper: save attachment to S3
async function saveAttachmentToS3(uid, emailId, attachmentIndex, attachmentData, folder = 'emails', configParam = null) {
    try {
        // Use provided config or fallback to environment variable
        const bucketName = (configParam && configParam.s3BucketName) || process.env.S3_BUCKET_NAME || 'vcmail-mail-inbox';
        const filename = attachmentData.filename || `attachment-${attachmentIndex}`;
        const s3Key = `${folder}/${uid}/${emailId}/attachments/${attachmentIndex}-${filename}`;
        console.log(`[PACKAGE] Saving attachment to S3: s3://${bucketName}/${s3Key}`);
        
        // Use cached S3 client from config if available, otherwise use global fallback
        const s3Client = (configParam && configParam.s3Client) || s3;
        
        // Determine if content is base64 or raw
        let bodyContent;
        if (attachmentData.encoding === 'base64' && attachmentData.content) {
            // Content is base64, decode it for S3 storage
            bodyContent = Buffer.from(attachmentData.content, 'base64');
        } else if (attachmentData.content) {
            // Content is text/raw, convert to buffer
            bodyContent = Buffer.from(attachmentData.content, 'utf-8');
        } else {
            console.warn(`[WARN] Attachment has no content, skipping S3 save`);
            return null;
        }
        
        const s3Params = {
            Bucket: bucketName,
            Key: s3Key,
            Body: bodyContent,
            ContentType: attachmentData.contentType || 'application/octet-stream',
            ContentDisposition: `attachment; filename="${filename}"`,
            ServerSideEncryption: 'AES256'
        };
        
        await s3Client.send(new PutObjectCommand(s3Params));
        console.log(`[OK] Attachment saved to S3`);
        
        return {
            s3Key: s3Key,
            filename: filename,
            contentType: attachmentData.contentType || 'application/octet-stream',
            size: bodyContent.length,
            partKey: attachmentData.partKey || `part_${attachmentIndex}`
        };
    } catch (error) {
        console.error('[ERROR] Error saving attachment to S3:', error);
        throw error;
    }
}

async function storeEmailForUser(username, messageId, emailData, configParam = null) {
    console.log(`[INFO] Storing email for user: ${username}`);
    console.log(`Message ID: ${messageId}`);
    
    if (!configParam || !configParam.firebaseApp) {
        console.error('[ERROR] firebaseApp is not available in storeEmailForUser');
        return;
    }
    
    const firebaseApp = configParam.firebaseApp;
    
    try {
        // First, look up the UID for this username using the new usernames structure
        console.log(`Looking up UID for username: ${username}`);
        const usernameRef = firebaseApp.database().ref(`usernames/${username}`);
        const usernameSnapshot = await usernameRef.once('value');
        
        if (!usernameSnapshot.exists()) {
            console.error(`[ERROR] No user found for username: ${username}`);
            const domain = (configParam && configParam.domain) ? configParam.domain : (config && config.domain) ? config.domain : 'example.com';
            console.error(`[ERROR] Email will not be stored. User must set up email address at ${domain}`);
            console.error(`[ERROR] Email details: from=${emailData.from}, to=${emailData.to}, subject=${emailData.subject}`);
            // Don't throw - just log and return. The email was already accepted by SES.
            return;
        }
        
        const uid = usernameSnapshot.val();
        console.log(`[OK] Found UID for ${username}: ${uid}`);
        
        if (!uid) {
            console.log(`[ERROR] No UID found for username: ${username}`);
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
        
        // Store email in Firebase using timestamp as key
        const emailKey = `email_${Date.now()}`;
        
        // Save email content to S3
        const emailContent = preferredContent || emailData.body;
        const contentS3Key = await saveEmailContentToS3(uid, emailKey, emailContent, 'emails', configParam || config);
        console.log(`[OK] Email content saved to S3: ${contentS3Key}`);
        
        // Save attachments to S3 if any
        const attachmentS3Keys = [];
        if (emailStructure && emailStructure.attachments && emailStructure.attachments.length > 0) {
            for (let i = 0; i < emailStructure.attachments.length; i++) {
                const attachment = emailStructure.attachments[i];
                try {
                    const s3Info = await saveAttachmentToS3(uid, emailKey, i, attachment, 'emails', configParam || config);
                    if (s3Info) {
                        attachmentS3Keys.push({
                            ...s3Info,
                            isInline: attachment.isInline !== undefined ? attachment.isInline : false
                        });
                    }
                } catch (attError) {
                    console.error(`[ERROR] Error saving attachment ${i} to S3:`, attError);
                    // Continue with other attachments
                }
            }
        }
        
        // Create lightweight email record for Firebase (metadata only, no content/attachments)
        const normalizedEmailData = normalizeEmailAddressHeaders({
            from: emailData.from,
            to: emailData.to
        });
        const firebaseRecord = {
            messageId: messageId,
            from: normalizedEmailData.from,
            to: normalizedEmailData.to,
            subject: emailData.subject,
            timestamp: Date.now(),
            contentType: contentType,
            headers: {
                'content_type': emailData.headers.content_type || emailData.headers['content-type'] || '',
                'mime_version': emailData.headers['mime-version'] || '',
                'date': emailData.headers['date'] || '',
                'message_id': emailData.headers['message-id'] || ''
            },
            username: username,
            hasAttachments: emailStructure ? emailStructure.attachments.length > 0 : false,
            attachmentCount: emailStructure ? emailStructure.attachments.length : 0,
            contentS3Key: contentS3Key // Reference to S3 content
        };
        
        // Only add attachmentsS3 if there are attachments (Firebase doesn't allow undefined)
        if (attachmentS3Keys.length > 0) {
            firebaseRecord.attachmentsS3 = attachmentS3Keys;
        }
        
        // Store structure metadata (without attachment content)
        if (emailStructure) {
            const structureMetadata = {
                type: emailStructure.type
            };
            
            // Only add boundary if it exists
            if (emailStructure.boundary) {
                structureMetadata.boundary = emailStructure.boundary;
            }
            
            // Only add preferredContent if it exists (Firebase doesn't allow undefined)
            if (emailStructure.preferredContent) {
                structureMetadata.preferredContent = {
                    type: emailStructure.preferredContent.type,
                    partKey: emailStructure.preferredContent.partKey
                };
            }
            
            // Add attachments metadata if any
            if (emailStructure.attachments && emailStructure.attachments.length > 0) {
                structureMetadata.attachments = emailStructure.attachments.map((att, idx) => {
                    const attMetadata = {
                        partKey: att.partKey || `part_${idx}`,
                        filename: att.filename || `attachment-${idx}`,
                        contentType: att.contentType || 'application/octet-stream',
                        size: att.size || 0
                    };
                    
                    // Only add isInline if defined
                    if (att.isInline !== undefined) {
                        attMetadata.isInline = att.isInline;
                    }
                    
                    // contentId is needed for resolving cid: references in HTML (inline images)
                    if (att.contentId) {
                        attMetadata.contentId = att.contentId;
                    }
                    
                    // Only add s3Key if it exists
                    if (attachmentS3Keys[idx]?.s3Key) {
                        attMetadata.s3Key = attachmentS3Keys[idx].s3Key;
                    }
                    
                    return attMetadata;
                });
            }
            
            firebaseRecord.structure = structureMetadata;
        }
        
        const firebasePath = `emails/${uid}/${emailKey}`;
        console.log(`[INFO] Storing email metadata in Firebase at path: ${firebasePath}`);
        console.log(`[INFO] Email record preview:`, {
            messageId: firebaseRecord.messageId,
            subject: firebaseRecord.subject,
            contentType: firebaseRecord.contentType,
            hasAttachments: firebaseRecord.hasAttachments,
            attachmentCount: firebaseRecord.attachmentCount,
            contentS3Key: firebaseRecord.contentS3Key
        });
        
        const emailRef = firebaseApp.database().ref(firebasePath);
        await emailRef.set(firebaseRecord);
        console.log(`[OK] Email metadata stored in Firebase successfully`);
        
        // Update email count for inbox
        const emailCountsRef = firebaseApp.database().ref(`users/${uid}/emailCounts/inbox`);
        await emailCountsRef.transaction((currentCount) => {
            return (currentCount || 0) + 1;
        });
        console.log(`[OK] Inbox email count updated`);
        
        // Log attachment details if any
        if (attachmentS3Keys.length > 0) {
            console.log(`[ATTACH] Attachments saved to S3:`, attachmentS3Keys.map(att => ({
                filename: att.filename,
                contentType: att.contentType,
                size: att.size,
                s3Key: att.s3Key
            })));
        }
        
        console.log(`[INFO] Updating user email statistics...`);
        // Update user's email statistics
        const userStatsRef = firebaseApp.database().ref(`users/${uid}/emailStats`);
        await userStatsRef.transaction((currentStats) => {
            if (currentStats === null) {
                return { totalEmails: 1, lastEmailTimestamp: firebaseRecord.timestamp };
            }
            return {
                totalEmails: (currentStats.totalEmails || 0) + 1,
                lastEmailTimestamp: firebaseRecord.timestamp
            };
        });
        console.log(`[OK] Email statistics updated`);
        
        console.log(`[SUCCESS] Email stored successfully for user ${username} (UID: ${uid}) - content in S3, metadata in Firebase`);
        
    } catch (error) {
        console.error(`Error storing email for user ${username}:`, error);
    }
}



// Use the improved decodeQuotedPrintable function with proper UTF-8 support
function decodeQuotedPrintable(str) {
    if (!str) return str;
    
    safeLog('Decoding quoted-printable string:', { length: str.length });
    const decoded = decodeQuotedPrintableNew(str);
    const safePreview = decoded.substring(0, 200).replace(/[^\x00-\x7F]/g, '?') + '...';
    safeLog('Decoded string preview:', safePreview);
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

function decodeWindows1252(buffer) {
    const replacements = {
        0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E,
        0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6,
        0x89: 0x2030, 0x8A: 0x0160, 0x8B: 0x2039, 0x8C: 0x0152,
        0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C,
        0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
        0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A,
        0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178
    };

    let decoded = '';
    for (const byte of buffer) {
        decoded += String.fromCodePoint(replacements[byte] || byte);
    }
    return decoded;
}

function decodeMimeHeaderBuffer(buffer, charset) {
    const charsetLower = (charset || 'utf-8').toLowerCase().replace(/_/g, '-');

    if (charsetLower === 'utf-8' || charsetLower === 'utf8' || charsetLower === 'us-ascii' || charsetLower === 'ascii') {
        return buffer.toString('utf8');
    }
    if (charsetLower === 'iso-8859-1' || charsetLower === 'iso8859-1' || charsetLower === 'latin1' || charsetLower === 'latin-1') {
        return buffer.toString('latin1');
    }
    if (charsetLower === 'windows-1252' || charsetLower === 'win-1252' || charsetLower === 'cp1252') {
        return decodeWindows1252(buffer);
    }

    try {
        return buffer.toString(charsetLower);
    } catch (bufferError) {
        try {
            return new TextDecoder(charsetLower).decode(buffer);
        } catch (decoderError) {
            console.warn('Failed to convert MIME header charset:', charset, decoderError);
            return buffer.toString('utf8');
        }
    }
}

function decodeRfc2047EncodedWord(match, charset, encoding, encodedText) {
    try {
        let buffer;

        if (encoding.toUpperCase() === 'B') {
            buffer = Buffer.from(encodedText.replace(/\s/g, ''), 'base64');
        } else if (encoding.toUpperCase() === 'Q') {
            const cleanedText = encodedText.replace(/=\r?\n/g, '').replace(/_/g, ' ');
            const bytes = [];
            let i = 0;

            while (i < cleanedText.length) {
                if (cleanedText[i] === '=' && i + 2 < cleanedText.length) {
                    const hex = cleanedText.substring(i + 1, i + 3);
                    if (/^[A-Fa-f0-9]{2}$/.test(hex)) {
                        bytes.push(parseInt(hex, 16));
                        i += 3;
                        continue;
                    }
                }

                bytes.push(cleanedText.charCodeAt(i) & 0xFF);
                i++;
            }

            buffer = Buffer.from(bytes);
        } else {
            return match;
        }

        return decodeMimeHeaderBuffer(buffer, charset);
    } catch (e) {
        console.warn('Failed to decode RFC 2047:', match, e);
        return match;
    }
}

// Decode RFC 2047 encoded headers (e.g., =?UTF-8?Q?Subject?=)
function decodeRfc2047(str) {
    if (!str) return str;

    const decodeStandardWord = (match, charset, encoding, encodedText) => {
        return decodeRfc2047EncodedWord(match, charset, encoding, encodedText);
    };
    const decodeMissingEqualsWord = (match, prefix, charset, encoding, encodedText) => {
        return prefix + decodeRfc2047EncodedWord(match.substring(prefix.length), charset, encoding, encodedText);
    };

    return str
        .replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, decodeStandardWord)
        .replace(/(^|[\s(<,;])\?([^?\s]+)\?([BQ])\?([^?]*)\?=/gi, decodeMissingEqualsWord);
}

function decodeAddressHeaderValue(value) {
    return typeof value === 'string' ? decodeRfc2047(value) : value;
}

function normalizeEmailAddressHeaders(email) {
    if (!email) return email;

    if (typeof email.from === 'string') {
        email.from = decodeAddressHeaderValue(email.from);
    }
    if (typeof email.to === 'string') {
        email.to = decodeAddressHeaderValue(email.to);
    }

    return email;
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
        
        const partPreview = trimmed.substring(0, 100).replace(/[^\x00-\x7F]/g, '?') + '...';
        safeLog(`Processing part ${i}:`, partPreview);
        
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
        
        // Decode content-transfer-encoding (base64 or quoted-printable)
        body = decodePartContent(body, htmlPart.encoding);
        
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
        
        // Decode content-transfer-encoding (base64 or quoted-printable)
        body = decodePartContent(body, textPart.encoding);
        
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
        
        // Decode RFC 2047 encoded from and to fields
        const from = decodeRfc2047(headers['from'] || '');
        const to = decodeRfc2047(headers['to'] || '');

        return {
            from: from,
            to: to,
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
async function handleUpload(event, userId, headers, config) {
    if (!config || !config.firebaseApp) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'firebaseApp is not defined' })
        };
    }
    
    const firebaseApp = config.firebaseApp;
    
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
    const userRef = firebaseApp.database().ref(`users/${userId}/currentChallenge`);
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
    
    const webmailBucket = config.s3WebmailBucket || config.webmailDomain || config.mailDomain || 'mail.example.com';

    console.log('Generating presigned URL with params:', {
        Bucket: webmailBucket,
        Key: filename,
        ContentType: contentType,
        Expires: 300
    });

    // Use cached S3 client from config if available
    const s3Client = (config && config.s3Client) || s3;
    
    // Generate presigned URL for upload
    const presignedUrl = await presignPutObject(s3Client, {
        bucket: webmailBucket,
        key: filename,
        contentType: contentType,
        expiresIn: 300
    });

    console.log('Generated presigned URL:', presignedUrl);

    // Return the upload URL and the final file URL
    const fileUrl = config.apiEndpoint 
        ? `${config.apiEndpoint}/${filename}`
        : `https://${webmailBucket}/${filename}`;
    
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            uploadUrl: presignedUrl,
            fileUrl: fileUrl
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

// Helper functions to encode/decode email addresses for Firebase paths
// Firebase Realtime Database doesn't allow '.', '#', '$', '[', ']' in path segments
function encodeEmailForFirebase(email) {
    if (!email) return email;
    return email
        .replace(/\./g, '_dot_')
        .replace(/#/g, '_hash_')
        .replace(/\$/g, '_dollar_')
        .replace(/\[/g, '_lbracket_')
        .replace(/\]/g, '_rbracket_')
        .replace(/@/g, '_at_');
}

function decodeEmailFromFirebase(encodedEmail) {
    if (!encodedEmail) return encodedEmail;
    return encodedEmail
        .replace(/_at_/g, '@')
        .replace(/_rbracket_/g, ']')
        .replace(/_lbracket_/g, '[')
        .replace(/_dollar_/g, '$')
        .replace(/_hash_/g, '#')
        .replace(/_dot_/g, '.');
}

async function handleSetupEmail(event, decodedToken, headers, config) {
    if (!config || !config.firebaseApp) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'firebaseApp is not defined' })
        };
    }
    
    const firebaseApp = config.firebaseApp;
    
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

        let { username } = body;
        if (typeof username !== 'string') {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Username is required' })
            };
        }

        username = username.trim().toLowerCase();
        if (!username.match(/^[a-zA-Z0-9._-]{3,32}$/)) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Username must be 3-32 characters and can only contain letters, numbers, dots, underscores, or hyphens.' })
            };
        }

        const uid = decodedToken.uid;
        const emailDomain = config.domain || 'example.com';
        const email = `${username}@${emailDomain}`;
        const db = firebaseApp.database();
        
        // Encode email for use in Firebase path (replaces invalid characters)
        const encodedEmail = encodeEmailForFirebase(email);

        const [usernameSnapshot, profileSnapshot, emailSnapshot] = await Promise.all([
            db.ref(`usernames/${username}`).once('value'),
            db.ref(`users/${uid}/profile`).once('value'),
            db.ref(`userEmails/${encodedEmail}`).once('value')
        ]);

        if (usernameSnapshot.exists() && usernameSnapshot.val() !== uid) {
            return {
                statusCode: 409,
                headers,
                body: JSON.stringify({ error: 'Username already taken. Please choose another.' })
            };
        }

        if (emailSnapshot.exists() && emailSnapshot.val().uid !== uid) {
            return {
                statusCode: 409,
                headers,
                body: JSON.stringify({ error: 'Email already mapped to another user' })
            };
        }

        const existingProfile = profileSnapshot.exists() ? profileSnapshot.val() : null;
        const updates = {};

        if (existingProfile?.username && existingProfile.username !== username) {
            updates[`usernames/${existingProfile.username}`] = null;
            if (existingProfile.email) {
                // Encode the existing email for Firebase path
                const encodedExistingEmail = encodeEmailForFirebase(existingProfile.email);
                updates[`userEmails/${encodedExistingEmail}`] = null;
            }
        }

        updates[`usernames/${username}`] = uid;
        updates[`users/${uid}/profile`] = { username, email };
        updates[`userEmails/${encodedEmail}`] = { uid };

        await db.ref().update(updates);

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

async function handleGetEmails(event, uid, headers, config) {
    if (!config || !config.firebaseApp) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'firebaseApp is not defined' })
        };
    }
    
    const firebaseApp = config.firebaseApp;
    
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
            const email = normalizeEmailAddressHeaders({
                id: childSnapshot.key,
                ...childSnapshot.val()
            });
            
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

async function handleGetEmailStats(event, uid, headers, config) {
    if (!config || !config.firebaseApp) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'firebaseApp is not defined' })
        };
    }
    
    const firebaseApp = config.firebaseApp;
    
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

// Normalize an email address by converting Unicode variants (bold, full-width, accented, etc.)
// into plain ASCII characters and stripping any remaining non-ASCII symbols.
function normalizeEmailAddress(input) {
    if (!input || typeof input !== 'string') return input;

    let value = input;

    // Use Unicode normalization (NFKD) when available to fold compatibility characters
    // like full-width or mathematical bold letters back to their ASCII equivalents.
    try {
        if (typeof value.normalize === 'function') {
            value = value.normalize('NFKD');
        }
    } catch (e) {
        // If normalization is not supported, continue with the original string.
    }

    // Strip combining diacritical marks (accents, etc.)
    value = value.replace(/[\u0300-\u036f]/g, '');

    // Map a few common Unicode punctuation variants to ASCII.
    value = value
        .replace(/[\uFF20]/g, '@') // full-width @
        .replace(/[\uFF0E\u2024\uFE52\uFF61]/g, '.') // full-width / dotted variants
        .replace(/[\u2018\u2019\u201B\u2032]/g, "'") // curly/single quotes
        .replace(/[\u201C\u201D\u201F\u2033]/g, '"'); // curly/double quotes

    // Finally, drop any remaining non-ASCII characters.
    value = value.replace(/[^\x00-\x7F]/g, '');

    return value.trim();
}

async function handleSendEmail(event, decodedToken, headers, config = null) {
    try {
        if (!config || !config.firebaseApp) {
            console.error('[SENDEMAIL] Config or firebaseApp not available in handleSendEmail');
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: 'Configuration or Firebase not available' })
            };
        }
        
        const firebaseApp = config.firebaseApp;
        
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

        // Normalize recipient address to plain ASCII to avoid Unicode variants
        const normalizedTo = normalizeEmailAddress(to);

        // Basic email validation
        if (!normalizedTo.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
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
        const emailDomain = (config && config.domain) ? config.domain : 'example.com';
        console.log(`[SENDEMAIL] Using domain: ${emailDomain} for sender email`);
        const senderEmail = `${senderUsername}@${emailDomain}`;

        // Check if sending to same domain - handle directly without SES
        if (normalizedTo.endsWith(`@${emailDomain}`)) {
            const recipientUsername = normalizedTo.split('@')[0];
            console.log(`[INFO] Same-domain email detected. Recipient: ${recipientUsername}`);
            
            // Check if recipient exists
            const recipientUsernameRef = firebaseApp.database().ref(`usernames/${recipientUsername}`);
            const recipientUsernameSnapshot = await recipientUsernameRef.once('value');
            
            if (!recipientUsernameSnapshot.exists()) {
                return {
                    statusCode: 404,
                    headers,
                    body: JSON.stringify({ 
                        error: `Recipient ${to} does not exist. The user must set up their email address first.`,
                        errorCode: 'RecipientNotFound'
                    })
                };
            }
            
            // Generate a message ID (similar to SES format)
            const messageId = `vcmail-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
            
            // Create email content in raw format (similar to what SES stores)
            const dateHeader = new Date().toUTCString();
            const rawEmail = `From: ${senderEmail}\r\nTo: ${normalizedTo}\r\nSubject: ${subject}\r\nDate: ${dateHeader}\r\nMessage-ID: <${messageId}@${emailDomain}>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${emailBody}`;
            
            // Save to S3 (same bucket as SES uses)
            const bucketName = config.s3BucketName || process.env.S3_BUCKET_NAME || 'vcmail-mail-inbox';
            const s3Client = config.s3Client || s3;
            const s3Params = {
                Bucket: bucketName,
                Key: messageId,
                Body: rawEmail,
                ContentType: 'message/rfc822'
            };
            
            await s3Client.send(new PutObjectCommand(s3Params));
            console.log(`[OK] Email saved to S3: s3://${bucketName}/${messageId}`);
            
            // Create emailData structure similar to what parseEmailContent creates
            const emailData = {
                from: senderEmail,
                to: normalizedTo,
                subject: subject,
                body: emailBody,
                headers: {
                    'content-type': 'text/plain; charset=UTF-8',
                    'mime-version': '1.0',
                    'date': dateHeader,
                    'message-id': `<${messageId}@${emailDomain}>`
                }
            };
            
            // Store in Firebase using existing function (for recipient's inbox)
            await storeEmailForUser(recipientUsername, messageId, emailData, config);
            
            // Also store in sender's sent folder (save to S3)
            const sentEmailKey = `email_${Date.now()}`;
            const sentContentS3Key = await saveEmailContentToS3(uid, sentEmailKey, emailBody, 'sent', config);
            console.log(`[OK] Sent email content saved to S3: ${sentContentS3Key}`);
            
            const sentEmailRecord = {
                messageId: messageId,
                from: senderEmail,
                to: to,
                subject: subject,
                contentType: 'text/plain',
                timestamp: Date.now(),
                headers: {
                    'content_type': 'text/plain; charset=UTF-8',
                    'mime_version': '1.0',
                    'date': dateHeader,
                    'message_id': `<${messageId}@${emailDomain}>`
                },
                contentS3Key: sentContentS3Key
            };
            
            const sentEmailRef = firebaseApp.database().ref(`sent/${uid}/${sentEmailKey}`);
            await sentEmailRef.set(sentEmailRecord);
            console.log(`[OK] Email saved to sender's sent folder: sent/${uid}/${sentEmailKey}`);
            
            // Update sent email count
            const sentCountsRef = firebaseApp.database().ref(`users/${uid}/emailCounts/sent`);
            await sentCountsRef.transaction((currentCount) => {
                return (currentCount || 0) + 1;
            });
            console.log(`[OK] Sent email count updated`);
            
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ 
                    message: 'Email sent successfully (same-domain delivery)',
                    messageId: messageId
                })
            };
        }

        // External domain - use SES (use cached client from config)
        const sesClient = config.sesClient || new SESClient({ 
            region: config.awsRegion || process.env.AWS_REGION || 'us-east-1' 
        });
        
        const emailParams = {
            Source: senderEmail,
            Destination: {
                ToAddresses: [normalizedTo]
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
            },
            // Use Configuration Set for better deliverability tracking
            // This helps with reputation monitoring and deliverability
            ConfigurationSetName: config.configurationSetName || `${config.domain?.split('.')[0] || 'vcmail'}-email-config`
        };

        console.log('Attempting to send email via SES with params:', JSON.stringify(emailParams, null, 2));
        
        const sesResult = await sesClient.send(new SendEmailCommand(emailParams));
        console.log('Email sent via SES successfully:', sesResult);
        console.log('Email will be processed by SES receipt rule and stored in Firebase automatically');
        
        // Store in sender's sent folder (for external emails, save to S3)
        const sentEmailKey = `email_${Date.now()}`;
        const sentContentS3Key = await saveEmailContentToS3(uid, sentEmailKey, emailBody, 'sent', config);
        console.log(`[OK] Sent email content saved to S3: ${sentContentS3Key}`);
        
        const sentEmailRecord = {
            messageId: sesResult.MessageId,
            from: senderEmail,
            to: normalizedTo,
            subject: subject,
            contentType: 'text/plain',
            timestamp: Date.now(),
            headers: {
                'content_type': 'text/plain; charset=UTF-8',
                'mime_version': '1.0',
                'date': new Date().toUTCString(),
                'message_id': sesResult.MessageId
            },
            contentS3Key: sentContentS3Key
        };
        
        const sentEmailRef = firebaseApp.database().ref(`sent/${uid}/${sentEmailKey}`);
        await sentEmailRef.set(sentEmailRecord);
        console.log(`[OK] Email saved to sender's sent folder: sent/${uid}/${sentEmailKey}`);
        
        // Update sent email count
        const sentCountsRef = firebaseApp.database().ref(`users/${uid}/emailCounts/sent`);
        await sentCountsRef.transaction((currentCount) => {
            return (currentCount || 0) + 1;
        });
        console.log(`[OK] Sent email count updated`);

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
        console.error('Error name:', error.name);
        console.error('Error code:', error.code);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        console.error('Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
        
        // Handle SES-specific errors
        if (error.code === 'MessageRejected' || error.name === 'MessageRejected') {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ 
                    error: 'Email rejected by SES. The domain may not be verified or SES may be in sandbox mode.',
                    details: error.message 
                })
            };
        } else if (error.code === 'ConfigurationSetDoesNotExist' || error.name === 'ConfigurationSetDoesNotExist') {
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
                message: error.message || 'An unexpected error occurred',
                errorCode: error.code || error.name,
                details: process.env.NODE_ENV === 'development' ? error.stack : undefined
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
        
        // Sanitize part preview for logging
        const partPreview = trimmed.substring(0, 100).replace(/[^\x00-\x7F]/g, '?') + '...';
        safeLog(`Processing part ${partIndex}:`, partPreview);
        
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
        
        // Parse headers (handle continuation lines properly)
        const headerLines = headerSection.split(/\r?\n/);
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
        
        // Log headers for debugging attachments
        if (headers['content-disposition']) {
            console.log(`[ATTACH] Part ${partIndex} Content-Disposition: ${headers['content-disposition']}`);
            const extractedFilename = extractFilename(headers['content-disposition']);
            if (extractedFilename) {
                console.log(`[ATTACH] Part ${partIndex} extracted filename: ${extractedFilename}`);
            }
        }
        
        const body = bodyMatch[1].trim();
        const contentType = headers['content-type'] || '';
        const contentDisposition = headers['content-disposition'] || '';
        const contentIdRaw = headers['content-id'] || headers['content-id'] || '';
        // Normalize Content-ID: strip angle brackets (e.g. <image002.png@01DCA19A.EC89C680> -> image002.png@01DCA19A.EC89C680)
        const contentId = contentIdRaw ? contentIdRaw.replace(/^<|>$/g, '').trim() : '';
        const filename = extractFilename(contentDisposition);
        
        // Check if this is inline (has Content-ID or content-disposition: inline)
        const isInline = contentDisposition.includes('inline') || !!contentId;
        
        // Create part object
        const partKey = `part_${partIndex}`;
        const partObj = {
            headers: headers,
            body: body,
            contentType: contentType,
            contentDisposition: contentDisposition,
            filename: filename,
            encoding: headers['content-transfer-encoding'] || '',
            size: body.length,
            isInline: isInline,
            contentId: contentId || undefined
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
        
        // Check if this is an attachment (including inline CID images for HTML body)
        // An attachment is:
        // 1. Has Content-Disposition: attachment
        // 2. OR has a filename but is NOT inline AND is not text/html or text/plain
        // 3. OR has a filename and Content-Disposition doesn't explicitly say "inline"
        // 4. OR is inline with Content-ID (CID) and not text/html or text/plain — these are inline images
        //    referenced in HTML as src="cid:..."; we must expose them as attachments so the client can resolve cid: URLs
        const hasFilename = !!filename;
        const hasAttachmentDisposition = contentDisposition.toLowerCase().includes('attachment');
        const hasInlineDisposition = contentDisposition.toLowerCase().includes('inline');
        
        const isInlineCidPart = isInline && !!contentId && contentType &&
            !contentType.includes('text/html') && !contentType.includes('text/plain') &&
            !contentType.includes('multipart/');
        
        const isAttachment = hasAttachmentDisposition ||
            (hasFilename && !hasInlineDisposition && !isInline && contentType &&
             !contentType.includes('text/html') && !contentType.includes('text/plain') &&
             !contentType.includes('multipart/')) ||
            isInlineCidPart;
        
        // Log attachment check (sanitize all strings to avoid Unicode issues)
        try {
            const safeFilename = filename ? filename.replace(/[^\x00-\x7F]/g, '?') : null;
            const safeContentDisposition = contentDisposition ? contentDisposition.substring(0, 200).replace(/[^\x00-\x7F]/g, '?') : '';
            const safeContentType = contentType ? contentType.replace(/[^\x00-\x7F]/g, '?') : '';
            const logData = {
                isAttachment: isAttachment,
                contentDisposition: safeContentDisposition,
                hasAttachmentKeyword: contentDisposition.toLowerCase().includes('attachment'),
                hasInlineKeyword: contentDisposition.toLowerCase().includes('inline'),
                hasFilename: !!filename,
                filename: safeFilename,
                isInline: isInline,
                contentType: safeContentType,
                bodyLength: body.length,
                hasContentId: !!contentId
            };
            safeLog(`[ATTACH] Part ${partIndex} attachment check:`, logData);
        } catch (logError) {
            safeLog(`[ATTACH] Part ${partIndex} attachment check failed to log:`, logError.message);
        }
        
        if (isAttachment) {
            const safeFilenameForLog = filename ? filename.replace(/[^\x00-\x7F]/g, '?') : 'unnamed';
            const safeEncoding = (headers['content-transfer-encoding'] || 'none').replace(/[^\x00-\x7F]/g, '?');
            safeLog(`[OK] Part ${partIndex} identified as attachment:`, {
                filename: safeFilenameForLog,
                rawBodyLength: body.length,
                encoding: safeEncoding
            });
            
            // Decode the attachment content based on Content-Transfer-Encoding
            const transferEncoding = headers['content-transfer-encoding'] || '';
            let decodedAttachmentContent = null;
            let attachmentEncoding = 'raw';
            
            const safeTransferEncoding = (transferEncoding || 'none').replace(/[^\x00-\x7F]/g, '?');
            safeLog(`[ATTACH] Part ${partIndex} attachment encoding:`, {
                encoding: safeTransferEncoding,
                rawBodyLength: body.length
            });
            
            if (transferEncoding.toLowerCase() === 'base64') {
                // Decode base64 to get actual binary content
                // For binary attachments, keep as Buffer (don't convert to UTF-8 string)
                try {
                    decodedAttachmentContent = Buffer.from(body, 'base64');
                    attachmentEncoding = 'base64';
                    safeLog(`[ATTACH] Part ${partIndex} attachment decoded from base64:`, {
                        decodedLength: decodedAttachmentContent.length,
                        originalLength: body.length
                    });
                } catch (base64Error) {
                    safeLog(`[ERROR] Error decoding base64 attachment ${partIndex}:`, base64Error.message);
                    // Fallback: keep as base64 string
                    decodedAttachmentContent = body;
                    attachmentEncoding = 'base64-string';
                }
            } else if (transferEncoding.toLowerCase() === 'quoted-printable') {
                // Decode quoted-printable (usually text)
                decodedAttachmentContent = decodeQuotedPrintable(body);
                attachmentEncoding = 'quoted-printable';
                safeLog(`[ATTACH] Part ${partIndex} attachment decoded from quoted-printable`);
            } else {
                // No encoding or 7bit/8bit - use as-is
                decodedAttachmentContent = body;
                attachmentEncoding = 'raw';
                safeLog(`[ATTACH] Part ${partIndex} attachment has no encoding:`, {
                    encoding: safeTransferEncoding
                });
            }
            
            // Calculate actual size (decoded size for base64, raw size for others)
            const actualSize = Buffer.isBuffer(decodedAttachmentContent) 
                ? decodedAttachmentContent.length 
                : decodedAttachmentContent.length;
            
            const attachment = {
                partKey: partKey,
                filename: filename || `attachment-${partIndex}`,
                contentType: contentType || 'application/octet-stream',
                size: actualSize,
                contentDisposition: contentDisposition,
                isInline: isInline,
                originalEncoding: transferEncoding
            };
            if (contentId) {
                attachment.contentId = contentId;
            }
            
            // For text-based attachments, include decoded content as string
            if (contentType.includes('text/') || contentType.includes('application/json') || 
                contentType.includes('application/xml') || contentType.includes('message/')) {
                // Convert buffer to string for text attachments
                if (Buffer.isBuffer(decodedAttachmentContent)) {
                    attachment.content = decodedAttachmentContent.toString('utf-8');
                } else {
                    attachment.content = decodedAttachmentContent;
                }
                attachment.encoding = 'text';
                safeLog(`[ATTACH] Part ${partIndex} attachment is text-based:`, {
                    contentLength: attachment.content.length
                });
            } else {
                // For binary attachments, store the decoded binary content
                // We'll convert to base64 when needed for frontend, or save directly to S3
                if (Buffer.isBuffer(decodedAttachmentContent)) {
                    // Keep as Buffer for now - will be converted to base64 or saved to S3
                    attachment.decodedContent = decodedAttachmentContent; // Store decoded binary
                    attachment.content = decodedAttachmentContent.toString('base64'); // Also store base64 for small files
                    attachment.encoding = 'base64';
                } else {
                    // String content - convert to base64
                    attachment.content = Buffer.from(decodedAttachmentContent, 'utf-8').toString('base64');
                    attachment.encoding = 'base64';
                }
                safeLog(`[ATTACH] Part ${partIndex} attachment is binary:`, {
                    actualSize: actualSize,
                    base64Length: attachment.content.length
                });
            }
            
            structure.attachments.push(attachment);
            partObj.isAttachment = true;
            safeLog(`[OK] Added attachment to structure:`, {
                total: structure.attachments.length
            });
        } else {
            const safeContentType = contentType ? contentType.replace(/[^\x00-\x7F]/g, '?') : 'unknown';
            safeLog(`[INFO] Part ${partIndex} is not an attachment:`, {
                isInline: isInline,
                contentType: safeContentType
            });
        }
        
        structure.parts[partKey] = partObj;
        partIndex++;
    }
    
    safeLog(`Parsed structure:`, {
        partsCount: Object.keys(structure.parts).length,
        attachmentsCount: structure.attachments.length
    });
    return structure;
}

function extractFilename(contentDisposition) {
    if (!contentDisposition) return null;
    
    // Try to extract filename from Content-Disposition header
    // Handle both quoted and unquoted filenames
    // Also handle RFC 2047 encoded filenames (e.g., filename*=UTF-8''encoded-name)
    // And handle filenames that span multiple lines
    
    // First try standard filename=value format
    let filenameMatch = contentDisposition.match(/filename\s*=\s*"([^"]+)"/i);
    if (filenameMatch) {
        return filenameMatch[1];
    }
    
    // Try unquoted filename
    filenameMatch = contentDisposition.match(/filename\s*=\s*([^;\s\r\n]+)/i);
    if (filenameMatch) {
        return filenameMatch[1];
    }
    
    // Try RFC 2047 encoded filename (filename*=charset'lang'value)
    filenameMatch = contentDisposition.match(/filename\*\s*=\s*[^']*'[^']*'([^;\s\r\n]+)/i);
    if (filenameMatch) {
        // Decode if needed (basic handling)
        return decodeURIComponent(filenameMatch[1]);
    }
    
    // Try filename*0=, filename*1= format (multi-part encoded)
    const multiPartMatch = contentDisposition.match(/filename\*0\*=\s*([^;\s\r\n]+)/i);
    if (multiPartMatch) {
        return decodeURIComponent(multiPartMatch[1]);
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

async function handleInlineImage(event, headers, config) {
    const queryParams = event.queryStringParameters || {};
    const token = queryParams.t;
    if (!token) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing token (t)' }) };
    }
    const payload = verifyInlineImageToken(token, config);
    if (!payload || !payload.uid || !payload.emailId || !payload.contentId || !payload.folder) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Invalid or expired token' }) };
    }
    const { uid, emailId, contentId, folder } = payload;
    if (!['emails', 'sent'].includes(folder)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid folder' }) };
    }
    if (!config || !config.firebaseApp) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Configuration not available' }) };
    }
    const firebaseApp = config.firebaseApp;
    const firebasePath = folder === 'emails' ? `emails/${uid}/${emailId}` : `sent/${uid}/${emailId}`;
    const emailRef = firebaseApp.database().ref(firebasePath);
    const emailSnapshot = await emailRef.once('value');
    if (!emailSnapshot.exists()) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Email not found' }) };
    }
    const emailData = emailSnapshot.val();
    const contentIdLower = String(contentId).trim().toLowerCase();
    let s3Key = null;
    let contentType = 'application/octet-stream';
    const attachmentsS3 = emailData.attachmentsS3 || [];
    for (const att of attachmentsS3) {
        const attCid = (att.contentId || '').trim().toLowerCase();
        if (attCid === contentIdLower && att.s3Key) {
            s3Key = att.s3Key;
            contentType = att.contentType || contentType;
            break;
        }
    }
    if (!s3Key && emailData.structure && emailData.structure.attachments) {
        for (let i = 0; i < emailData.structure.attachments.length; i++) {
            const att = emailData.structure.attachments[i];
            const attCid = (att.contentId || '').trim().toLowerCase();
            if (attCid === contentIdLower && att.s3Key) {
                s3Key = att.s3Key;
                contentType = att.contentType || contentType;
                break;
            }
        }
    }
    if (!s3Key) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Inline image not found' }) };
    }
    const bucketName = config.s3BucketName || process.env.S3_BUCKET_NAME || 'vcmail-mail-inbox';
    const s3Client = (config && config.s3Client) || s3;
    try {
        const result = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: s3Key }));
        const bodyBytes = await s3BodyToBuffer(result.Body);
        const cacheControl = `private, max-age=${INLINE_IMAGE_CACHE_MAX_AGE}`;
        return {
            statusCode: 200,
            headers: {
                ...headers,
                'Content-Type': result.ContentType || contentType,
                'Cache-Control': cacheControl,
                'Content-Length': String(bodyBytes.length)
            },
            body: bodyBytes.toString('base64'),
            isBase64Encoded: true
        };
    } catch (err) {
        console.error('[inlineImage] S3 getObject error:', err);
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Image not found' }) };
    }
}

async function handleLoadEmail(event, uid, headers, config, lambdaContext) {
    try {
        if (!config || !config.firebaseApp) {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: 'firebaseApp is not defined' })
            };
        }
        
        const firebaseApp = config.firebaseApp;
        
        const queryParams = event.queryStringParameters || {};
        const emailId = queryParams.emailId;
        const folder = queryParams.folder || 'emails'; // 'emails' for inbox, 'sent' for sent folder
        
        if (!emailId) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'emailId parameter is required' })
            };
        }
        
        if (!['emails', 'sent'].includes(folder)) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'folder must be either "emails" or "sent"' })
            };
        }
        
        console.log(`Loading email ${emailId} from ${folder} folder for user ${uid}`);
        
        // Get email metadata from Firebase
        let firebasePath = folder === 'emails' ? `emails/${uid}/${emailId}` : `sent/${uid}/${emailId}`;
        let emailRef = firebaseApp.database().ref(firebasePath);
        let emailSnapshot = await emailRef.once('value');
        let emailData = null;
        let actualEmailId = emailId;
        
        // If not found, try searching by messageId (for old emails that might use messageId as key)
        if (!emailSnapshot.exists() && emailId.length > 20) {
            // emailId might actually be a messageId, try searching for it
            console.log(`Email not found at ${firebasePath}, trying to search by messageId...`);
            const emailsRef = firebaseApp.database().ref(folder === 'emails' ? `emails/${uid}` : `sent/${uid}`);
            const allEmailsSnapshot = await emailsRef.once('value');
            
            let foundEmail = null;
            let foundEmailId = null;
            
            allEmailsSnapshot.forEach((childSnapshot) => {
                const email = childSnapshot.val();
                if (email.messageId === emailId || childSnapshot.key === emailId) {
                    foundEmail = email;
                    foundEmailId = childSnapshot.key;
                    return true; // Stop iteration
                }
            });
            
            if (foundEmail) {
                console.log(`[OK] Found email by messageId lookup: ${foundEmailId}`);
                emailData = foundEmail;
                actualEmailId = foundEmailId; // Update emailId to the actual Firebase key
            } else {
                return {
                    statusCode: 404,
                    headers,
                    body: JSON.stringify({ error: 'Email not found' })
                };
            }
        } else if (!emailSnapshot.exists()) {
            return {
                statusCode: 404,
                headers,
                body: JSON.stringify({ error: 'Email not found' })
            };
        } else {
            emailData = emailSnapshot.val();
        }

        normalizeEmailAddressHeaders(emailData);
        console.log('[EMAIL] Email metadata from Firebase:', {
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
        });
        
        const bucketName = config.s3BucketName || process.env.S3_BUCKET_NAME || 'vcmail-mail-inbox';
        
        // Use cached S3 client from config if available
        const s3Client = (config && config.s3Client) || s3;
        
        // Handle backward compatibility: old emails might have content directly in Firebase
        let contentUrl = null;
        let emailContent = null;
        
        // Initialize attachmentUrls array early so it can be used in all code paths
        const attachmentUrls = [];
        
        // CRITICAL: If messageId exists and we don't have attachments, ALWAYS parse from old SES location
        // This ensures we get attachments even if the email was stored before attachment parsing was implemented
        const needsAttachmentParsing = emailData.messageId && 
            (!emailData.hasAttachments || emailData.attachmentCount === 0 || 
             (!emailData.attachmentsS3 || emailData.attachmentsS3.length === 0) ||
             (!emailData.structure || !emailData.structure.attachments || emailData.structure.attachments.length === 0));
        
        console.log(`[SEARCH] Attachment parsing check:`, {
            hasMessageId: !!emailData.messageId,
            hasAttachments: emailData.hasAttachments,
            attachmentCount: emailData.attachmentCount || 0,
            attachmentsS3Count: emailData.attachmentsS3?.length || 0,
            structureAttachmentsCount: emailData.structure?.attachments?.length || 0,
            needsAttachmentParsing: needsAttachmentParsing
        });
        
        // Prioritize contentS3Key if it exists (for sent emails and new format emails)
        if (emailData.contentS3Key) {
            // New format: content is in S3
            const contentS3Key = emailData.contentS3Key;
            try {
                // Verify the object exists before generating presigned URL
                // This prevents NoSuchKey errors when the URL is accessed
                try {
                    await s3Client.send(new HeadObjectCommand({
                        Bucket: bucketName,
                        Key: contentS3Key
                    }));
                    console.log(`[OK] Verified S3 object exists: ${contentS3Key}`);
                    
                    // Object exists, generate presigned URL
                    contentUrl = await presignGetObject(s3Client, {
                        bucket: bucketName,
                        key: contentS3Key,
                        expiresIn: 900
                    });
                    console.log(`[OK] Generated presigned URL for email content from S3: ${contentS3Key}`);
                } catch (headError) {
                    if (isS3NotFound(headError)) {
                        console.warn(`[WARN] S3 object not found at ${contentS3Key}, will try fallback paths`);
                        // Don't set contentUrl here, let fallback logic handle it
                    } else {
                        throw headError; // Re-throw other errors
                    }
                }
                
                // If we don't need attachment parsing, we're done - contentUrl is set
                // If we do need attachment parsing, we'll still try to parse from messageId location below
                // but contentUrl will be available as a fallback
            } catch (s3Error) {
                console.error(`[ERROR] Error generating presigned URL for ${contentS3Key}:`, s3Error);
                // Fallback: try old SES messageId location if available
                if (emailData.messageId && !emailData.messageId.startsWith('local_')) {
                    try {
                        // Also verify this object exists
                        try {
                            await s3Client.send(new HeadObjectCommand({
                                Bucket: bucketName,
                                Key: emailData.messageId
                            }));
                            console.log(`[OK] Verified fallback S3 object exists: ${emailData.messageId}`);
                            
                            contentUrl = await presignGetObject(s3Client, {
                                bucket: bucketName,
                                key: emailData.messageId,
                                expiresIn: 900
                            });
                            console.log(`[OK] Generated presigned URL from old SES location: ${emailData.messageId}`);
                        } catch (headError) {
                            if (isS3NotFound(headError)) {
                                console.warn(`[WARN] Fallback S3 object not found at ${emailData.messageId}`);
                                // Don't generate URL if object doesn't exist
                            } else {
                                throw headError;
                            }
                        }
                    } catch (oldS3Error) {
                        console.error(`[ERROR] Error accessing old SES location:`, oldS3Error);
                    }
                }
            }
        }
        
        // If we need attachment parsing and have a messageId (and contentS3Key didn't work or we need to parse attachments)
        if (emailData.messageId && needsAttachmentParsing && !emailData.messageId.startsWith('local_')) {
            // CRITICAL: Parse from old SES location to get attachments
            console.log(`[EMAIL] Parsing from old SES location to extract attachments (messageId: ${emailData.messageId})`);
            // CRITICAL: Always check old SES location if messageId exists
            // Even if content exists in Firebase, we need to parse the raw email to get attachments
            // This takes priority over emailData.content because attachments might not be in Firebase
            console.log(`[EMAIL] Checking old SES location for attachments (messageId: ${emailData.messageId})`);
            try {
                console.log(`[EMAIL] Loading raw email from old SES location: ${emailData.messageId}`);
                const rawEmailResult = await s3Client.send(new GetObjectCommand({
                    Bucket: bucketName,
                    Key: emailData.messageId
                }));
                
                const rawEmailContent = await s3BodyToUtf8(rawEmailResult.Body);
                console.log(`[OK] Loaded raw email from SES location (${rawEmailContent.length} chars)`);
                
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
                        
                        // Sanitize all strings before logging to avoid Unicode issues
                        try {
                            const sanitizedAttachments = emailStructure.attachments?.map(att => ({
                                filename: att.filename ? att.filename.replace(/[^\x00-\x7F]/g, '?') : null,
                                contentType: att.contentType ? att.contentType.replace(/[^\x00-\x7F]/g, '?') : null,
                                size: att.size,
                                hasContent: !!att.content,
                                hasDecodedContent: !!att.decodedContent
                            })) || [];
                            console.log(`[EMAIL] Parsed structure:`, JSON.stringify({
                                type: emailStructure.type,
                                partsCount: Object.keys(emailStructure.parts || {}).length,
                                attachmentsCount: emailStructure.attachments?.length || 0,
                                hasPreferredContent: !!emailStructure.preferredContent,
                                attachments: sanitizedAttachments
                            }));
                        } catch (logError) {
                            console.log(`[EMAIL] Parsed structure logging failed: ${logError.message}`);
                        }
                        
                        if (emailStructure.preferredContent) {
                            parsedContent = emailStructure.preferredContent.content;
                            parsedContentType = emailStructure.preferredContent.type;
                            console.log(`[EMAIL] Using preferred content type: ${parsedContentType}`);
                        }
                        
                        if (emailStructure.attachments && emailStructure.attachments.length > 0) {
                            // Sanitize filenames for logging to avoid Unicode encoding issues
                            console.log(`[ATTACH] Found ${emailStructure.attachments.length} attachments in old email:`, 
                                emailStructure.attachments.map(att => ({
                                    filename: att.filename ? att.filename.replace(/[^\x00-\x7F]/g, '?') : null,
                                    contentType: att.contentType ? att.contentType.replace(/[^\x00-\x7F]/g, '?') : null,
                                    size: att.size,
                                    isInline: att.isInline,
                                    hasContent: !!att.content,
                                    hasDecodedContent: !!att.decodedContent
                                }))
                            );
                            
                            console.log(`[TOOL] Processing ${emailStructure.attachments.length} attachments...`);
                            
                            // Process each attachment
                            for (let idx = 0; idx < emailStructure.attachments.length; idx++) {
                                const att = emailStructure.attachments[idx];
                                // Use actual decoded size, not base64 string length
                                const attSize = att.size || 0;
                                
                                // Sanitize filename for logging
                                const safeFilename = att.filename ? att.filename.replace(/[^\x00-\x7F]/g, '?') : null;
                                const safeContentType = att.contentType ? att.contentType.replace(/[^\x00-\x7F]/g, '?') : null;
                                console.log(`[ATTACH] Processing attachment ${idx}:`, {
                                    filename: safeFilename,
                                    contentType: safeContentType,
                                    size: attSize,
                                    hasContent: !!att.content,
                                    hasDecodedContent: !!att.decodedContent,
                                    encoding: att.encoding
                                });
                                
                                // Always save attachments to S3 and return URL instead of embedding
                                // This ensures all attachments are stored separately and use presigned URLs
                                if (att.content || att.decodedContent) {
                                    console.log(`[PACKAGE] Saving attachment ${idx} to S3 (${(attSize / 1024 / 1024).toFixed(2)}MB)...`);
                                    try {
                                        // Use decodedContent if available (Buffer), otherwise use content (base64 string)
                                        const attachmentData = {
                                            filename: att.filename || `attachment-${idx}`,
                                            contentType: att.contentType || 'application/octet-stream',
                                            content: att.decodedContent ? att.decodedContent.toString('base64') : att.content,
                                            encoding: att.decodedContent ? 'base64' : (att.encoding || 'base64'),
                                            partKey: att.partKey || `part_${idx}`
                                        };
                                        
                                        const s3Info = await saveAttachmentToS3(uid, actualEmailId, idx, attachmentData, folder, config);
                                        
                                        if (s3Info) {
                                            // Generate presigned URL for the attachment
                                            const attachmentUrl = await presignGetObject(s3Client, {
                                                bucket: bucketName,
                                                key: s3Info.s3Key,
                                                expiresIn: 900,
                                                responseContentDisposition: `attachment; filename="${s3Info.filename}"`
                                            });
                                            
                                            const parsedEntry = {
                                                filename: s3Info.filename,
                                                contentType: s3Info.contentType,
                                                size: s3Info.size,
                                                url: attachmentUrl,
                                                isInline: att.isInline || false,
                                                partKey: att.partKey || `part_${idx}`,
                                                ...(att.contentId && { contentId: att.contentId })
                                            };
                                            if (att.contentId) {
                                                parsedEntry.inlineImageToken = createInlineImageToken(uid, actualEmailId, att.contentId, folder, config);
                                            }
                                            await tryAddInlineIcsBodyToAttachmentEntry(
                                                parsedEntry,
                                                s3Info.s3Key,
                                                s3Info.size,
                                                s3Client,
                                                bucketName,
                                                'parsed:'
                                            );
                                            parsedAttachments.push(parsedEntry);
                                            const safeS3Filename = s3Info.filename ? s3Info.filename.replace(/[^\x00-\x7F]/g, '?') : 'unknown';
                                            console.log(`[OK] Attachment ${idx} saved to S3 and URL generated: ${safeS3Filename}`);
                                        } else {
                                            console.error(`[ERROR] S3 save returned null for attachment ${idx} - this should not happen`);
                                            // Don't fallback to embedding - this is an error condition
                                            throw new Error(`Failed to save attachment ${idx} to S3: saveAttachmentToS3 returned null`);
                                        }
                                    } catch (s3Error) {
                                        console.error(`[ERROR] Error saving attachment ${idx} to S3:`, s3Error);
                                        console.error(`   Error details:`, {
                                            message: s3Error.message,
                                            code: s3Error.code,
                                            stack: s3Error.stack?.substring(0, 500)
                                        });
                                        // Don't fallback to embedding - throw error instead
                                        // This ensures we don't accidentally embed large attachments
                                        throw new Error(`Failed to save attachment ${idx} to S3: ${s3Error.message}`);
                                    }
                                } else {
                                    // Attachment has no content - this shouldn't happen for valid attachments
                                    console.warn(`[WARN] Attachment ${idx} has no content or decodedContent - skipping`);
                                }
                            }
                        } else {
                            console.log(`[ATTACH] No attachments found in parsed structure`);
                        }
                    } else {
                        console.log(`[WARN] Multipart content type but no boundary found`);
                    }
                } else {
                    console.log(`[EMAIL] Email is not multipart (content-type: ${contentType})`);
                }
                
                // Use parsed content directly (old format response)
                emailContent = parsedContent;
                console.log(`[OK] Extracted email content (${emailContent.length} chars) and ${parsedAttachments.length} attachments`);
                
                // Update attachmentUrls with parsed attachments
                // CRITICAL: Always add attachments, even if S3 save failed
                if (parsedAttachments.length > 0) {
                    attachmentUrls.push(...parsedAttachments);
                    console.log(`[OK] Added ${parsedAttachments.length} parsed attachments to attachmentUrls (total: ${attachmentUrls.length})`);
                    // Sanitize filenames for logging
                    console.log(`[ATTACH] Parsed attachments details:`, parsedAttachments.map(att => ({
                        filename: att.filename ? att.filename.replace(/[^\x00-\x7F]/g, '?') : null,
                        size: att.size,
                        contentType: att.contentType ? att.contentType.replace(/[^\x00-\x7F]/g, '?') : null,
                        hasUrl: !!att.url,
                        hasContent: !!att.content,
                        hasDecodedContent: !!att.decodedContent
                    })));
                } else {
                    console.log(`[WARN] No parsed attachments to add (parsedAttachments.length: ${parsedAttachments.length})`);
                    // If we parsed attachments but they weren't added, log a warning
                    if (emailStructure.attachments && emailStructure.attachments.length > 0) {
                        console.error(`[ERROR] CRITICAL: Parsed ${emailStructure.attachments.length} attachments but none were added to parsedAttachments!`);
                        console.error(`   This indicates a bug in attachment processing logic.`);
                    }
                }
                
            } catch (s3Error) {
                console.error(`[ERROR] Error loading/parsing old SES email ${emailData.messageId}:`, s3Error);
            }
        }
        
        // Fallback: if we still don't have a contentUrl, try constructed path
        if (!contentUrl) {
            const fallbackS3Key = `${folder}/${uid}/${actualEmailId}/body`;
            try {
                // Verify the object exists before generating presigned URL
                try {
                    await s3Client.send(new HeadObjectCommand({
                        Bucket: bucketName,
                        Key: fallbackS3Key
                    }));
                    console.log(`[OK] Verified fallback S3 object exists: ${fallbackS3Key}`);
                    
                    contentUrl = await presignGetObject(s3Client, {
                        bucket: bucketName,
                        key: fallbackS3Key,
                        expiresIn: 900
                    });
                    console.log(`[OK] Generated presigned URL from fallback path: ${fallbackS3Key}`);
                } catch (headError) {
                    if (isS3NotFound(headError)) {
                        console.warn(`[WARN] Fallback S3 object not found at ${fallbackS3Key}`);
                        // Don't generate URL if object doesn't exist
                    } else {
                        throw headError;
                    }
                }
            } catch (s3Error) {
                console.error(`[ERROR] Error accessing fallback path:`, s3Error);
            }
        }
        
        // Final fallback: if we still don't have a contentUrl, check if content is available directly in Firebase
        if (!contentUrl && emailData.content && emailData.content.length > 0) {
            console.log(`[OK] Using content directly from Firebase (fallback, ${emailData.content.length} chars)`);
            emailContent = emailData.content;
        }
        
        // Generate presigned URLs for attachments if any
        // (attachmentUrls already initialized above)
        
        // New format: attachments in attachmentsS3 array
        if (emailData.attachmentsS3 && emailData.attachmentsS3.length > 0) {
            for (const attachment of emailData.attachmentsS3) {
                try {
                    const attachmentUrl = await presignGetObject(s3Client, {
                        bucket: bucketName,
                        key: attachment.s3Key,
                        expiresIn: 900,
                        responseContentDisposition: `attachment; filename="${attachment.filename}"`
                    });
                    const attEntry = {
                        filename: attachment.filename,
                        contentType: attachment.contentType,
                        size: attachment.size,
                        url: attachmentUrl,
                        isInline: attachment.isInline,
                        partKey: attachment.partKey,
                        ...(attachment.contentId && { contentId: attachment.contentId })
                    };
                    if (attachment.contentId) {
                        attEntry.inlineImageToken = createInlineImageToken(uid, actualEmailId, attachment.contentId, folder, config);
                    }
                    await tryAddInlineIcsBodyToAttachmentEntry(
                        attEntry,
                        attachment.s3Key,
                        attachment.size,
                        s3Client,
                        bucketName
                    );
                    attachmentUrls.push(attEntry);
                } catch (attError) {
                    console.error(`[ERROR] Error generating presigned URL for attachment ${attachment.s3Key}:`, attError);
                }
            }
            console.log(`[OK] Generated ${attachmentUrls.length} presigned URLs for attachments from attachmentsS3`);
        }
        
        // Old format: attachments embedded in structure (backward compatibility)
        if (attachmentUrls.length === 0 && emailData.structure && emailData.structure.attachments) {
            console.log(`[EMAIL] Found attachments in old structure format, extracting...`);
            for (let i = 0; i < emailData.structure.attachments.length; i++) {
                const attachment = emailData.structure.attachments[i];
                // If attachment has s3Key, try to load from S3
                if (attachment.s3Key) {
                    try {
                        const attachmentUrl = await presignGetObject(s3Client, {
                            bucket: bucketName,
                            key: attachment.s3Key,
                            expiresIn: 900,
                            responseContentDisposition: `attachment; filename="${attachment.filename || `attachment-${i}`}"`
                        });
                        const attEntry = {
                            filename: attachment.filename || `attachment-${i}`,
                            contentType: attachment.contentType || 'application/octet-stream',
                            size: attachment.size || 0,
                            url: attachmentUrl,
                            isInline: attachment.isInline || false,
                            partKey: attachment.partKey || `part_${i}`,
                            ...(attachment.contentId && { contentId: attachment.contentId })
                        };
                        if (attachment.contentId) {
                            attEntry.inlineImageToken = createInlineImageToken(uid, actualEmailId, attachment.contentId, folder, config);
                        }
                        await tryAddInlineIcsBodyToAttachmentEntry(
                            attEntry,
                            attachment.s3Key,
                            attachment.size,
                            s3Client,
                            bucketName,
                            'structure:'
                        );
                        attachmentUrls.push(attEntry);
                    } catch (attError) {
                        console.error(`[ERROR] Error generating presigned URL for attachment ${attachment.s3Key}:`, attError);
                    }
                } else if (attachment.content) {
                    // Attachment content is embedded (old format) - include it directly
                    const attEntry = {
                        filename: attachment.filename || `attachment-${i}`,
                        contentType: attachment.contentType || 'application/octet-stream',
                        size: attachment.size || (attachment.content ? attachment.content.length : 0),
                        content: attachment.content,
                        encoding: attachment.encoding || 'text',
                        isInline: attachment.isInline || false,
                        partKey: attachment.partKey || `part_${i}`,
                        ...(attachment.contentId && { contentId: attachment.contentId })
                    };
                    if (attachment.contentId) {
                        attEntry.inlineImageToken = createInlineImageToken(uid, actualEmailId, attachment.contentId, folder, config);
                    }
                    attachmentUrls.push(attEntry);
                }
            }
            console.log(`[OK] Extracted ${attachmentUrls.length} attachments from old structure format`);
        }
        
        const responseData = {
            emailId: actualEmailId, // Use the actual Firebase key
            contentUrl: contentUrl,
            content: emailContent, // Include direct content if available (old format)
            contentType: emailData.contentType,
            attachments: attachmentUrls,
            metadata: {
                subject: emailData.subject,
                from: emailData.from,
                to: emailData.to,
                timestamp: emailData.timestamp,
                messageId: emailData.messageId,
                hasAttachments: emailData.hasAttachments || attachmentUrls.length > 0, // Update if we found attachments
                structure: emailData.structure
            }
        };
        
        safeLog('[EMAIL] Returning email data:', {
            emailId: responseData.emailId,
            hasContentUrl: !!responseData.contentUrl,
            hasContent: !!responseData.content,
            contentLength: responseData.content?.length || 0,
            attachmentsCount: responseData.attachments.length,
            attachmentUrlsLength: attachmentUrls.length,
            attachments: responseData.attachments.map(att => ({
                filename: att.filename ? att.filename.replace(/[^\x00-\x7F]/g, '?') : null,
                size: att.size,
                hasUrl: !!att.url,
                hasContent: !!att.content
            })),
            metadataSubject: responseData.metadata.subject ? responseData.metadata.subject.replace(/[^\x00-\x7F]/g, '?') : null,
            metadataHasAttachments: responseData.metadata.hasAttachments,
            emailDataHasAttachments: emailData.hasAttachments,
            emailDataMessageId: emailData.messageId,
            emailDataContentS3Key: emailData.contentS3Key,
            emailDataHasContent: !!emailData.content
        });
        
        // CRITICAL DEBUG: If we have messageId but no attachments, log why
        if (emailData.messageId && responseData.attachments.length === 0) {
            safeLog(`[ERROR] CRITICAL: Email has messageId but no attachments in response!`, {
                messageId: emailData.messageId,
                attachmentsCount: responseData.attachments.length
            });
            safeLog(`   This suggests the parsing code path was not executed or failed silently.`);
            safeLog(`   Check logs above for parsing errors.`);
        }
        
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(responseData)
        };
        
    } catch (error) {
        safeLog('[ERROR] Error loading email:', {
            message: error.message,
            stack: error.stack ? error.stack.substring(0, 500) : 'no stack'
        });
        return {
            statusCode: 500,
            headers: json500Headers(headers),
            body: buildApiErrorJsonBody(error, lambdaContext)
        };
    }
}

async function handleDeleteEmail(event, uid, headers, config) {
    if (!config || !config.firebaseApp) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'firebaseApp is not defined' })
        };
    }
    
    const firebaseApp = config.firebaseApp;
    
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
// Export parsing functions for testing
module.exports.parseMultipartStructure = parseMultipartStructure;
module.exports.extractFilename = extractFilename;
module.exports.extractBoundary = extractBoundary;
module.exports.decodePartContent = decodePartContent;
module.exports.handleLoadEmail = handleLoadEmail;

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
