#!/bin/bash
# Import existing CloudFront distribution by detecting CNAME match

TERRAFORM_DIR="lib/terraform"

# Read config to get mail domain
CONFIG_PATH="vcmail.config.json"
if [ ! -f "$CONFIG_PATH" ]; then
    echo "Error: vcmail.config.json not found. Please run setup first."
    exit 1
fi

# Extract mail domain from config (requires jq or node)
if command -v jq &> /dev/null; then
    MAIL_DOMAIN=$(jq -r '.webmailDomain // .mailDomain // "mail.\(.domain)"' "$CONFIG_PATH")
elif command -v node &> /dev/null; then
    MAIL_DOMAIN=$(node -e "const c=require('./$CONFIG_PATH'); console.log(c.webmailDomain || c.mailDomain || 'mail.'+c.domain)")
else
    echo "Error: jq or node required to read config file"
    exit 1
fi

echo "Detecting CloudFront distribution for CNAME: $MAIL_DOMAIN"

# List all distributions and find one with matching CNAME
DISTRIBUTIONS_JSON=$(aws cloudfront list-distributions --query "DistributionList.Items[*].{Id:Id,Aliases:Aliases.Items}" --output json)

if command -v jq &> /dev/null; then
    DISTRIBUTION_ID=$(echo "$DISTRIBUTIONS_JSON" | jq -r ".[] | select(.Aliases[]? == \"$MAIL_DOMAIN\") | .Id" | head -n 1)
elif command -v node &> /dev/null; then
    DISTRIBUTION_ID=$(node -e "const dists=$DISTRIBUTIONS_JSON; const found=dists.find(d=>d.Aliases&&d.Aliases.includes('$MAIL_DOMAIN')); console.log(found?found.Id:'')")
else
    echo "Error: jq or node required to parse CloudFront distributions"
    exit 1
fi

if [ -z "$DISTRIBUTION_ID" ]; then
    echo "No CloudFront distribution found with CNAME: $MAIL_DOMAIN"
    echo "This is normal if you haven't created one yet."
    exit 0
fi

echo "Found CloudFront distribution: $DISTRIBUTION_ID"
echo "Importing into Terraform state..."
cd "$TERRAFORM_DIR" || exit 1

terraform import -var-file=terraform.tfvars aws_cloudfront_distribution.webmail "$DISTRIBUTION_ID"

echo ""
echo "✅ Import complete!"
echo "Now run: terraform plan -out=tfplan && terraform apply tfplan"

