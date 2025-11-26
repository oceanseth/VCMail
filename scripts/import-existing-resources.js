#!/usr/bin/env node
/**
 * Import existing AWS resources into Terraform state
 * This script helps fix "resource already exists" errors
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Get config
const configPath = path.join(process.cwd(), 'vcmail.config.json');
if (!fs.existsSync(configPath)) {
  console.error('Error: vcmail.config.json not found. Please run setup first.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// Determine Terraform directory
// Check if .vcmail-terraform exists (setup script location)
// Otherwise use lib/terraform (manual terraform location)
const terraformDirs = [
  path.join(process.cwd(), '.vcmail-terraform'),
  path.join(process.cwd(), 'lib', 'terraform')
];

let terraformDir = null;
for (const dir of terraformDirs) {
  if (fs.existsSync(dir) && fs.existsSync(path.join(dir, 'main.tf'))) {
    terraformDir = dir;
    break;
  }
}

if (!terraformDir) {
  console.error('Error: Could not find Terraform directory.');
  console.error('Please run from the project root or ensure Terraform is initialized.');
  process.exit(1);
}

console.log(`Using Terraform directory: ${terraformDir}`);

// Resources to import
const resourcesToImport = [
  {
    resource: 'aws_s3_bucket.webmail',
    name: config.s3WebmailBucket || `mail.${config.domain}`,
    description: 'Webmail S3 bucket'
  },
  {
    resource: 'aws_s3_bucket.mail_inbox',
    name: config.s3BucketName || `${config.domain}-mail-inbox`,
    description: 'Mail inbox S3 bucket'
  }
];

console.log('\n📦 Importing existing resources into Terraform state...\n');

// Import CloudFront distribution if it exists
try {
  console.log('Checking for existing CloudFront distribution...');
  const mailDomain = config.webmailDomain || config.mailDomain || `mail.${config.domain}`;
  
  const cloudfrontList = execSync(
    `aws cloudfront list-distributions --query "DistributionList.Items[*].{Id:Id,Aliases:Aliases.Items}" --output json`,
    { encoding: 'utf-8', cwd: terraformDir }
  );
  
  const distributions = JSON.parse(cloudfrontList);
  const matchingDistribution = distributions.find(dist => 
    dist.Aliases && dist.Aliases.includes(mailDomain)
  );
  
  if (matchingDistribution) {
    console.log(`  Found CloudFront distribution for ${mailDomain}: ${matchingDistribution.Id}`);
    try {
      // Use terraform.tfvars if it exists
      const tfvarsPath = path.join(terraformDir, 'terraform.tfvars');
      const importCmd = fs.existsSync(tfvarsPath)
        ? `terraform import -var-file=terraform.tfvars aws_cloudfront_distribution.webmail ${matchingDistribution.Id}`
        : `terraform import aws_cloudfront_distribution.webmail ${matchingDistribution.Id}`;
      
      execSync(importCmd, {
        stdio: 'inherit',
        cwd: terraformDir
      });
      console.log(`  ✓ Successfully imported CloudFront distribution\n`);
    } catch (importError) {
      if (importError.message && importError.message.includes('already managed')) {
        console.log(`  ✓ CloudFront distribution already in Terraform state\n`);
      } else {
        console.log(`  ✗ Failed to import CloudFront distribution: ${importError.message.split('\n')[0]}\n`);
      }
    }
  } else {
    console.log(`  No CloudFront distribution found for ${mailDomain}\n`);
  }
} catch (error) {
  console.log(`  ✗ Error checking CloudFront distributions: ${error.message.split('\n')[0]}\n`);
}

for (const resource of resourcesToImport) {
  try {
    // Check if resource exists in AWS
    console.log(`Checking if ${resource.description} exists...`);
    
    if (resource.resource.includes('s3_bucket')) {
      // Check S3 bucket
      try {
        execSync(`aws s3api head-bucket --bucket ${resource.name}`, {
          stdio: 'pipe',
          cwd: terraformDir
        });
      } catch (error) {
        console.log(`  ⚠️  ${resource.description} does not exist in AWS, skipping...`);
        continue;
      }
    }
    
    // Try to import
    console.log(`  Importing ${resource.description} (${resource.name})...`);
    try {
      execSync(`terraform import ${resource.resource} ${resource.name}`, {
        stdio: 'inherit',
        cwd: terraformDir
      });
      console.log(`  ✓ Successfully imported ${resource.description}\n`);
    } catch (importError) {
      if (importError.message && importError.message.includes('already managed')) {
        console.log(`  ✓ ${resource.description} already in Terraform state\n`);
      } else {
        console.log(`  ✗ Failed to import ${resource.description}: ${importError.message.split('\n')[0]}\n`);
      }
    }
  } catch (error) {
    console.log(`  ✗ Error checking ${resource.description}: ${error.message.split('\n')[0]}\n`);
  }
}

console.log('✅ Import process complete!');
console.log('\nYou can now run: terraform plan -out=tfplan && terraform apply tfplan');

