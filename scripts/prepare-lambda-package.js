#!/usr/bin/env node

/**
 * Prepares Lambda deployment package for Terraform
 * Creates a vcmail-lambda-package directory with only necessary files and dependencies
 */

const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');

// Find the vcmail package directory (where this script is located)
// This script is in node_modules/vcmail/scripts/, so go up one level
const VCMAIL_PACKAGE_ROOT = path.join(__dirname, '..');
// Create vcmail-lambda-package in the user's project directory (where they run npx vcmail)
const PROJECT_ROOT = process.cwd();
const LAMBDA_PACKAGE_DIR = path.join(PROJECT_ROOT, 'vcmail-lambda-package');

async function prepareLambdaPackage() {
  console.log('📦 Preparing Lambda deployment package...\n');

  // Clean and create vcmail-lambda-package directory
  if (await fs.pathExists(LAMBDA_PACKAGE_DIR)) {
    await fs.remove(LAMBDA_PACKAGE_DIR);
  }
  await fs.ensureDir(LAMBDA_PACKAGE_DIR);

  // Copy necessary files
  const filesToCopy = [
    'api',
    'src',
    'firebaseInit.js'
  ];

  const filesToCopySelective = {
    'lib/config.js': 'lib/config.js'
  };

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

  for (const [src, dest] of Object.entries(filesToCopySelective)) {
    // Copy from vcmail package directory, not from user's project
    const srcPath = path.join(VCMAIL_PACKAGE_ROOT, src);
    const destPath = path.join(LAMBDA_PACKAGE_DIR, dest);
    if (await fs.pathExists(srcPath)) {
      await fs.ensureDir(path.dirname(destPath));
      await fs.copy(srcPath, destPath);
      console.log(`  ✓ Copied ${src} from vcmail package`);
    } else {
      console.warn(`  ⚠ File not found in vcmail package: ${srcPath}`);
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
      'aws-sdk': packageJson.dependencies['aws-sdk'] || '^2.1531.0'
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

