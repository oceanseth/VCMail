// Firebase configuration
// This file is auto-generated during deployment from vcmail.config.json
// Do not edit manually - run 'npx vcmail' to regenerate

// Default config - will be replaced by setup process
export const firebaseConfig = window.VCMAIL_CONFIG?.firebase || {
  apiKey: "your-api-key",
  authDomain: "your-project.firebaseapp.com",
  databaseURL: "https://your-project.firebaseio.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "your-app-id"
};

// VCMail application config
export const vcmailConfig = window.VCMAIL_CONFIG || {
  domain: "example.com",
  webmailDomain: "mail.example.com",
  apiEndpoint: "https://api.example.com",
  storageCacheKey: "vcmail_email_cache",
  buildId: "local-dev"
};

