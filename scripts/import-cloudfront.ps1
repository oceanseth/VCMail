# Import existing CloudFront distribution by detecting CNAME match
# PowerShell version

$TERRAFORM_DIR = "lib\terraform"

# Read config to get mail domain
$configPath = "vcmail.config.json"
if (-not (Test-Path $configPath)) {
    Write-Host "Error: vcmail.config.json not found. Please run setup first." -ForegroundColor Red
    exit 1
}

$config = Get-Content $configPath | ConvertFrom-Json
$mailDomain = $config.webmailDomain
if (-not $mailDomain) {
    $mailDomain = $config.mailDomain
}
if (-not $mailDomain) {
    $mailDomain = "mail.$($config.domain)"
}

Write-Host "Detecting CloudFront distribution for CNAME: $mailDomain" -ForegroundColor Cyan

# List all distributions and find one with matching CNAME
$distributionsJson = aws cloudfront list-distributions --query "DistributionList.Items[*].{Id:Id,Aliases:Aliases.Items}" --output json
$distributions = $distributionsJson | ConvertFrom-Json

$matchingDistribution = $null
foreach ($dist in $distributions) {
    if ($dist.Aliases -and $dist.Aliases -contains $mailDomain) {
        $matchingDistribution = $dist
        break
    }
}

if (-not $matchingDistribution) {
    Write-Host "No CloudFront distribution found with CNAME: $mailDomain" -ForegroundColor Yellow
    Write-Host "This is normal if you haven't created one yet." -ForegroundColor Yellow
    exit 0
}

Write-Host "Found CloudFront distribution: $($matchingDistribution.Id)" -ForegroundColor Green
Write-Host "Importing into Terraform state..." -ForegroundColor Cyan

Set-Location $TERRAFORM_DIR

terraform import -var-file=terraform.tfvars aws_cloudfront_distribution.webmail $matchingDistribution.Id

Write-Host ""
Write-Host "✅ Import complete!" -ForegroundColor Green
Write-Host "Now run: terraform plan -out=tfplan; terraform apply tfplan" -ForegroundColor Cyan

