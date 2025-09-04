const admin = require('firebase-admin');
const mysql = require('mysql2/promise');
const redis = require('redis');
const winston = require('winston');
const cron = require('node-cron');

// Initialize Firebase Admin
const serviceAccount = require('./firebase-service-account.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
});

// Initialize database connection
const db = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQL_USER || 'vcmail',
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'vcmail_mail',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Initialize Redis
const redisClient = redis.createClient({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379
});

redisClient.on('error', (err) => {
    console.error('Redis Client Error:', err);
});

// Initialize logger
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: '/var/log/vcmail/sync-error.log', level: 'error' }),
        new winston.transports.File({ filename: '/var/log/vcmail/sync-combined.log' }),
        new winston.transports.Console({
            format: winston.format.simple()
        })
    ]
});

class FirebaseEmailSync {
    constructor() {
        this.syncInProgress = false;
        this.lastSyncTime = null;
        this.syncInterval = 5 * 60 * 1000; // 5 minutes
        this.batchSize = 100;
        this.maxRetries = 3;
        this.retryDelay = 1000; // 1 second
    }

    async start() {
        logger.info('Starting Firebase email synchronization...');
        
        // Initial sync
        await this.performFullSync();
        
        // Schedule regular syncs
        cron.schedule('*/5 * * * *', () => {
            this.performIncrementalSync();
        });
        
        // Schedule daily full sync
        cron.schedule('0 2 * * *', () => {
            this.performFullSync();
        });
        
        logger.info('Firebase email synchronization started');
    }

    async performFullSync() {
        if (this.syncInProgress) {
            logger.warn('Sync already in progress, skipping full sync');
            return;
        }

        this.syncInProgress = true;
        logger.info('Starting full sync...');

        try {
            // Sync emails from Firebase to MySQL
            await this.syncEmailsFromFirebase();
            
            // Sync sent emails from Firebase to MySQL
            await this.syncSentEmailsFromFirebase();
            
            // Sync user mailboxes
            await this.syncUserMailboxes();
            
            // Update sync timestamp
            this.lastSyncTime = Date.now();
            await this.updateSyncTimestamp();
            
            logger.info('Full sync completed successfully');
        } catch (error) {
            logger.error('Full sync failed:', error);
        } finally {
            this.syncInProgress = false;
        }
    }

    async performIncrementalSync() {
        if (this.syncInProgress) {
            logger.warn('Sync already in progress, skipping incremental sync');
            return;
        }

        this.syncInProgress = true;
        logger.info('Starting incremental sync...');

        try {
            // Get last sync time
            const lastSync = await this.getLastSyncTime();
            
            // Sync new emails since last sync
            await this.syncNewEmailsFromFirebase(lastSync);
            
            // Sync new sent emails since last sync
            await this.syncNewSentEmailsFromFirebase(lastSync);
            
            // Update sync timestamp
            this.lastSyncTime = Date.now();
            await this.updateSyncTimestamp();
            
            logger.info('Incremental sync completed successfully');
        } catch (error) {
            logger.error('Incremental sync failed:', error);
        } finally {
            this.syncInProgress = false;
        }
    }

    async syncEmailsFromFirebase() {
        logger.info('Syncing emails from Firebase to MySQL...');
        
        try {
            const db = admin.database();
            const emailsRef = db.ref('emails');
            const snapshot = await emailsRef.once('value');
            const emails = snapshot.val() || {};
            
            let syncedCount = 0;
            let errorCount = 0;
            
            for (const [userId, userEmails] of Object.entries(emails)) {
                for (const [emailId, email] of Object.entries(userEmails)) {
                    try {
                        await this.syncEmailToDatabase(email, userId, emailId);
                        syncedCount++;
                    } catch (error) {
                        logger.error(`Error syncing email ${emailId}:`, error);
                        errorCount++;
                    }
                }
            }
            
            logger.info(`Emails sync completed: ${syncedCount} synced, ${errorCount} errors`);
        } catch (error) {
            logger.error('Error syncing emails from Firebase:', error);
            throw error;
        }
    }

    async syncSentEmailsFromFirebase() {
        logger.info('Syncing sent emails from Firebase to MySQL...');
        
        try {
            const db = admin.database();
            const sentRef = db.ref('sent');
            const snapshot = await sentRef.once('value');
            const sentEmails = snapshot.val() || {};
            
            let syncedCount = 0;
            let errorCount = 0;
            
            for (const [userId, userSentEmails] of Object.entries(sentEmails)) {
                for (const [emailId, email] of Object.entries(userSentEmails)) {
                    try {
                        await this.syncEmailToDatabase(email, userId, emailId, 'sent');
                        syncedCount++;
                    } catch (error) {
                        logger.error(`Error syncing sent email ${emailId}:`, error);
                        errorCount++;
                    }
                }
            }
            
            logger.info(`Sent emails sync completed: ${syncedCount} synced, ${errorCount} errors`);
        } catch (error) {
            logger.error('Error syncing sent emails from Firebase:', error);
            throw error;
        }
    }

    async syncUserMailboxes() {
        logger.info('Syncing user mailboxes from Firebase...');
        
        try {
            const db = admin.database();
            const usersRef = db.ref('users');
            const snapshot = await usersRef.once('value');
            const users = snapshot.val() || {};
            
            let syncedCount = 0;
            let errorCount = 0;
            
            for (const [userId, userData] of Object.entries(users)) {
                if (userData.mailboxes) {
                    for (const [mailboxName, mailbox] of Object.entries(userData.mailboxes)) {
                        if (mailbox.messages) {
                            for (const [messageId, message] of Object.entries(mailbox.messages)) {
                                try {
                                    await this.syncEmailToDatabase(message, userId, messageId, mailboxName);
                                    syncedCount++;
                                } catch (error) {
                                    logger.error(`Error syncing mailbox email ${messageId}:`, error);
                                    errorCount++;
                                }
                            }
                        }
                    }
                }
            }
            
            logger.info(`User mailboxes sync completed: ${syncedCount} synced, ${errorCount} errors`);
        } catch (error) {
            logger.error('Error syncing user mailboxes:', error);
            throw error;
        }
    }

    async syncNewEmailsFromFirebase(lastSyncTime) {
        logger.info('Syncing new emails from Firebase since last sync...');
        
        try {
            const db = admin.database();
            const emailsRef = db.ref('emails');
            const snapshot = await emailsRef.once('value');
            const emails = snapshot.val() || {};
            
            let syncedCount = 0;
            let errorCount = 0;
            
            for (const [userId, userEmails] of Object.entries(emails)) {
                for (const [emailId, email] of Object.entries(userEmails)) {
                    // Only sync emails newer than last sync time
                    if (email.timestamp > lastSyncTime) {
                        try {
                            await this.syncEmailToDatabase(email, userId, emailId);
                            syncedCount++;
                        } catch (error) {
                            logger.error(`Error syncing new email ${emailId}:`, error);
                            errorCount++;
                        }
                    }
                }
            }
            
            logger.info(`New emails sync completed: ${syncedCount} synced, ${errorCount} errors`);
        } catch (error) {
            logger.error('Error syncing new emails from Firebase:', error);
            throw error;
        }
    }

    async syncNewSentEmailsFromFirebase(lastSyncTime) {
        logger.info('Syncing new sent emails from Firebase since last sync...');
        
        try {
            const db = admin.database();
            const sentRef = db.ref('sent');
            const snapshot = await sentRef.once('value');
            const sentEmails = snapshot.val() || {};
            
            let syncedCount = 0;
            let errorCount = 0;
            
            for (const [userId, userSentEmails] of Object.entries(sentEmails)) {
                for (const [emailId, email] of Object.entries(userSentEmails)) {
                    // Only sync emails newer than last sync time
                    if (email.timestamp > lastSyncTime) {
                        try {
                            await this.syncEmailToDatabase(email, userId, emailId, 'sent');
                            syncedCount++;
                        } catch (error) {
                            logger.error(`Error syncing new sent email ${emailId}:`, error);
                            errorCount++;
                        }
                    }
                }
            }
            
            logger.info(`New sent emails sync completed: ${syncedCount} synced, ${errorCount} errors`);
        } catch (error) {
            logger.error('Error syncing new sent emails from Firebase:', error);
            throw error;
        }
    }

    async syncEmailToDatabase(email, userId, emailId, folder = 'inbox') {
        try {
            // Check if email already exists in database
            const [rows] = await db.execute(
                'SELECT id FROM emails WHERE message_id = ? AND user_id = ? AND folder = ?',
                [email.messageId || emailId, userId, folder]
            );
            
            if (rows.length > 0) {
                // Update existing email
                await db.execute(
                    'UPDATE emails SET from_address = ?, to_address = ?, subject = ?, body = ?, content_type = ?, timestamp = ?, size = ?, headers = ?, attachments = ?, updated_at = CURRENT_TIMESTAMP WHERE message_id = ? AND user_id = ? AND folder = ?',
                    [
                        email.from || '',
                        email.to || '',
                        email.subject || 'No Subject',
                        email.content || email.body || '',
                        email.contentType || 'text/plain',
                        email.timestamp || Date.now(),
                        email.size || 0,
                        JSON.stringify(email.headers || {}),
                        JSON.stringify(email.attachments || []),
                        email.messageId || emailId,
                        userId,
                        folder
                    ]
                );
            } else {
                // Insert new email
                await db.execute(
                    'INSERT INTO emails (message_id, user_id, folder, from_address, to_address, subject, body, content_type, timestamp, size, headers, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
                    [
                        email.messageId || emailId,
                        userId,
                        folder,
                        email.from || '',
                        email.to || '',
                        email.subject || 'No Subject',
                        email.content || email.body || '',
                        email.contentType || 'text/plain',
                        email.timestamp || Date.now(),
                        email.size || 0,
                        JSON.stringify(email.headers || {}),
                        JSON.stringify(email.attachments || [])
                    ]
                );
            }
            
            // Update Redis cache
            await this.updateRedisCache(userId, emailId, email, folder);
            
        } catch (error) {
            logger.error(`Error syncing email to database:`, error);
            throw error;
        }
    }

    async updateRedisCache(userId, emailId, email, folder) {
        try {
            const cacheKey = `email:${userId}:${folder}:${emailId}`;
            const cacheData = {
                messageId: email.messageId || emailId,
                from: email.from || '',
                to: email.to || '',
                subject: email.subject || 'No Subject',
                content: email.content || email.body || '',
                contentType: email.contentType || 'text/plain',
                timestamp: email.timestamp || Date.now(),
                size: email.size || 0,
                headers: email.headers || {},
                attachments: email.attachments || []
            };
            
            await redisClient.setex(cacheKey, 3600, JSON.stringify(cacheData)); // Cache for 1 hour
        } catch (error) {
            logger.error('Error updating Redis cache:', error);
        }
    }

    async getLastSyncTime() {
        try {
            const [rows] = await db.execute(
                'SELECT last_sync_time FROM sync_status WHERE id = 1'
            );
            
            if (rows.length > 0) {
                return rows[0].last_sync_time;
            }
            
            return 0; // First sync
        } catch (error) {
            logger.error('Error getting last sync time:', error);
            return 0;
        }
    }

    async updateSyncTimestamp() {
        try {
            await db.execute(
                'INSERT INTO sync_status (id, last_sync_time, sync_type) VALUES (1, ?, ?) ON DUPLICATE KEY UPDATE last_sync_time = ?, sync_type = ?',
                [this.lastSyncTime, 'incremental', this.lastSyncTime, 'incremental']
            );
        } catch (error) {
            logger.error('Error updating sync timestamp:', error);
        }
    }

    async getSyncStatus() {
        try {
            const [rows] = await db.execute(
                'SELECT * FROM sync_status WHERE id = 1'
            );
            
            if (rows.length > 0) {
                return {
                    lastSyncTime: rows[0].last_sync_time,
                    syncType: rows[0].sync_type,
                    syncInProgress: this.syncInProgress
                };
            }
            
            return {
                lastSyncTime: null,
                syncType: 'none',
                syncInProgress: this.syncInProgress
            };
        } catch (error) {
            logger.error('Error getting sync status:', error);
            return {
                lastSyncTime: null,
                syncType: 'error',
                syncInProgress: this.syncInProgress
            };
        }
    }

    async forceSync() {
        logger.info('Force sync requested...');
        await this.performFullSync();
    }

    async stop() {
        logger.info('Stopping Firebase email synchronization...');
        this.syncInProgress = false;
    }
}

// Create sync instance
const firebaseSync = new FirebaseEmailSync();

// Export for use in other modules
module.exports = firebaseSync;

// Start sync if this file is run directly
if (require.main === module) {
    firebaseSync.start().catch(error => {
        logger.error('Failed to start Firebase sync:', error);
        process.exit(1);
    });
}
