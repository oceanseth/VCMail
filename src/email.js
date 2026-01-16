import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword, EmailAuthProvider } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import { getDatabase, ref, get, set, push, query, orderByChild, limitToLast, startAfter, onValue, onChildAdded } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import { firebaseConfig, vcmailConfig } from "./firebaseConfig.js";

// Get VCMail configuration from window object or use defaults
const config = window.VCMAIL_CONFIG || vcmailConfig || {
  domain: "example.com",
  webmailDomain: "mail.example.com",
  apiEndpoint: "https://api.example.com",
  storageCacheKey: "vcmail_email_cache",
  buildId: "unknown"
};

// Log build ID and Firebase config for debugging
console.log('📦 VCMail Build ID:', config.buildId || 'missing');
console.log('🔧 Firebase Config:', {
  projectId: firebaseConfig.projectId,
  authDomain: firebaseConfig.authDomain,
  apiKey: firebaseConfig.apiKey ? firebaseConfig.apiKey.substring(0, 10) + '...' : 'MISSING',
  databaseURL: firebaseConfig.databaseURL
});

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// State management
let currentUser = null;
let userEmail = null;
let userUid = null;
let username = null;
let viewingEmail = null;
let composing = false;
let replyingTo = null;
let emailListener = null; // For real-time updates
let lastEmailTimestamp = 0; // Track latest email timestamp
let isSignUpMode = false; // Track if we're in sign-up mode
let currentFolder = 'inbox'; // Track current folder (inbox or sent)
let totalInboxCount = 0; // Track total inbox count
let totalSentCount = 0; // Track total sent count

// Email cache management
class EmailCache {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.storageKey = config.storageCacheKey || 'vcmail_email_cache';
    
    // Initialize from localStorage or create new
    this.loadFromStorage();
  }

  // Load cache from localStorage
  loadFromStorage() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) {
        const data = JSON.parse(stored);
        this.inboxCache = new Map(data.inboxCache || []);
        this.sentCache = new Map(data.sentCache || []);
        this.inboxOrder = data.inboxOrder || [];
        this.sentOrder = data.sentOrder || [];
        this.lastInboxQuery = data.lastInboxQuery || null;
        this.lastSentQuery = data.lastSentQuery || null;
        this.inboxLastTimestamp = data.inboxLastTimestamp || null;
        this.sentLastTimestamp = data.sentLastTimestamp || null;
        this.inboxHasMore = data.inboxHasMore !== undefined ? data.inboxHasMore : true;
        this.sentHasMore = data.sentHasMore !== undefined ? data.sentHasMore : true;
        
        console.log(`📧 Loaded cache from localStorage: ${this.inboxCache.size} inbox, ${this.sentCache.size} sent emails`);
      } else {
        this.initializeEmptyCache();
      }
    } catch (error) {
      console.error('Error loading cache from localStorage:', error);
      this.initializeEmptyCache();
    }
  }

  // Initialize empty cache
  initializeEmptyCache() {
    this.inboxCache = new Map();
    this.sentCache = new Map();
    this.inboxOrder = [];
    this.sentOrder = [];
    this.lastInboxQuery = null;
    this.lastSentQuery = null;
    this.inboxLastTimestamp = null;
    this.sentLastTimestamp = null;
    this.inboxHasMore = true;
    this.sentHasMore = true;
  }

  // Save cache to localStorage
  saveToStorage() {
    try {
      const data = {
        inboxCache: Array.from(this.inboxCache.entries()),
        sentCache: Array.from(this.sentCache.entries()),
        inboxOrder: this.inboxOrder,
        sentOrder: this.sentOrder,
        lastInboxQuery: this.lastInboxQuery,
        lastSentQuery: this.lastSentQuery,
        inboxLastTimestamp: this.inboxLastTimestamp,
        sentLastTimestamp: this.sentLastTimestamp,
        inboxHasMore: this.inboxHasMore,
        sentHasMore: this.sentHasMore
      };
      localStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch (error) {
      console.error('Error saving cache to localStorage:', error);
    }
  }

  // Create lightweight email metadata (no content/attachments)
  createLightweightEmail(email) {
    if (!email) return email;
    return {
      id: email.id,
      subject: email.subject,
      from: email.from,
      to: email.to,
      timestamp: email.timestamp,
      read: email.read,
      hasAttachments: email.hasAttachments,
      attachmentCount: email.structure?.attachments?.length || email.attachmentCount || 0,
      messageId: email.messageId,
      contentType: email.contentType,
      contentS3Key: email.contentS3Key, // Keep S3 key reference
      structure: email.structure ? {
        type: email.structure.type,
        boundary: email.structure.boundary,
        preferredContent: email.structure.preferredContent ? {
          type: email.structure.preferredContent.type,
          partKey: email.structure.preferredContent.partKey
        } : null,
        attachments: email.structure.attachments ? email.structure.attachments.map(att => ({
          partKey: att.partKey,
          filename: att.filename,
          contentType: att.contentType,
          size: att.size,
          s3Key: att.s3Key,
          isInline: att.isInline
        })) : []
      } : null
    };
  }

  // Add emails to cache
  addEmails(folder, emails, isLoadMore = false) {
    const cache = folder === 'inbox' ? this.inboxCache : this.sentCache;
    const order = folder === 'inbox' ? this.inboxOrder : this.sentOrder;
    
    console.log(`📧 Adding ${emails.length} emails to ${folder} cache (isLoadMore: ${isLoadMore})`);
    console.log(`📧 Current ${folder} cache size: ${cache.size}, order length: ${order.length}`);
    
    let newEmails = 0;
    emails.forEach(email => {
      if (!cache.has(email.id)) {
        // For sent emails, always mark as read
        if (folder === 'sent') {
          email.read = true;
        }
        
        // Store lightweight metadata only (no content/attachments)
        const lightweightEmail = this.createLightweightEmail(email);
        cache.set(email.id, lightweightEmail);
        if (isLoadMore) {
          order.push(email.id); // Add to end for older emails
        } else {
          order.unshift(email.id); // Add to beginning for newer emails
        }
        newEmails++;
      } else {
        console.log(`📧 Email ${email.id} already in ${folder} cache, skipping`);
      }
    });

    // Maintain cache size (remove oldest if needed)
    this._maintainSize(folder);
    
    // Save to localStorage
    this.saveToStorage();
    
    console.log(`📧 After adding: ${folder} cache size: ${cache.size}, order length: ${order.length}, new emails: ${newEmails}`);
    
    return newEmails;
  }

  // Get emails for display (with pagination)
  getEmails(folder, page = 1, pageSize = 20) {
    const cache = folder === 'inbox' ? this.inboxCache : this.sentCache;
    const order = folder === 'inbox' ? this.inboxOrder : this.sentOrder;
    
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const emailIds = order.slice(startIndex, endIndex);
    
    return emailIds.map(id => cache.get(id)).filter(Boolean);
  }

  // Get all cached emails (for display)
  getAllCachedEmails(folder) {
    const cache = folder === 'inbox' ? this.inboxCache : this.sentCache;
    const order = folder === 'inbox' ? this.inboxOrder : this.sentOrder;
    
    const emails = order.map(id => cache.get(id)).filter(Boolean);
    console.log(`📧 getAllCachedEmails(${folder}): cache size=${cache.size}, order length=${order.length}, returned emails=${emails.length}`);
    
    return emails;
  }

  // Get all cached emails (for search)
  getAllEmails(folder) {
    const cache = folder === 'inbox' ? this.inboxCache : this.sentCache;
    return Array.from(cache.values());
  }

  // Add single email (for real-time updates)
  addEmail(folder, email) {
    const cache = folder === 'inbox' ? this.inboxCache : this.sentCache;
    const order = folder === 'inbox' ? this.inboxOrder : this.sentOrder;
    
    if (!cache.has(email.id)) {
      // For sent emails, always mark as read
      if (folder === 'sent') {
        email.read = true;
      }
      
      // Store lightweight metadata only (no content/attachments)
      const lightweightEmail = this.createLightweightEmail(email);
      cache.set(email.id, lightweightEmail);
      order.unshift(email.id); // Add to beginning for new emails
      this._maintainSize(folder);
      
      // Save to localStorage
      this.saveToStorage();
    }
  }

  // Update email with full content (for in-memory use, doesn't persist to localStorage)
  updateEmailWithContent(folder, emailId, fullEmail) {
    const cache = folder === 'inbox' ? this.inboxCache : this.sentCache;
    if (cache.has(emailId)) {
      // Merge full content with existing metadata
      const existing = cache.get(emailId);
      cache.set(emailId, {
        ...existing,
        content: fullEmail.content,
        structure: fullEmail.structure // Include full structure with attachment content
      });
      // Don't save to localStorage - this is temporary in-memory data
    }
  }

  // Remove email (for deletions)
  removeEmail(folder, emailId) {
    const cache = folder === 'inbox' ? this.inboxCache : this.sentCache;
    const order = folder === 'inbox' ? this.inboxOrder : this.sentOrder;
    
    cache.delete(emailId);
    const index = order.indexOf(emailId);
    if (index > -1) {
      order.splice(index, 1);
    }
    
    // Save to localStorage
    this.saveToStorage();
  }

  // Check if we have recent data
  isDataFresh(folder, maxAge = 5 * 60 * 1000) { // 5 minutes
    const lastQuery = folder === 'inbox' ? this.lastInboxQuery : this.lastSentQuery;
    return lastQuery && (Date.now() - lastQuery) < maxAge;
  }

  // Check if there are more emails to load
  hasMore(folder) {
    return folder === 'inbox' ? this.inboxHasMore : this.sentHasMore;
  }

  // Set has more flag
  setHasMore(folder, hasMore) {
    if (folder === 'inbox') {
      this.inboxHasMore = hasMore;
    } else {
      this.sentHasMore = hasMore;
    }
    
    // Save to localStorage
    this.saveToStorage();
  }

  // Get last timestamp for pagination
  getLastTimestamp(folder) {
    return folder === 'inbox' ? this.inboxLastTimestamp : this.sentLastTimestamp;
  }

  // Set last timestamp for pagination
  setLastTimestamp(folder, timestamp) {
    if (folder === 'inbox') {
      this.inboxLastTimestamp = timestamp;
    } else {
      this.sentLastTimestamp = timestamp;
    }
    
    // Save to localStorage
    this.saveToStorage();
  }

  // Mark data as fresh
  markDataFresh(folder) {
    if (folder === 'inbox') {
      this.lastInboxQuery = Date.now();
    } else {
      this.lastSentQuery = Date.now();
    }
    
    // Save to localStorage
    this.saveToStorage();
  }

  // Clear cache
  clear() {
    this.inboxCache.clear();
    this.sentCache.clear();
    this.inboxOrder = [];
    this.sentOrder = [];
    this.lastInboxQuery = null;
    this.lastSentQuery = null;
    this.inboxLastTimestamp = null;
    this.sentLastTimestamp = null;
    this.inboxHasMore = true;
    this.sentHasMore = true;
    
    // Clear localStorage
    localStorage.removeItem(this.storageKey);
  }

  // Get cache stats
  getStats() {
    return {
      inbox: {
        count: this.inboxCache.size,
        lastQuery: this.lastInboxQuery
      },
      sent: {
        count: this.sentCache.size,
        lastQuery: this.lastSentQuery
      }
    };
  }

  // Maintain cache size
  _maintainSize(folder) {
    const cache = folder === 'inbox' ? this.inboxCache : this.sentCache;
    const order = folder === 'inbox' ? this.inboxOrder : this.sentOrder;
    
    while (cache.size > this.maxSize) {
      const oldestId = order.pop(); // Remove oldest
      if (oldestId) {
        cache.delete(oldestId);
      }
    }
  }

  // Clear old cache data (older than 30 days)
  clearOldCache() {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    let clearedInbox = 0;
    let clearedSent = 0;
    
    // Clear old inbox emails
    for (const [id, email] of this.inboxCache) {
      if (email.timestamp < thirtyDaysAgo) {
        this.inboxCache.delete(id);
        const index = this.inboxOrder.indexOf(id);
        if (index > -1) {
          this.inboxOrder.splice(index, 1);
        }
        clearedInbox++;
      }
    }
    
    // Clear old sent emails
    for (const [id, email] of this.sentCache) {
      if (email.timestamp < thirtyDaysAgo) {
        this.sentCache.delete(id);
        const index = this.sentOrder.indexOf(id);
        if (index > -1) {
          this.sentOrder.splice(index, 1);
        }
        clearedSent++;
      }
    }
    
    if (clearedInbox > 0 || clearedSent > 0) {
      console.log(`📧 Cleared old cache: ${clearedInbox} inbox, ${clearedSent} sent emails`);
      this.saveToStorage();
    }
  }
}

// Initialize email cache
const emailCache = new EmailCache(1000); // Cache up to 1000 emails per folder

// Clear old cache data periodically
setInterval(() => {
  emailCache.clearOldCache();
}, 24 * 60 * 60 * 1000); // Once per day

// Debug function to log cache stats
function logCacheStats() {
  const stats = emailCache.getStats();
  const storageSize = localStorage.getItem(config.storageCacheKey || 'vcmail_email_cache')?.length || 0;
  console.log('📊 Cache Stats:', {
    inbox: {
      count: stats.inbox.count,
      lastQuery: stats.inbox.lastQuery ? new Date(stats.inbox.lastQuery).toLocaleTimeString() : 'Never'
    },
    sent: {
      count: stats.sent.count,
      lastQuery: stats.sent.lastQuery ? new Date(stats.sent.lastQuery).toLocaleTimeString() : 'Never'
    },
    realtime: {
      lastEmailTimestamp: lastEmailTimestamp,
      totalInboxCount: totalInboxCount,
      totalSentCount: totalSentCount
    },
    storage: {
      size: `${(storageSize / 1024).toFixed(1)}KB`
    }
  });
}

// Debug function to check Firebase sent folder
async function debugSentFolder() {
  if (!userUid) {
    console.log('❌ No user UID available');
    return;
  }
  
  try {
    console.log('🔍 Debugging sent folder...');
    console.log('👤 User UID:', userUid);
    console.log('👤 Username:', username);
    
    // Check Firebase sent folder
    const sentRef = ref(db, `sent/${userUid}`);
    const sentSnap = await get(sentRef);
    
    if (sentSnap.exists()) {
      console.log('📁 Sent folder exists in Firebase');
      const sentEmails = [];
      sentSnap.forEach(child => {
        sentEmails.push({ id: child.key, ...child.val() });
      });
      console.log('📧 Sent emails in Firebase:', sentEmails);
      console.log('📊 Total sent emails in Firebase:', sentEmails.length);
    } else {
      console.log('❌ Sent folder does not exist in Firebase');
    }
    
    // Check email counts
    const countsRef = ref(db, `users/${userUid}/emailCounts`);
    const countsSnap = await get(countsRef);
    if (countsSnap.exists()) {
      console.log('📊 Email counts in Firebase:', countsSnap.val());
    } else {
      console.log('❌ Email counts not found in Firebase');
    }
    
    // Check cache
    console.log('📊 Cache sent emails:', emailCache.getAllEmails('sent'));
    
  } catch (error) {
    console.error('❌ Error debugging sent folder:', error);
  }
}

// Log cache stats every 30 seconds for debugging
setInterval(logCacheStats, 30000);

// Mobile-friendly date formatting
function formatDateForMobile(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffInHours = (now - date) / (1000 * 60 * 60);
  
  // If less than 24 hours, show time
  if (diffInHours < 24) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  // If less than 7 days, show day name
  else if (diffInHours < 168) {
    return date.toLocaleDateString([], { weekday: 'short' });
  }
  // Otherwise show date
  else {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}

// Format file size for display
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// DOM elements
const appContainer = document.getElementById('app');
const signinSection = document.getElementById('signin-section');
const setupSection = document.getElementById('setup-section');
const inboxSection = document.getElementById('inbox-section');
const emailViewSection = document.getElementById('email-view-section');
const composeSection = document.getElementById('compose-section');
const settingsSection = document.getElementById('settings-section');

// Authentication form elements
const authForm = document.getElementById('auth-form');
const signinToggle = document.getElementById('signin-toggle');
const signupToggle = document.getElementById('signup-toggle');
const authEmail = document.getElementById('auth-email');
const authPassword = document.getElementById('auth-password');
const confirmPasswordGroup = document.getElementById('confirm-password-group');
const authConfirmPassword = document.getElementById('auth-confirm-password');
const authError = document.getElementById('auth-error');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const googleSigninBtn = document.getElementById('google-signin-btn');

// Form elements
const setupForm = document.getElementById('setup-form');
const usernameInput = document.getElementById('username-input');
const composeForm = document.getElementById('compose-form');
const toInput = document.getElementById('to-input');
const subjectInput = document.getElementById('subject-input');
const bodyInput = document.getElementById('body-input');

// Display elements
const inboxList = document.getElementById('inbox-list');
const loadMoreBtn = document.getElementById('load-more-btn');
const emailSubject = document.getElementById('email-subject');
const emailFrom = document.getElementById('email-from');
const emailTo = document.getElementById('email-to');
const emailDate = document.getElementById('email-date');
const emailAttachmentsHeader = document.getElementById('email-attachments-header');
const emailContent = document.getElementById('email-content');
const userEmailDisplay = document.getElementById('user-email-display');

// Button elements
const signinBtn = document.getElementById('signin-btn');
const logoutBtn = document.getElementById('logout-btn');
const composeBtn = document.getElementById('compose-btn');
const backToInboxBtn = document.getElementById('back-to-inbox-btn');
const backToInboxComposeBtn = document.getElementById('back-to-inbox-compose-btn');
const replyBtn = document.getElementById('reply-btn');
const deleteEmailBtn = document.getElementById('delete-email-btn');
const backFromEmailBtn = document.getElementById('back-from-email-btn');
const sendBtn = document.getElementById('send-btn');
const cancelBtn = document.getElementById('cancel-compose-btn');
const settingsBtn = document.getElementById('settings-btn');
const backToInboxSettingsBtn = document.getElementById('back-to-inbox-settings-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');
const refreshStorageBtn = document.getElementById('refresh-storage-btn');

// Folder and footer elements
const inboxTab = document.getElementById('inbox-tab');
const sentTab = document.getElementById('sent-tab');
const messageCount = document.getElementById('message-count');
const footer = document.getElementById('footer');

// Event listeners
// Authentication form event listeners
signinToggle.addEventListener('click', () => {
  isSignUpMode = false;
  signinToggle.classList.add('active');
  signupToggle.classList.remove('active');
  confirmPasswordGroup.style.display = 'none';
  authSubmitBtn.textContent = 'Sign In';
  authError.textContent = '';
});

signupToggle.addEventListener('click', () => {
  isSignUpMode = true;
  signupToggle.classList.add('active');
  signinToggle.classList.remove('active');
  confirmPasswordGroup.style.display = 'block';
  authSubmitBtn.textContent = 'Sign Up';
  authError.textContent = '';
});

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  await handleEmailPasswordAuth();
});

googleSigninBtn.addEventListener('click', () => {
  signInWithPopup(auth, new GoogleAuthProvider());
});

if (logoutBtn) {
  logoutBtn.addEventListener('click', () => signOut(auth));
}

// Email/Password authentication handler
async function handleEmailPasswordAuth() {
  const email = authEmail.value.trim();
  const password = authPassword.value;
  const confirmPassword = authConfirmPassword.value;
  
  // Clear previous errors
  authError.textContent = '';
  
  // Basic validation
  if (!email || !password) {
    authError.textContent = 'Please fill in all required fields.';
    return;
  }
  
  if (isSignUpMode && password !== confirmPassword) {
    authError.textContent = 'Passwords do not match.';
    return;
  }
  
  if (isSignUpMode && password.length < 6) {
    authError.textContent = 'Password must be at least 6 characters long.';
    return;
  }
  
  try {
    // Disable submit button during authentication
    authSubmitBtn.disabled = true;
    authSubmitBtn.textContent = isSignUpMode ? 'Creating Account...' : 'Signing In...';
    
    if (isSignUpMode) {
      // Create new user account
      await createUserWithEmailAndPassword(auth, email, password);
    } else {
      // Sign in existing user
      await signInWithEmailAndPassword(auth, email, password);
    }
    
    // Clear form
    authForm.reset();
    authError.textContent = '';
    
  } catch (error) {
    console.error('Authentication error:', error);
    
    // Show user-friendly error messages
    let errorMessage = 'Authentication failed. Please try again.';
    
    switch (error.code) {
      case 'auth/email-already-in-use':
        errorMessage = 'An account with this email already exists. Please sign in instead.';
        break;
      case 'auth/user-not-found':
        errorMessage = 'No account found with this email. Please sign up instead.';
        break;
      case 'auth/wrong-password':
        errorMessage = 'Incorrect password. Please try again.';
        break;
      case 'auth/weak-password':
        errorMessage = 'Password is too weak. Please choose a stronger password.';
        break;
      case 'auth/invalid-email':
        errorMessage = 'Please enter a valid email address.';
        break;
      case 'auth/too-many-requests':
        errorMessage = 'Too many failed attempts. Please try again later.';
        break;
    }
    
    authError.textContent = errorMessage;
  } finally {
    // Re-enable submit button
    authSubmitBtn.disabled = false;
    authSubmitBtn.textContent = isSignUpMode ? 'Sign Up' : 'Sign In';
  }
}

composeBtn.addEventListener('click', async () => {
  await showComposeView();
});

backToInboxBtn.addEventListener('click', () => {
  showInboxView();
});

backToInboxComposeBtn.addEventListener('click', () => {
  showInboxView();
});

replyBtn.addEventListener('click', async () => {
  replyingTo = viewingEmail;
  await showComposeView();
});

deleteEmailBtn.addEventListener('click', async () => {
  if (viewingEmail && confirm('Delete this email?')) {
    await deleteEmail(viewingEmail.id);
    showInboxView();
  }
});

sendBtn.addEventListener('click', async (e) => {
  e.preventDefault();
  await sendEmail();
});

cancelBtn.addEventListener('click', () => {
  showInboxView();
});

settingsBtn.addEventListener('click', () => {
  showSettingsView();
});

// Folder tab event listeners
inboxTab.addEventListener('click', () => {
  switchToFolder('inbox');
});

sentTab.addEventListener('click', () => {
  switchToFolder('sent');
});

setupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  await setupUsername();
});

// UI state management
function showSigninView() {
  hideAllSections();
  signinSection.classList.remove('hidden');
  appContainer.classList.remove('email-view-mode');
}

function showSetupView() {
  hideAllSections();
  setupSection.classList.remove('hidden');
  appContainer.classList.remove('email-view-mode');
}

function showInboxView() {
  hideAllSections();
  inboxSection.classList.remove('hidden');
  appContainer.classList.remove('email-view-mode');
  viewingEmail = null;
  composing = false;
  replyingTo = null;
  renderInboxList();
  
  // Show footer and update message count
  footer.style.display = 'block';
  updateMessageCount();
  
  // Add scroll listener for infinite scroll
  addScrollListener();
}

function extractAndDisplayEmailBody(email) {
  const rawContent = email.content;
  const contentType = email.headers?.content_type;
  
  // Check if content is HTML (either by content-type header or by detecting HTML tags)
  const isHtml = (contentType && contentType.includes('text/html')) ||                 
                 (typeof rawContent === 'string' && /<[a-z][\s\S]*>/i.test(rawContent));
  
  if (isHtml) {
    // Use DOMPurify to sanitize HTML and remove script tags
    // Custom hook to add target="_blank" to all links
    DOMPurify.addHook('uponSanitizeElement', (element, node) => {
      if (element.tagName === 'A' && element.hasAttribute('href')) {
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer'); // Security best practice
      }
    });

    // Return the sanitized HTML directly - DO NOT convert newlines to <br> tags
    const sanitizedHtml = DOMPurify.sanitize(rawContent, {
      ADD_ATTR: ['target'],
      FORBID_TAGS: ['script', 'object', 'embed', 'applet'],
      FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onchange', 'onsubmit', 'onreset', 'onselect', 'onkeydown', 'onkeypress', 'onkeyup', 'onmousedown', 'onmousemove', 'onmouseout', 'onmouseup', 'onabort', 'onerror', 'onload', 'onresize', 'onscroll', 'onunload'],
      ALLOW_DATA_ATTR: false,
      SANITIZE_DOM: true,
      KEEP_CONTENT: true    
    });
    
    // Remove the hook after use to avoid memory leaks
    DOMPurify.removeHook('uponSanitizeElement');
    
    return sanitizedHtml;
  }
  
  // For plain text content types, format as plain text and sanitize
  return formatPlainTextAsHtml(rawContent);
}

// Helper function to format plain text with proper HTML spacing
// IMPORTANT: This function should ONLY be used for plain text content, not HTML
function formatPlainTextAsHtml(text) {
  if (!text) return '';
  
  // Safety check: if this looks like HTML, don't process it
  // HTML content should be handled by extractAndDisplayEmailBody before reaching here
  if (typeof text === 'string' && /<[a-z][\s\S]*>/i.test(text)) {
    console.warn('formatPlainTextAsHtml received HTML content - this should not happen');
    // Escape HTML and return as plain text to prevent issues
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  
  // Split into paragraphs (double line breaks)
  const paragraphs = text.split(/\r?\n\s*\r?\n/);
  
  // Format each paragraph
  const formattedParagraphs = paragraphs.map(paragraph => {
    const trimmed = paragraph.trim();
    if (!trimmed) return '';
    
    // Convert single line breaks within paragraphs to <br>
    // But be more conservative - only convert if there are actual line breaks
    const lines = trimmed.split(/\r?\n/);
    if (lines.length === 1) {
      // Single line, no need for <br>
      return trimmed;
    } else {
      // Multiple lines, join with <br>
      // Escape any HTML characters in plain text to prevent injection
      return lines.map(line => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('<br>');
    }
  }).filter(p => p.length > 0);
  
  // Wrap paragraphs in <p> tags
  return formattedParagraphs.map(p => `<p>${p}</p>`).join('');
}

// Load full email content from S3 (including body and attachments)
async function loadEmailFromS3(emailId, folder = 'inbox') {
  if (!userUid || !emailId) {
    console.error(`❌ loadEmailFromS3: Missing userUid (${userUid}) or emailId (${emailId})`);
    return null;
  }
  
  try {
    console.log(`📧 loadEmailFromS3 called:`, {
      emailId: emailId,
      folder: folder,
      userUid: userUid,
      apiEndpoint: config.apiEndpoint || '(empty)'
    });
    
    // Get Firebase ID token for authentication
    const idToken = await currentUser.getIdToken();
    console.log(`✅ Got Firebase ID token (length: ${idToken.length})`);
    
    // Call loadEmail API to get presigned S3 URLs
    const apiEndpoint = config.apiEndpoint || '';
    const apiPath = `${apiEndpoint}/api/loadEmail?emailId=${encodeURIComponent(emailId)}&folder=${folder === 'inbox' ? 'emails' : 'sent'}`;
    console.log(`📡 Calling API: ${apiPath}`);
    
    const apiResponse = await fetch(apiPath, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${idToken}`
      }
    });
    
    console.log(`📡 API response status: ${apiResponse.status} ${apiResponse.statusText}`);
    
    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      console.error(`❌ Failed to load email from API:`, {
        status: apiResponse.status,
        statusText: apiResponse.statusText,
        body: errorText
      });
      throw new Error(`Failed to load email: ${apiResponse.status} - ${errorText}`);
    }
    
    const apiData = await apiResponse.json();
    console.log(`✅ Loaded email metadata from API:`, {
      emailId: apiData.emailId,
      hasContentUrl: !!apiData.contentUrl,
      hasContent: !!apiData.content,
      contentType: apiData.contentType,
      attachmentsCount: apiData.attachments?.length || 0,
      metadata: {
        subject: apiData.metadata?.subject,
        hasAttachments: apiData.metadata?.hasAttachments,
        structureAttachments: apiData.metadata?.structure?.attachments?.length || 0
      }
    });
    
    // Fetch email content from S3 or use direct content (backward compatibility)
    let emailContent = null;
    
    if (apiData.content) {
      // Old format: content is directly in the API response
      emailContent = apiData.content;
      console.log(`✅ Email content from API response (${emailContent.length} characters)`);
    } else if (apiData.contentUrl) {
      // New format: fetch from S3
      console.log(`📦 Fetching email content from S3 URL: ${apiData.contentUrl.substring(0, 100)}...`);
      const contentResponse = await fetch(apiData.contentUrl, {
        method: 'GET',
        mode: 'cors',
        cache: 'no-cache'
      });
      
      console.log(`📦 S3 response status: ${contentResponse.status} ${contentResponse.statusText}`);
      
      if (!contentResponse.ok) {
        const errorText = await contentResponse.text();
        console.error(`❌ Failed to fetch from S3:`, {
          status: contentResponse.status,
          statusText: contentResponse.statusText,
          body: errorText.substring(0, 200)
        });
        throw new Error(`Failed to fetch email content from S3: ${contentResponse.status}`);
      }
      
      emailContent = await contentResponse.text();
      console.log(`✅ Email content fetched from S3 (${emailContent.length} characters)`);
    } else {
      console.error(`❌ No content URL or content available in API response`);
      throw new Error('No content URL or content available');
    }
    
    // Fetch attachments from S3 if any
    const attachments = [];
    if (apiData.attachments && apiData.attachments.length > 0) {
      console.log(`📎 Fetching ${apiData.attachments.length} attachments from S3...`);
      for (let i = 0; i < apiData.attachments.length; i++) {
        const attachment = apiData.attachments[i];
        console.log(`📎 Attachment ${i + 1}/${apiData.attachments.length}:`, {
          filename: attachment.filename,
          contentType: attachment.contentType,
          size: attachment.size,
          hasUrl: !!attachment.url,
          hasContent: !!attachment.content,
          isInline: attachment.isInline
        });
        
        try {
          if (attachment.content) {
            // Attachment content already included (old format - embedded content)
            console.log(`✅ Attachment ${i + 1} has content embedded`);
            attachments.push(attachment);
          } else if (attachment.url) {
            // Use presigned S3 URL directly for all attachments (no fetch/conversion needed)
            // This is more reliable and avoids CORS/memory issues
            console.log(`📦 Using presigned URL for attachment ${i + 1} (size: ${attachment.size || 'unknown'}, URL: ${attachment.url.substring(0, 100)}...)`);
            attachments.push(attachment);
          } else {
            console.warn(`⚠️ Attachment ${i + 1} has no URL or content`);
          }
        } catch (attError) {
          console.error(`❌ Error fetching attachment ${i + 1}:`, attError);
        }
      }
      console.log(`✅ Successfully fetched ${attachments.length}/${apiData.attachments.length} attachments`);
    } else {
      console.log(`📎 No attachments to fetch (apiData.attachments: ${apiData.attachments?.length || 0})`);
    }
    
    // Combine metadata from API with content from S3
    const fullEmail = {
      id: emailId,
      ...apiData.metadata,
      content: emailContent
    };
    
    // Add attachments to email object (both top-level and structure for compatibility)
    if (attachments.length > 0) {
      fullEmail.attachments = attachments;
      if (fullEmail.structure) {
        fullEmail.structure.attachments = attachments;
      } else {
        // Create structure if it doesn't exist
        fullEmail.structure = { attachments: attachments };
      }
    }
    
    // Update cache with full content (in-memory only)
    // Use the folder parameter that was passed in
    emailCache.updateEmailWithContent(folder, emailId, fullEmail);
    
    console.log(`📧 Full email content loaded from S3: ${emailId}`);
    return fullEmail;
    
  } catch (error) {
    console.error(`📧 Error fetching email content from S3:`, error);
    return null;
  }
}

async function showEmailView(email) {
  console.log('📧 showEmailView called with email:', {
    id: email.id,
    subject: email.subject,
    from: email.from,
    hasContent: !!email.content,
    hasContentS3Key: !!email.contentS3Key,
    contentS3Key: email.contentS3Key,
    hasAttachments: email.hasAttachments,
    attachmentCount: email.attachmentCount,
    hasStructure: !!email.structure,
    structureAttachments: email.structure?.attachments?.length || 0,
    attachmentsS3: email.attachmentsS3?.length || 0,
    contentType: email.contentType,
    messageId: email.messageId
  });
  
  hideAllSections();
  emailViewSection.classList.remove('hidden');
  appContainer.classList.add('email-view-mode');
  viewingEmail = email;
  
  // Hide footer when viewing individual email
  footer.style.display = 'none';
  
  // Remove scroll listener when viewing email
  removeScrollListener();
  
  // Populate email details
  emailSubject.textContent = email.subject || '(No subject)';
  emailFrom.textContent = email.from;
  emailTo.textContent = email.to;
  emailDate.textContent = new Date(email.timestamp).toLocaleString();
  
  // Clear attachments header
  if (emailAttachmentsHeader) {
    emailAttachmentsHeader.innerHTML = '';
  }
  
  // Show loading state
  emailContent.innerHTML = '<div class="loading">Loading email content...</div>';
  
  // Check if email has contentS3Key (needs to be loaded from S3)
  // Also check if email has no content at all (might be old email or needs loading)
  // Old emails might have messageId pointing to SES S3 location but no contentS3Key
  let fullEmail = email;
  
  const hasContentS3Key = !!email.contentS3Key;
  const hasContent = !!email.content && email.content.length > 0;
  const hasMessageId = !!email.messageId;
  
  // Need to load if:
  // 1. Has contentS3Key but no content, OR
  // 2. No content at all (might be old email that needs loading from SES location)
  const needsLoading = (hasContentS3Key && !hasContent) || (!hasContent && hasMessageId);
  
  console.log(`📧 Email loading check:`, {
    needsLoading: needsLoading,
    hasContentS3Key: hasContentS3Key,
    hasContent: hasContent,
    hasMessageId: hasMessageId,
    messageId: email.messageId,
    hasAttachments: email.hasAttachments,
    contentS3Key: email.contentS3Key
  });
  
  if (needsLoading) {
    console.log(`📧 Email needs content loaded, calling loadEmailFromS3...`);
    const folder = currentFolder === 'inbox' ? 'inbox' : 'sent';
    const loadedEmail = await loadEmailFromS3(email.id, folder);
    
    console.log(`📧 loadEmailFromS3 returned:`, {
      success: !!loadedEmail,
      hasContent: !!loadedEmail?.content,
      contentLength: loadedEmail?.content?.length || 0,
      hasAttachments: loadedEmail?.structure?.attachments?.length || 0
    });
    
    if (loadedEmail && loadedEmail.content) {
      fullEmail = loadedEmail;
      console.log(`✅ Using loaded email with content length: ${fullEmail.content?.length || 0}`);
    } else if (!email.content) {
      // Failed to load from S3 and no content available
      console.error(`❌ Failed to load email content and no fallback content available`);
      emailContent.innerHTML = '<div class="error">Failed to load email content. The email may need to be reprocessed. Please contact support.</div>';
      return;
    } else {
      console.log(`⚠️ Failed to load from S3, but using existing content (backward compatibility)`);
    }
  } else {
    console.log(`📧 Email already has content, using directly (length: ${email.content?.length || 0})`);
  }
  
  console.log(`📧 Final email data for display:`, {
    hasContent: !!fullEmail.content,
    contentLength: fullEmail.content?.length || 0,
    hasAttachments: fullEmail.hasAttachments,
    structureAttachments: fullEmail.structure?.attachments?.length || 0,
    contentType: fullEmail.contentType
  });
  
  // Build email content with attachments
  let contentHtml = '';
  
  console.log(`📧 Building email HTML:`, {
    hasAttachments: fullEmail.hasAttachments,
    structureAttachments: fullEmail.structure?.attachments?.length || 0,
    hasContent: !!fullEmail.content,
    contentLength: fullEmail.content?.length || 0
  });
  
  // Display attachments in header section (not in content)
  // Check both top-level attachments (from API) and structure.attachments (old format)
  const attachmentsToShow = fullEmail.attachments || fullEmail.structure?.attachments || [];
  console.log(`📎 Attachments to display: ${attachmentsToShow.length}`);
  console.log(`📎 Attachment sources:`, {
    hasTopLevelAttachments: !!fullEmail.attachments,
    topLevelCount: fullEmail.attachments?.length || 0,
    hasStructureAttachments: !!fullEmail.structure?.attachments,
    structureCount: fullEmail.structure?.attachments?.length || 0
  });
  
  if (attachmentsToShow.length > 0) {
    let attachmentsHtml = '<div class="email-attachments">';
    attachmentsHtml += '<div class="email-attachments-label">Attachments:</div>';
    attachmentsHtml += '<div class="email-attachments-list">';
    
    attachmentsToShow.forEach((attachment, index) => {
      const filename = attachment.filename || `attachment-${index + 1}`;
      const size = attachment.size ? ` (${formatFileSize(attachment.size)})` : '';
      const escapedFilename = filename.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      
      if (attachment.url) {
        // Use S3 presigned URL directly (preferred)
        attachmentsHtml += `<div class="attachment-item"><a href="${attachment.url}" download="${escapedFilename}" class="attachment-link" target="_blank">📎 ${filename}${size}</a></div>`;
      } else if (attachment.content) {
        // For attachments with embedded content, create a download link with data URL
        const mimeType = attachment.contentType || 'application/octet-stream';
        
        // Handle UTF-8 encoding properly for btoa
        let base64Content;
        try {
          if (attachment.encoding === 'base64') {
            // Already base64 encoded
            base64Content = attachment.content;
          } else {
            // Convert string to UTF-8 bytes, then to base64
            const utf8Bytes = new TextEncoder().encode(attachment.content);
            base64Content = btoa(String.fromCharCode(...utf8Bytes));
          }
          
          const dataUrl = `data:${mimeType};base64,${base64Content}`;
          attachmentsHtml += `<div class="attachment-item"><a href="${dataUrl}" download="${escapedFilename}" class="attachment-link">📎 ${filename}${size}</a></div>`;
        } catch (e) {
          console.warn('Failed to encode attachment as base64:', e);
          // Fallback: show as text content instead of download link
          attachmentsHtml += `<div class="attachment-item"><span class="attachment-text">📎 ${filename}${size} (text content available)</span></div>`;
        }
      } else {
        // For binary attachments or missing content, show filename only
        attachmentsHtml += `<div class="attachment-item"><span class="attachment-missing">📎 ${filename}${size} (content not available)</span></div>`;
      }
    });
    
    attachmentsHtml += '</div></div>';
    
    // Add to header section
    if (emailAttachmentsHeader) {
      emailAttachmentsHeader.innerHTML = attachmentsHtml;
    }
  } else {
    // Clear attachments header if no attachments
    if (emailAttachmentsHeader) {
      emailAttachmentsHeader.innerHTML = '';
    }
  }
  
  // Add the main email content
  contentHtml += '<div class="email-body">';
  const bodyContent = extractAndDisplayEmailBody(fullEmail);
  console.log(`📧 Email body content:`, {
    hasContent: !!bodyContent,
    contentLength: bodyContent?.length || 0,
    contentType: fullEmail.contentType,
    preview: bodyContent?.substring(0, 200) || '(empty)'
  });
  
  if (!bodyContent || bodyContent.trim().length === 0) {
    console.warn(`⚠️ Email body content is empty!`);
    contentHtml += '<div class="warning">Email content is empty or could not be loaded.</div>';
  } else {
    contentHtml += bodyContent;
  }
  contentHtml += '</div>';
  
  console.log(`📧 Final HTML to render:`, {
    totalLength: contentHtml.length,
    hasAttachments: contentHtml.includes('attachments-section'),
    hasBody: contentHtml.includes('email-body'),
    attachmentCount: (contentHtml.match(/attachment-link/g) || []).length
  });
  
  emailContent.innerHTML = contentHtml;
  
  console.log(`✅ Email view rendered successfully`);
}

async function showComposeView() {
  hideAllSections();
  composeSection.classList.remove('hidden');
  appContainer.classList.remove('email-view-mode');
  composing = true;
  
  // Hide footer when composing
  footer.style.display = 'none';
  
  // Remove scroll listener when composing
  removeScrollListener();
  
  // Pre-fill form if replying
  if (replyingTo) {
    toInput.value = replyingTo.from;
    subjectInput.value = replyingTo.subject.startsWith('Re:') ? replyingTo.subject : 'Re: ' + replyingTo.subject;
    // Load email content if needed for reply
    let replyContent = replyingTo.content;
    if (replyingTo.contentS3Key && !replyingTo.content) {
      const folder = currentFolder === 'inbox' ? 'inbox' : 'sent';
      const loadedEmail = await loadEmailFromS3(replyingTo.id, folder);
      if (loadedEmail && loadedEmail.content) {
        replyContent = loadedEmail.content;
      }
    }
    bodyInput.value = `\n\n--- Original message ---\n${replyContent}`;
  } else {
    toInput.value = '';
    subjectInput.value = '';
    bodyInput.value = '';
  }
}

function hideAllSections() {
  signinSection.classList.add('hidden');
  setupSection.classList.add('hidden');
  inboxSection.classList.add('hidden');
  emailViewSection.classList.add('hidden');
  composeSection.classList.add('hidden');
  settingsSection.classList.add('hidden');
}

function showSettingsView() {
  hideAllSections();
  settingsSection.classList.remove('hidden');
  appContainer.classList.remove('email-view-mode');
  
  // Hide footer when viewing settings
  footer.style.display = 'none';
  
  // Remove scroll listener when viewing settings
  removeScrollListener();
  
  // Update settings information
  updateSettingsInfo();
}

function updateSettingsInfo() {
  // Update storage information
  const quotaInfo = document.getElementById('quota-info');
  const usageInfo = document.getElementById('usage-info');
  const availableInfo = document.getElementById('available-info');
  const localstorageInfo = document.getElementById('localstorage-info');
  const cacheInfo = document.getElementById('cache-info');
  
  // Storage quota information (simplified)
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(estimate => {
      if (quotaInfo) quotaInfo.textContent = `${(estimate.quota / 1024 / 1024).toFixed(1)}MB`;
      if (usageInfo) usageInfo.textContent = `${(estimate.usage / 1024 / 1024).toFixed(1)}MB`;
      if (availableInfo && estimate.quota) {
        const available = estimate.quota - estimate.usage;
        availableInfo.textContent = `${(available / 1024 / 1024).toFixed(1)}MB`;
      }
    }).catch(() => {
      if (quotaInfo) quotaInfo.textContent = 'Not available';
      if (usageInfo) usageInfo.textContent = 'Not available';
      if (availableInfo) availableInfo.textContent = 'Not available';
    });
  } else {
    if (quotaInfo) quotaInfo.textContent = 'Not available';
    if (usageInfo) usageInfo.textContent = 'Not available';
    if (availableInfo) availableInfo.textContent = 'Not available';
  }
  
  // localStorage usage
  let localStorageSize = 0;
  try {
    for (let key in localStorage) {
      if (localStorage.hasOwnProperty(key)) {
        localStorageSize += localStorage[key].length + key.length;
      }
    }
    if (localstorageInfo) localstorageInfo.textContent = `${(localStorageSize / 1024).toFixed(1)}KB`;
  } catch (e) {
    if (localstorageInfo) localstorageInfo.textContent = 'Not available';
  }
  
  // Email cache information
  const stats = emailCache.getStats();
  const totalCached = stats.inbox.count + stats.sent.count;
  if (cacheInfo) cacheInfo.textContent = `${totalCached} emails (${stats.inbox.count} inbox, ${stats.sent.count} sent)`;
  
  // Update account information
  const accountEmail = document.getElementById('account-email');
  const accountUid = document.getElementById('account-uid');
  
  if (accountEmail) {
    accountEmail.textContent = userEmailDisplay?.textContent || userEmail || 'Not available';
  }
  if (accountUid) {
    accountUid.textContent = userUid || 'Not available';
  }
}

// Event listeners for settings
if (backToInboxSettingsBtn) {
  backToInboxSettingsBtn.addEventListener('click', () => {
    showInboxView();
  });
}

if (clearCacheBtn) {
  clearCacheBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear the email cache? This will remove all locally stored emails.')) {
      console.log('🧹 Clearing email cache...');
      emailCache.clear();
      
      // Also clear the counts to force reload
      totalInboxCount = 0;
      totalSentCount = 0;
      
      updateSettingsInfo();
      
      // Force reload emails from Firebase
      console.log('🔄 Reloading emails after cache clear...');
      if (currentFolder === 'inbox') {
        await loadInbox(false);
      } else {
        await loadSentEmails(false);
      }
      
      console.log('✅ Cache cleared and emails reloaded');
      alert('Email cache cleared and reloaded successfully!');
    }
  });
}

if (refreshStorageBtn) {
  refreshStorageBtn.addEventListener('click', () => {
    updateSettingsInfo();
  });
}

// Folder management
function switchToFolder(folder) {
  currentFolder = folder;
  
  // Update tab states
  inboxTab.classList.toggle('active', folder === 'inbox');
  sentTab.classList.toggle('active', folder === 'sent');
  
  // Load appropriate emails
  if (folder === 'inbox') {
    loadInbox();
  } else {
    loadSentEmails();
  }
  
  // Update message count
  updateMessageCount();
}

// Track total counts for accurate message counting
// (Variables declared at top of file to avoid temporal dead zone issues)

function updateMessageCount() {
  const count = currentFolder === 'inbox' ? totalInboxCount : totalSentCount;
  const folderName = currentFolder === 'inbox' ? 'inbox' : 'sent';
  messageCount.textContent = `${count} ${folderName} message${count !== 1 ? 's' : ''}`;
}

// Email management
async function setupUsername() {
  const uname = usernameInput.value.trim().toLowerCase();
  if (!uname.match(/^[a-zA-Z0-9._-]{3,32}$/)) {
    alert('Invalid username. Use 3-32 letters, numbers, dots, underscores or hyphens.');
    return;
  }
  
  if (!currentUser) {
    alert('You must be signed in to set up a username.');
    return;
  }
  
  try {
    const idToken = await currentUser.getIdToken();
    // Use relative URL - CloudFront will route /api/* to API Gateway
    const apiEndpoint = config.apiEndpoint || '';
    const response = await fetch(`${apiEndpoint}/api/setupEmail`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({ username: uname })
    });
    
    if (!response.ok) {
      let errorMessage = 'Failed to set up username. Please try again.';
      try {
        const data = await response.json();
        if (data?.error) {
          errorMessage = data.error;
        }
      } catch {
        // ignore JSON parse errors
      }
      throw new Error(errorMessage);
    }
    
    const result = await response.json();
    const emailDomain = config.domain || 'example.com';
    username = result.username || uname;
    userUid = currentUser.uid;
    userEmailDisplay.textContent = result.email || `${username}@${emailDomain}`;
    loadInbox();
    showInboxView();
    
    // Initialize footer
    footer.style.display = 'block';
    updateMessageCount();
  } catch (error) {
    console.error('Error setting up username:', error);
    alert(error.message || 'Failed to set up username. Please try again.');
  }
}

async function sendEmail() {
  const to = toInput.value.trim();
  const subject = subjectInput.value.trim();
  const body = bodyInput.value.trim();
  
  // Extract email address from display name format (e.g., "Seth Caldwell <seth@snapchallenge.com>")
  let emailAddress = to;
  const emailMatch = to.match(/<(.+?)>/);
  if (emailMatch) {
    emailAddress = emailMatch[1];
  }
  
  // Basic email validation
  if (!emailAddress.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
    alert('Please enter a valid email address.');
    return;
  }
  
  try {
    // Get Firebase ID token for authentication
    const idToken = await currentUser.getIdToken();
    
    // Send email via Lambda API
    // Use relative URL - CloudFront will route /api/* to API Gateway
    const apiEndpoint = config.apiEndpoint || '';
    const response = await fetch(`${apiEndpoint}/api/sendEmail`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({
        to: emailAddress,
        subject: subject,
        body: body
      })
    });
    
    if (!response.ok) {
      // Check if response is JSON before trying to parse it
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to send email');
      } else {
        // Handle non-JSON responses (like HTML error pages)
        const errorText = await response.text();
        console.error('Non-JSON response:', errorText);
        throw new Error(`Server error (${response.status}): The email service is currently unavailable. Please try again later.`);
      }
    }
    
    const result = await response.json();
    console.log('Email sent successfully:', result);
    
    // Save to sent folder
    const sentEmail = {
      to: emailAddress,
      subject: subject,
      content: body,
      timestamp: Date.now(),
      from: `${username}@${config.domain || 'example.com'}`,
      messageId: result.MessageId || `local_${Date.now()}`,
      isReply: !!replyingTo,
      replyTo: replyingTo ? replyingTo.id : null
    };
    
    try {
      console.log('📝 Attempting to save email to sent folder:', {
        path: `sent/${userUid}`,
        email: sentEmail,
        userUid: userUid,
        username: username
      });
      
      const sentRef = await push(ref(db, `sent/${userUid}`), sentEmail);
      console.log('✅ Email saved to sent folder with ID:', sentRef.key);
      console.log('📁 Full Firebase path:', `sent/${userUid}/${sentRef.key}`);
      
      // Add to cache with the generated ID (sent emails are always read)
      const sentEmailWithId = { ...sentEmail, id: sentRef.key, read: true };
      emailCache.addEmail('sent', sentEmailWithId);
      console.log('✅ Email added to sent cache');
      
      // Update sent email count
      await updateEmailCount('sent', 1);
      totalSentCount++;
      console.log('✅ Sent email count updated to:', totalSentCount);
      
      // Verify the email was actually saved by reading it back
      const verifyRef = ref(db, `sent/${userUid}/${sentRef.key}`);
      const verifySnap = await get(verifyRef);
      if (verifySnap.exists()) {
        console.log('✅ Email verified in Firebase:', verifySnap.val());
      } else {
        console.error('❌ Email not found in Firebase after saving!');
      }
      
    } catch (error) {
      console.error('❌ Error saving to sent folder:', error);
      console.error('Error details:', {
        message: error.message,
        code: error.code,
        stack: error.stack
      });
    }
    
    // Clear form and handle navigation
    composing = false;
    replyingTo = null;
    
    // If we were replying, stay in sent folder to show the sent email
    if (currentFolder === 'sent') {
      // Refresh sent emails to show the new one
      await loadSentEmails();
      renderInboxList();
    } else {
      // Return to inbox if composing new email
      showInboxView();
    }
    
  } catch (error) {
    console.error('Error sending email:', error);
    alert('Failed to send email: ' + error.message);
  }
}

function renderInboxList() {
  inboxList.innerHTML = '';
  
  // Get all cached emails for current folder
  const currentEmails = emailCache.getAllCachedEmails(currentFolder);
  
  console.log(`📧 Rendering ${currentEmails.length} emails for ${currentFolder} folder`);
  
  currentEmails.forEach(email => {
    const li = document.createElement('li');
    li.className = 'email-item';
    // Highlight if unread (only for inbox emails, sent emails are always considered read)
    const isUnread = currentFolder === 'inbox' && email.read !== true;
    if (isUnread) {
      li.classList.add('new-email');
    }
    li.innerHTML = `
      <div class="email-info">
        <div class="email-subject">${email.subject || '(No subject)'}</div>
        <div class="email-sender">${email.from}</div>
      </div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <div class="email-date">${formatDateForMobile(email.timestamp)}</div>
        <button class="delete-btn" title="Delete" data-id="${email.id}">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M6 8V15M10 8V15M14 8V15M3 5H17M8 5V3H12V5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    `;
    // Delete button event
    li.querySelector('.delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('Delete this email?')) {
        await deleteEmail(email.id);
      }
    });
    // Open email event
    li.addEventListener('click', async (e) => {
      if (e.target.closest('.delete-btn')) return; // Don't open if delete was clicked
      // Mark as read in Firebase if not already (only for inbox emails)
      if (currentFolder === 'inbox' && !email.read) {
        try {
          await set(ref(db, `emails/${userUid}/${email.id}/read`), true);
          email.read = true; // Update local state for immediate UI feedback
          li.classList.remove('new-email');
        } catch (e) {
          console.error('Failed to mark email as read:', e);
        }
      }
      showEmailView(email);
    });
    inboxList.appendChild(li);
  });
  // Show/hide load more button based on cache state
  if (emailCache.hasMore(currentFolder)) {
    loadMoreBtn.classList.remove('hidden');
  } else {
    loadMoreBtn.classList.add('hidden');
  }
}

async function loadInbox(loadMore = false) {
  if (!userUid) return;
  
  try {
    // Check if we have fresh cached data (unless explicitly loading more)
    if (!loadMore && emailCache.isDataFresh('inbox')) {
      console.log('📧 Using cached inbox data');
      renderInboxList();
      return;
    }

    // Get total count first (only on initial load)
    if (!loadMore) {
      const countSnap = await get(ref(db, `users/${userUid}/emailCounts/inbox`));
      totalInboxCount = countSnap.exists() ? countSnap.val() : 0;
      console.log(`📧 Total inbox count from server: ${totalInboxCount}`);
    }
    
    // Determine query parameters
    let q;
    if (loadMore && emailCache.getLastTimestamp('inbox')) {
      // Load more emails (older than the last one we have)
      q = query(
        ref(db, `emails/${userUid}`), 
        orderByChild('timestamp'), 
        startAfter(emailCache.getLastTimestamp('inbox')), 
        limitToLast(20)
      );
      console.log(`📧 Loading more emails after timestamp: ${emailCache.getLastTimestamp('inbox')}`);
    } else if (!loadMore && emailCache.getLastTimestamp('inbox')) {
      // Load only newer emails than what we have cached
      q = query(
        ref(db, `emails/${userUid}`), 
        orderByChild('timestamp'), 
        startAfter(emailCache.getLastTimestamp('inbox')), 
        limitToLast(50)
      );
      console.log(`📧 Loading newer emails after cached timestamp: ${emailCache.getLastTimestamp('inbox')}`);
    } else {
      // Initial load or refresh
      q = query(ref(db, `emails/${userUid}`), orderByChild('timestamp'), limitToLast(20));
      console.log('📧 Initial load of inbox emails');
    }
    
    const snap = await get(q);
    const list = [];
    snap.forEach(child => list.push({ id: child.key, ...child.val() }));
    list.reverse(); // Most recent first
    
    console.log(`📧 Raw query returned ${list.length} emails`);
    
    // Add to cache
    const newEmails = emailCache.addEmails('inbox', list, loadMore);
    emailCache.markDataFresh('inbox');
    
    // Update pagination state
    if (list.length > 0) {
      emailCache.setLastTimestamp('inbox', list[list.length - 1].timestamp);
      emailCache.setHasMore('inbox', list.length === 20);
    } else {
      emailCache.setHasMore('inbox', false);
    }
    
    // Update last email timestamp for real-time updates
    if (list.length > 0) {
      const maxTimestamp = Math.max(...list.map(e => e.timestamp));
      lastEmailTimestamp = Math.max(lastEmailTimestamp, maxTimestamp);
      console.log(`📧 Updated lastEmailTimestamp to: ${lastEmailTimestamp}`);
    }
    
    if (!composing && !viewingEmail) {
      renderInboxList();
    }
    
    // Set up real-time listener after initial load is complete
    if (!emailListener && !loadMore) {
      // Small delay to ensure initial load is complete
      setTimeout(() => {
        setupRealtimeListener();
        console.log('📧 Initial load complete, real-time notifications enabled');
      }, 100);
    }
    
    // Update message count
    updateMessageCount();
    
    console.log(`📧 Loaded ${newEmails} new inbox emails, cache now has ${emailCache.getStats().inbox.count} emails`);
  } catch (error) {
    console.error('Error loading inbox:', error);
  }
}

async function loadSentEmails(loadMore = false) {
  if (!userUid) return;
  
  try {
    // Check if we have fresh cached data (unless explicitly loading more)
    if (!loadMore && emailCache.isDataFresh('sent')) {
      console.log('📤 Using cached sent data');
      renderInboxList();
      return;
    }

    // Get total count first (only on initial load)
    if (!loadMore) {
      const countSnap = await get(ref(db, `users/${userUid}/emailCounts/sent`));
      totalSentCount = countSnap.exists() ? countSnap.val() : 0;
    }
    
    // Determine query parameters
    let q;
    if (loadMore && emailCache.getLastTimestamp('sent')) {
      // Load more emails (older than the last one we have)
      q = query(
        ref(db, `sent/${userUid}`), 
        orderByChild('timestamp'), 
        startAfter(emailCache.getLastTimestamp('sent')), 
        limitToLast(20)
      );
    } else if (!loadMore && emailCache.getLastTimestamp('sent')) {
      // Load only newer emails than what we have cached
      q = query(
        ref(db, `sent/${userUid}`), 
        orderByChild('timestamp'), 
        startAfter(emailCache.getLastTimestamp('sent')), 
        limitToLast(50)
      );
      console.log(`📤 Loading newer sent emails after cached timestamp: ${emailCache.getLastTimestamp('sent')}`);
    } else {
      // Initial load or refresh
      q = query(ref(db, `sent/${userUid}`), orderByChild('timestamp'), limitToLast(20));
    }
    
    const snap = await get(q);
    const list = [];
    snap.forEach(child => list.push({ id: child.key, ...child.val() }));
    list.reverse(); // Most recent first
    
    // Add to cache
    const newEmails = emailCache.addEmails('sent', list, loadMore);
    emailCache.markDataFresh('sent');
    
    // Update pagination state
    if (list.length > 0) {
      emailCache.setLastTimestamp('sent', list[list.length - 1].timestamp);
      emailCache.setHasMore('sent', list.length === 20);
    } else {
      emailCache.setHasMore('sent', false);
    }
    
    if (!composing && !viewingEmail) {
      renderInboxList();
    }
    
    // Update message count
    updateMessageCount();
    
    console.log(`📤 Loaded ${newEmails} new sent emails, cache now has ${emailCache.getStats().sent.count} emails`);
  } catch (error) {
    console.error('Error loading sent emails:', error);
  }
}

function setupRealtimeListener() {
  if (!userUid || emailListener) return;
  
  // Use cached timestamp if available, otherwise use the global lastEmailTimestamp
  const cachedTimestamp = emailCache.getLastTimestamp('inbox');
  const listenerTimestamp = cachedTimestamp || lastEmailTimestamp;
  
  console.log(`Setting up real-time email listener (timestamp: ${listenerTimestamp})`);
  
  // Only listen for emails newer than our last known timestamp
  // This prevents onChildAdded from firing for existing emails
  const emailsRef = ref(db, `emails/${userUid}`);
  const realtimeQuery = query(
    emailsRef, 
    orderByChild('timestamp'), 
    startAfter(listenerTimestamp)
  );
  
  emailListener = onChildAdded(realtimeQuery, async (snapshot) => {
    const email = { id: snapshot.key, ...snapshot.val() };
    
    console.log(`📧 New email received: ${email.subject}`);
    
    // Add new email to cache
    emailCache.addEmail('inbox', email);
    
    // Update last email timestamp
    lastEmailTimestamp = Math.max(lastEmailTimestamp, email.timestamp);
    
    // Show visual indicator for new email
    showNewEmailIndicator(1);
    
    // Update the inbox if we're viewing it
    if (!composing && !viewingEmail) {
      renderInboxList();
      updateMessageCount();
    }
  });
}

function showNewEmailIndicator(count) {
  // Create or update notification
  let notification = document.getElementById('new-email-notification');
  if (!notification) {
    notification = document.createElement('div');
    notification.id = 'new-email-notification';
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #28a745;
      color: white;
      padding: 12px 20px;
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 1000;
      font-weight: 600;
      animation: slideIn 0.3s ease-out;
    `;
    
    // Add CSS animation
    const style = document.createElement('style');
    style.textContent = `
      @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
      }
      .email-item.new-email {
        background-color: #e8f5e8 !important;
        border-left: 4px solid #28a745;
        animation: highlightNew 2s ease-out;
      }
      @keyframes highlightNew {
        0% { background-color: #d4edda; }
        100% { background-color: #e8f5e8; }
      }
    `;
    document.head.appendChild(style);
    
    document.body.appendChild(notification);
  }
  
  notification.textContent = `📧 ${count} new email${count > 1 ? 's' : ''} received!`;
  
  // Auto-hide after 3 seconds
  setTimeout(() => {
    if (notification.parentNode) {
      notification.style.animation = 'slideOut 0.3s ease-out';
      setTimeout(() => {
        if (notification.parentNode) {
          notification.parentNode.removeChild(notification);
        }
      }, 300);
    }
  }, 3000);
}

// Load more button event listener
loadMoreBtn.addEventListener('click', async () => {
  if (currentFolder === 'inbox') {
    await loadInbox(true);
  } else {
    await loadSentEmails(true);
  }
});

// Infinite scroll functionality
let isLoadingMore = false;

function handleScroll() {
  if (isLoadingMore || !emailCache.hasMore(currentFolder)) return;
  
  const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
  const windowHeight = window.innerHeight;
  const documentHeight = document.documentElement.scrollHeight;
  
  // Load more when user is near the bottom (within 100px)
  if (scrollTop + windowHeight >= documentHeight - 100) {
    loadMoreEmails();
  }
}

async function loadMoreEmails() {
  if (isLoadingMore) return;
  
  isLoadingMore = true;
  loadMoreBtn.textContent = 'Loading...';
  
  try {
    if (currentFolder === 'inbox') {
      await loadInbox(true);
    } else {
      await loadSentEmails(true);
    }
  } finally {
    isLoadingMore = false;
    loadMoreBtn.textContent = 'Load More';
  }
}

// Add scroll listener when showing inbox view
function addScrollListener() {
  window.addEventListener('scroll', handleScroll);
}

function removeScrollListener() {
  window.removeEventListener('scroll', handleScroll);
}

// Auth state management
onAuthStateChanged(auth, async (user) => {
  console.log('Auth state changed:', user ? `User logged in (UID: ${user.uid})` : 'User logged out');
  currentUser = user;
  
  if (!user) {
    console.log('No user, showing signin view');
    userUid = null;
    username = null;
    
    // Clear cache and clean up listeners
    emailCache.clear();
    removeScrollListener();
    if (emailListener) {
      emailListener();
      emailListener = null;
    }
    lastEmailTimestamp = 0;
    
    showSigninView();
    return;
  }
  
  console.log('User authenticated, checking profile...');
  console.log('User UID:', user.uid);
  console.log('User email:', user.email);
  
  try {
    // Try to find username - use a more defensive approach
    // First check if we can access the users path
    const profileRef = ref(db, `users/${user.uid}/profile`);
    console.log('Attempting to read profile from:', `users/${user.uid}/profile`);
    
    const profileSnap = await get(profileRef);
    console.log('Profile snapshot exists:', profileSnap.exists());
    console.log('Profile snapshot:', profileSnap.exists() ? profileSnap.val() : 'No profile found');
    
    if (profileSnap.exists() && profileSnap.val().username) {
      username = profileSnap.val().username;
      userUid = user.uid;
      userEmailDisplay.textContent = profileSnap.val().email;
      console.log('Found existing profile, loading inbox...');
      loadInbox();
      showInboxView();
      
      // Initialize footer
      footer.style.display = 'block';
      updateMessageCount();
    } else {
      console.log('No profile found, user needs to set up username');
      showSetupView();
    }
  } catch (error) {
    console.error('Error checking user setup:', error);
    console.log('Error details:', error.message, error.code);
    console.log('Error stack:', error.stack);
    
    // Permission denied usually means:
    // 1. Firebase rules aren't deployed (most common)
    // 2. User doesn't have permission to read their own profile (rules issue)
    // In either case, show setup view as fallback
    if (error.code === 'PERMISSION_DENIED' || error.code === 'permission-denied' || error.message.includes('Permission denied')) {
      console.warn('⚠️ Permission denied when checking profile. This usually means:');
      console.warn('   1. Firebase database rules are not deployed');
      console.warn('   2. Run: npm run deploy-rules');
      console.warn('   3. Or check Firebase Console > Realtime Database > Rules');
      console.log('Showing setup view as fallback...');
      showSetupView();
    } else {
      // For other errors, still show setup view as safe fallback
      console.log('Unexpected error, showing setup view');
      showSetupView();
    }
  }
}); 

// Helper function to update email count
async function updateEmailCount(type, delta) {
  if (!userUid) return;
  try {
    const countRef = ref(db, `users/${userUid}/emailCounts/${type}`);
    const currentSnap = await get(countRef);
    const currentCount = currentSnap.exists() ? currentSnap.val() : 0;
    const newCount = Math.max(0, currentCount + delta);
    await set(countRef, newCount);
    console.log(`✅ Updated ${type} email count: ${currentCount} → ${newCount}`);
  } catch (error) {
    console.error(`Failed to update ${type} email count:`, error);
  }
}

// Add deleteEmail function
async function deleteEmail(emailId) {
  if (!userUid || !emailId) return;
  try {
    // Delete from Firebase
    if (currentFolder === 'inbox') {
      await set(ref(db, `emails/${userUid}/${emailId}`), null);
      await updateEmailCount('inbox', -1);
      totalInboxCount = Math.max(0, totalInboxCount - 1);
    } else {
      await set(ref(db, `sent/${userUid}/${emailId}`), null);
      await updateEmailCount('sent', -1);
      totalSentCount = Math.max(0, totalSentCount - 1);
    }
    
    // Remove from cache
    emailCache.removeEmail(currentFolder, emailId);
    
    renderInboxList();
    updateMessageCount();
  } catch (error) {
    console.error('Failed to delete email:', error);
    alert('Failed to delete email.');
  }
} 