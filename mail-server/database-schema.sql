-- VCMail Database Schema
-- This file contains the MySQL database schema for the VCMail mail server

-- Create database if it doesn't exist
CREATE DATABASE IF NOT EXISTS vcmail_mail CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE vcmail_mail;

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(100) UNIQUE NOT NULL,
    display_name VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    last_login TIMESTAMP NULL,
    is_active BOOLEAN DEFAULT TRUE,
    INDEX idx_user_id (user_id),
    INDEX idx_email (email),
    INDEX idx_username (username)
);

-- Emails table
CREATE TABLE IF NOT EXISTS emails (
    id INT AUTO_INCREMENT PRIMARY KEY,
    message_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    folder ENUM('inbox', 'sent', 'drafts', 'trash', 'custom') DEFAULT 'inbox',
    from_address VARCHAR(255) NOT NULL,
    to_address TEXT NOT NULL,
    cc_address TEXT,
    bcc_address TEXT,
    subject VARCHAR(500),
    body LONGTEXT,
    content_type VARCHAR(100) DEFAULT 'text/plain',
    timestamp BIGINT NOT NULL,
    size INT DEFAULT 0,
    flags JSON,
    headers JSON,
    attachments JSON,
    is_read BOOLEAN DEFAULT FALSE,
    is_flagged BOOLEAN DEFAULT FALSE,
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_message_id (message_id),
    INDEX idx_user_id (user_id),
    INDEX idx_folder (folder),
    INDEX idx_timestamp (timestamp),
    INDEX idx_from_address (from_address),
    INDEX idx_subject (subject),
    INDEX idx_is_read (is_read),
    INDEX idx_is_deleted (is_deleted),
    UNIQUE KEY unique_user_message (user_id, message_id, folder)
);

-- Mailboxes table
CREATE TABLE IF NOT EXISTS mailboxes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    display_name VARCHAR(255),
    parent_id INT NULL,
    flags JSON,
    attributes JSON,
    message_count INT DEFAULT 0,
    unseen_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_name (name),
    INDEX idx_parent_id (parent_id),
    UNIQUE KEY unique_user_mailbox (user_id, name),
    FOREIGN KEY (parent_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

-- Sessions table for IMAP connections
CREATE TABLE IF NOT EXISTS sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_id VARCHAR(255) UNIQUE NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    username VARCHAR(255) NOT NULL,
    client_info TEXT,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    INDEX idx_session_id (session_id),
    INDEX idx_user_id (user_id),
    INDEX idx_expires_at (expires_at),
    INDEX idx_is_active (is_active)
);

-- Sync status table
CREATE TABLE IF NOT EXISTS sync_status (
    id INT PRIMARY KEY DEFAULT 1,
    last_sync_time BIGINT,
    sync_type ENUM('full', 'incremental', 'manual') DEFAULT 'incremental',
    sync_duration INT,
    emails_synced INT DEFAULT 0,
    errors_count INT DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Email statistics table
CREATE TABLE IF NOT EXISTS email_stats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    date DATE NOT NULL,
    emails_received INT DEFAULT 0,
    emails_sent INT DEFAULT 0,
    emails_deleted INT DEFAULT 0,
    total_size BIGINT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_date (date),
    UNIQUE KEY unique_user_date (user_id, date)
);

-- Attachments table
CREATE TABLE IF NOT EXISTS attachments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email_id INT NOT NULL,
    filename VARCHAR(255) NOT NULL,
    content_type VARCHAR(100),
    size INT DEFAULT 0,
    storage_path VARCHAR(500),
    checksum VARCHAR(64),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_email_id (email_id),
    INDEX idx_filename (filename),
    INDEX idx_checksum (checksum),
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);

-- Email flags table
CREATE TABLE IF NOT EXISTS email_flags (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email_id INT NOT NULL,
    flag_name VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_email_id (email_id),
    INDEX idx_flag_name (flag_name),
    UNIQUE KEY unique_email_flag (email_id, flag_name),
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);

-- User preferences table
CREATE TABLE IF NOT EXISTS user_preferences (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    preference_key VARCHAR(100) NOT NULL,
    preference_value TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_preference_key (preference_key),
    UNIQUE KEY unique_user_preference (user_id, preference_key)
);

-- Audit log table
CREATE TABLE IF NOT EXISTS audit_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255),
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),
    resource_id VARCHAR(255),
    details JSON,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_action (action),
    INDEX idx_resource_type (resource_type),
    INDEX idx_created_at (created_at)
);

-- Create views for common queries

-- View for email summary
CREATE OR REPLACE VIEW email_summary AS
SELECT 
    e.id,
    e.message_id,
    e.user_id,
    e.folder,
    e.from_address,
    e.to_address,
    e.subject,
    e.timestamp,
    e.size,
    e.is_read,
    e.is_flagged,
    e.is_deleted,
    e.created_at,
    u.username,
    u.display_name
FROM emails e
JOIN users u ON e.user_id = u.user_id
WHERE e.is_deleted = FALSE;

-- View for mailbox statistics
CREATE OR REPLACE VIEW mailbox_stats AS
SELECT 
    m.id,
    m.user_id,
    m.name,
    m.display_name,
    m.message_count,
    m.unseen_count,
    COUNT(e.id) as actual_message_count,
    COUNT(CASE WHEN e.is_read = FALSE THEN 1 END) as actual_unseen_count
FROM mailboxes m
LEFT JOIN emails e ON m.user_id = e.user_id AND m.name = e.folder AND e.is_deleted = FALSE
GROUP BY m.id, m.user_id, m.name, m.display_name, m.message_count, m.unseen_count;

-- Create stored procedures

-- Procedure to clean up expired sessions
DELIMITER //
CREATE PROCEDURE CleanupExpiredSessions()
BEGIN
    DELETE FROM sessions WHERE expires_at < NOW() OR is_active = FALSE;
END //
DELIMITER ;

-- Procedure to update email statistics
DELIMITER //
CREATE PROCEDURE UpdateEmailStats(IN p_user_id VARCHAR(255), IN p_date DATE)
BEGIN
    INSERT INTO email_stats (user_id, date, emails_received, emails_sent, emails_deleted, total_size)
    SELECT 
        p_user_id,
        p_date,
        COUNT(CASE WHEN folder = 'inbox' THEN 1 END) as emails_received,
        COUNT(CASE WHEN folder = 'sent' THEN 1 END) as emails_sent,
        COUNT(CASE WHEN is_deleted = TRUE THEN 1 END) as emails_deleted,
        SUM(size) as total_size
    FROM emails 
    WHERE user_id = p_user_id 
    AND DATE(FROM_UNIXTIME(timestamp/1000)) = p_date
    ON DUPLICATE KEY UPDATE
        emails_received = VALUES(emails_received),
        emails_sent = VALUES(emails_sent),
        emails_deleted = VALUES(emails_deleted),
        total_size = VALUES(total_size),
        updated_at = CURRENT_TIMESTAMP;
END //
DELIMITER ;

-- Procedure to get user email count
DELIMITER //
CREATE PROCEDURE GetUserEmailCount(IN p_user_id VARCHAR(255), IN p_folder VARCHAR(50))
BEGIN
    SELECT 
        COUNT(*) as total_count,
        COUNT(CASE WHEN is_read = FALSE THEN 1 END) as unread_count,
        SUM(size) as total_size
    FROM emails 
    WHERE user_id = p_user_id 
    AND folder = p_folder 
    AND is_deleted = FALSE;
END //
DELIMITER ;

-- Create triggers

-- Trigger to update mailbox statistics when emails are inserted
DELIMITER //
CREATE TRIGGER update_mailbox_stats_insert
AFTER INSERT ON emails
FOR EACH ROW
BEGIN
    UPDATE mailboxes 
    SET 
        message_count = message_count + 1,
        unseen_count = unseen_count + CASE WHEN NEW.is_read = FALSE THEN 1 ELSE 0 END,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = NEW.user_id AND name = NEW.folder;
END //
DELIMITER ;

-- Trigger to update mailbox statistics when emails are updated
DELIMITER //
CREATE TRIGGER update_mailbox_stats_update
AFTER UPDATE ON emails
FOR EACH ROW
BEGIN
    -- Update old folder statistics
    UPDATE mailboxes 
    SET 
        message_count = message_count - 1,
        unseen_count = unseen_count - CASE WHEN OLD.is_read = FALSE THEN 1 ELSE 0 END,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = OLD.user_id AND name = OLD.folder;
    
    -- Update new folder statistics
    UPDATE mailboxes 
    SET 
        message_count = message_count + 1,
        unseen_count = unseen_count + CASE WHEN NEW.is_read = FALSE THEN 1 ELSE 0 END,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = NEW.user_id AND name = NEW.folder;
END //
DELIMITER ;

-- Trigger to update mailbox statistics when emails are deleted
DELIMITER //
CREATE TRIGGER update_mailbox_stats_delete
AFTER DELETE ON emails
FOR EACH ROW
BEGIN
    UPDATE mailboxes 
    SET 
        message_count = message_count - 1,
        unseen_count = unseen_count - CASE WHEN OLD.is_read = FALSE THEN 1 ELSE 0 END,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = OLD.user_id AND name = OLD.folder;
END //
DELIMITER ;

-- Insert default data

-- Insert default mailboxes for new users
INSERT IGNORE INTO mailboxes (user_id, name, display_name, flags, attributes) VALUES
('default', 'INBOX', 'Inbox', '["\\HasNoChildren"]', '["\\HasNoChildren"]'),
('default', 'Sent', 'Sent Items', '["\\HasNoChildren"]', '["\\HasNoChildren"]'),
('default', 'Drafts', 'Drafts', '["\\HasNoChildren"]', '["\\HasNoChildren"]'),
('default', 'Trash', 'Trash', '["\\HasNoChildren"]', '["\\HasNoChildren"]');

-- Insert initial sync status
INSERT IGNORE INTO sync_status (id, last_sync_time, sync_type, sync_duration, emails_synced, errors_count) VALUES
(1, 0, 'incremental', 0, 0, 0);

-- Create indexes for performance optimization

-- Composite indexes for common queries
CREATE INDEX idx_emails_user_folder_timestamp ON emails(user_id, folder, timestamp);
CREATE INDEX idx_emails_user_folder_read ON emails(user_id, folder, is_read);
CREATE INDEX idx_emails_user_folder_deleted ON emails(user_id, folder, is_deleted);
CREATE INDEX idx_emails_timestamp_desc ON emails(timestamp DESC);
CREATE INDEX idx_emails_subject_search ON emails(subject(100));
CREATE INDEX idx_emails_from_search ON emails(from_address(100));

-- Full-text search index for email content
ALTER TABLE emails ADD FULLTEXT(body, subject);

-- Create user for the application
CREATE USER IF NOT EXISTS 'vcmail'@'localhost' IDENTIFIED BY 'your_mysql_password';
GRANT ALL PRIVILEGES ON vcmail_mail.* TO 'vcmail'@'localhost';
FLUSH PRIVILEGES;

-- Grant permissions for remote connections (if needed)
-- CREATE USER IF NOT EXISTS 'vcmail'@'%' IDENTIFIED BY 'your_mysql_password';
-- GRANT ALL PRIVILEGES ON vcmail_mail.* TO 'vcmail'@'%';
-- FLUSH PRIVILEGES;

-- Show table information
SHOW TABLES;
DESCRIBE emails;
DESCRIBE mailboxes;
DESCRIBE sessions;
DESCRIBE sync_status;

-- Show indexes
SHOW INDEX FROM emails;
SHOW INDEX FROM mailboxes;
SHOW INDEX FROM sessions;
