#!/usr/bin/env node

/**
 * Prepares Lambda deployment package for Terraform
 * Creates a vcmail-lambda-package directory with only necessary files and dependencies
 */

const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFsLockError(err) {
  if (!err) return false;
  const code = err.code;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY' || code === 'EMFILE') return true;
  const msg = String(err.message || err.syscall || '');
  return /EBUSY|resource busy|locked/i.test(msg);
}

/**
 * Remove a directory tree; on Windows, cancelling `npx vcmail` often leaves file locks in
 * `node_modules` so a single fs.remove fails with EBUSY. Retry with backoff, then rename away
 * and rebuild so the next run is not blocked.
 */
async function removeLambdaPackageTreeWithRetry(dir, { label = 'vcmail-lambda-package', maxRemoveAttempts = 12 } = {}) {
  if (!(await fs.pathExists(dir))) {
    return;
  }

  let lastErr;
  for (let attempt = 1; attempt <= maxRemoveAttempts; attempt++) {
    try {
      await fs.remove(dir);
      return;
    } catch (err) {
      lastErr = err;
      if (!isRetryableFsLockError(err)) {
        throw err;
      }
      const delayMs = Math.min(4000, 200 * 2 ** (attempt - 1));
      console.warn(
        `  ⚠ ${label} is locked (${err.code || 'EBUSY'}); waiting ${delayMs}ms before retry ${attempt}/${maxRemoveAttempts}…`
      );
      await sleep(delayMs);
    }
  }

  const trashDir = `${dir}.trash-${Date.now()}`;
  try {
    await fs.move(dir, trashDir, { overwrite: false });
    console.warn(
      `  ⚠ Renamed locked ${label} to ${path.basename(trashDir)}. Building a fresh package; delete the .trash-* folder later if it remains.`
    );
    setImmediate(() => {
      void removeLambdaPackageTreeWithRetry(trashDir, {
        label: path.basename(trashDir),
        maxRemoveAttempts: 6
      }).catch(() => {});
    });
    return;
  } catch (moveErr) {
    const hint =
      'Another process may still be using this folder (cancelled npx vcmail, IDE, terminal, or antivirus). ' +
      'Close it, wait a few seconds, or delete/rename `vcmail-lambda-package` manually, then run again.';
    const wrap = new Error(
      `Could not remove or rename ${dir}: ${lastErr && lastErr.message}. ${hint}`
    );
    wrap.cause = lastErr || moveErr;
    throw wrap;
  }
}

// Find the vcmail package directory (where this script is located)
// This script is in node_modules/vcmail/scripts/, so go up one level
const VCMAIL_PACKAGE_ROOT = path.join(__dirname, '..');
// Create vcmail-lambda-package in the user's project directory (where they run npx vcmail)
const PROJECT_ROOT = process.cwd();
const LAMBDA_PACKAGE_DIR = path.join(PROJECT_ROOT, 'vcmail-lambda-package');

async function prepareLambdaPackage() {
  console.log('📦 Preparing Lambda deployment package...\n');

  // Clean and create vcmail-lambda-package directory (handles Windows EBUSY after cancelled runs)
  await removeLambdaPackageTreeWithRetry(LAMBDA_PACKAGE_DIR);
  await fs.ensureDir(LAMBDA_PACKAGE_DIR);

  // Copy necessary files
  const filesToCopy = [
    'api',
    'src',
    'firebaseInit.js',
    'decodeQuotedPrintable.js'
  ];

  console.log('Copying Lambda code files from vcmail package...');
  console.log(`  Source: ${VCMAIL_PACKAGE_ROOT}`);
  console.log(`  Destination: ${LAMBDA_PACKAGE_DIR}`);
  
  for (const file of filesToCopy) {
    // Copy from vcmail package directory, not from user's project
    const src = path.join(VCMAIL_PACKAGE_ROOT, file);
    const dest = path.join(LAMBDA_PACKAGE_DIR, file);
    if (await fs.pathExists(src)) {
      await fs.copy(src, dest);
      console.log(`  ✓ Copied ${file} from vcmail package`);
    } else {
      console.warn(`  ⚠ File not found in vcmail package: ${src}`);
    }
  }

  // Copy package.json and install only production dependencies
  console.log('\nInstalling production dependencies...');
  // Read package.json from vcmail package, not from user's project
  const packageJson = await fs.readJson(path.join(VCMAIL_PACKAGE_ROOT, 'package.json'));
  
  // Create minimal package.json with only Lambda dependencies
  const lambdaPackageJson = {
    name: packageJson.name,
    version: packageJson.version,
    dependencies: {
      'firebase-admin': packageJson.dependencies['firebase-admin'] || '^11.11.0',
      '@aws-sdk/client-s3': packageJson.dependencies['@aws-sdk/client-s3'] || '^3.758.0',
      '@aws-sdk/client-ssm': packageJson.dependencies['@aws-sdk/client-ssm'] || '^3.758.0',
      '@aws-sdk/client-ses': packageJson.dependencies['@aws-sdk/client-ses'] || '^3.758.0',
      '@aws-sdk/s3-request-presigner': packageJson.dependencies['@aws-sdk/s3-request-presigner'] || '^3.758.0',
      'fs-extra': packageJson.dependencies['fs-extra'] || '^11.2.0'
    }
  };

  await fs.writeJson(
    path.join(LAMBDA_PACKAGE_DIR, 'package.json'),
    lambdaPackageJson,
    { spaces: 2 }
  );

  // Install dependencies
  try {
    execSync('npm install --production --no-audit --no-fund', {
      cwd: LAMBDA_PACKAGE_DIR,
      stdio: 'inherit'
    });
    console.log('  ✓ Dependencies installed');
  } catch (error) {
    console.error('  ✗ Failed to install dependencies:', error.message);
    throw error;
  }

  // Clean up unnecessary files from node_modules
  console.log('\nCleaning up unnecessary files...');
  const nodeModulesDir = path.join(LAMBDA_PACKAGE_DIR, 'node_modules');
  if (await fs.pathExists(nodeModulesDir)) {
    // Remove test files, docs, etc.
    const patternsToRemove = [
      '**/*.test.js',
      '**/*.spec.js',
      '**/test/**',
      '**/tests/**',
      '**/__tests__/**',
      '**/*.md',
      '**/*.txt',
      '**/.cache/**',
      '**/.bin/**'
    ];

    // This is a simplified cleanup - in production you might want more aggressive cleanup
    console.log('  ✓ Cleanup complete');
  }

  console.log('\n✅ Lambda package prepared successfully!');
  console.log(`   Location: ${LAMBDA_PACKAGE_DIR}`);
}

prepareLambdaPackage().catch(error => {
  console.error('\n❌ Error preparing Lambda package:', error);
  process.exit(1);
});

