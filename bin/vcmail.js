#!/usr/bin/env node

/**
 * VCMail CLI Entry Point
 * Main command-line interface for setting up VCMail email infrastructure
 */

const path = require('path');
const fs = require('fs-extra');
const { setup, deployHtmlToS3 } = require('../lib/setup');

// Check if running directly or as npm script
const args = process.argv.slice(2);

// Parse command line arguments
const skipPrompts = args.includes('-s') || args.includes('--skip-prompts');
const deployS3Only = args.includes('-s3') || args.includes('--s3');

// Check for subcommands
const command = args[0];

async function main() {
  try {
    // Handle -s3 flag: deploy only HTML files to S3
    if (deployS3Only) {
      console.log('🚀 VCMail - Deploy HTML to S3\n');
      
      // Check AWS CLI prerequisite only
      const execaModule = await import('execa');
      const execa = execaModule.default || execaModule;
      const chalk = (await import('chalk')).default;
      
      try {
        await execa('aws', ['--version'], { stdio: 'pipe', env: process.env });
        console.log(chalk.green('✓ AWS CLI is installed'));
      } catch (error) {
        console.error(chalk.red('✗ AWS CLI is not installed or not in PATH'));
        throw new Error('AWS CLI is required for S3 deployment');
      }
      
      // Deploy HTML files
      await deployHtmlToS3();
      return;
    }
    
    // Handle subcommands
    if (command === 'cleanup-old-resources') {
      const oldProjectName = args[1];
      if (!oldProjectName) {
        console.error('Error: Please provide the old project name');
        console.error('Usage: npx vcmail cleanup-old-resources <old-project-name>');
        process.exit(1);
      }
      
      // Run cleanup script - modify process.argv so script gets the project name
      const originalArgv = process.argv.slice();
      process.argv = [process.argv[0], __filename, oldProjectName];
      require('../scripts/cleanup-old-resources.js');
      process.argv = originalArgv; // Restore
      return;
    }
    
    // Default: Run setup wizard
    console.log('🚀 VCMail - Email Infrastructure Setup\n');
    
    // Check prerequisites
    await checkPrerequisites();
    
    // Run setup wizard
    await setup(args, { skipPrompts });
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.stack && process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

async function checkPrerequisites() {
  const execaModule = await import('execa');
  const execa = execaModule.default || execaModule;
  const chalk = (await import('chalk')).default;
  
  const checks = [
    { name: 'AWS CLI', command: 'aws', args: ['--version'] },
    { name: 'Terraform', command: 'terraform', args: ['version'] },
    { name: 'Node.js', command: 'node', args: ['--version'] }
  ];
  
  for (const check of checks) {
    try {
      await execa(check.command, check.args, {
        stdio: 'pipe', // Suppress output, just check if it works
        env: process.env // Ensure PATH is inherited
      });
      console.log(chalk.green(`✓ ${check.name} is installed`));
    } catch (error) {
      // Check if command might be available with different path
      if (error.code === 'ENOENT') {
        console.error(chalk.red(`✗ ${check.name} is not installed or not in PATH`));
        if (process.env.DEBUG) {
          console.error(chalk.yellow(`  PATH: ${process.env.PATH}`));
          console.error(chalk.yellow(`  Error: ${error.message}`));
        }
        throw new Error(`Missing prerequisite: ${check.name}`);
      } else {
        // Command exists but might have failed - that's okay for version checks
        console.log(chalk.green(`✓ ${check.name} is installed`));
      }
    }
  }
  
  // Check AWS credentials - try with simpler command first
  try {
    const { stdout, stderr } = await execa('aws', ['sts', 'get-caller-identity', '--output', 'json'], {
      stdio: 'pipe',
      env: process.env
    });
    
    // Parse the output (could be JSON or string)
    let identity;
    try {
      identity = JSON.parse(stdout);
    } catch (parseError) {
      // If parsing fails, stdout might already be a string or formatted differently
      // Try to extract account ID from output
      const accountMatch = stdout.match(/Account["\s:]+"?(\d{12})"?/);
      if (accountMatch) {
        identity = { Account: accountMatch[1] };
      } else {
        throw new Error('Could not parse AWS identity output');
      }
    }
    
    if (identity && identity.Account) {
      console.log(chalk.green(`✓ AWS credentials configured (Account: ${identity.Account})`));
    } else {
      throw new Error('Invalid AWS identity response');
    }
  } catch (error) {
    // More detailed error handling
    if (error.code === 'ENOENT') {
      // AWS CLI not found (shouldn't happen since we already checked)
      console.error(chalk.red('✗ AWS CLI not found'));
      throw new Error('AWS CLI is required but not found in PATH');
    } else if (error.message && error.message.includes('Unable to locate credentials')) {
      console.error(chalk.red('✗ AWS credentials not configured'));
      throw new Error('Please configure AWS credentials using "aws configure" or environment variables');
    } else if (error.message && error.message.includes('InvalidClientTokenId')) {
      console.error(chalk.red('✗ AWS credentials are invalid'));
      throw new Error('AWS credentials are configured but invalid. Please run "aws configure" to update them.');
    } else {
      // For other errors, log them but don't fail - credentials might still work
      console.log(chalk.yellow(`⚠ Could not verify AWS credentials: ${error.message}`));
      console.log(chalk.yellow('⚠ Continuing anyway - credentials will be tested during deployment'));
      if (process.env.DEBUG) {
        console.error(chalk.yellow(`  Error details: ${error.message}`));
      }
    }
  }
  
  console.log(''); // Empty line
}

main();

