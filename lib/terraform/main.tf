# VCMail Infrastructure - Main Configuration
# This file sets up the complete AWS infrastructure for VCMail

terraform {
  required_version = ">= 1.0"
  
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
  
  # Optional: Uncomment to use S3 backend for state management
  # backend "s3" {
  #   bucket = "your-terraform-state-bucket"
  #   key    = "vcmail/terraform.tfstate"
  #   region = "us-east-1"
  # }
}

# Provider configuration is in provider.tf
# Data source to get Route53 hosted zone for the domain
data "aws_route53_zone" "main" {
  name         = var.domain
  private_zone = false
}

# Data source for current AWS account
data "aws_caller_identity" "current" {}

# S3 Bucket for email inbox (where SES stores incoming emails)
resource "aws_s3_bucket" "mail_inbox" {
  bucket = var.s3_bucket_name
  
  # Allow bucket deletion even when it contains objects/versions
  # This is necessary for Terraform to manage bucket lifecycle
  force_destroy = true
  
  tags = {
    Name        = "VCMail Email Inbox"
    Project     = var.project_name
    ManagedBy   = "Terraform"
  }
}

resource "aws_s3_bucket_versioning" "mail_inbox" {
  bucket = aws_s3_bucket.mail_inbox.id
  
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "mail_inbox" {
  bucket = aws_s3_bucket.mail_inbox.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# S3 Bucket Policy to allow SES to write emails
resource "aws_s3_bucket_policy" "mail_inbox" {
  bucket = aws_s3_bucket.mail_inbox.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowSESToWrite"
        Effect = "Allow"
        Principal = {
          Service = "ses.amazonaws.com"
        }
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.mail_inbox.arn}/*"
        Condition = {
          StringEquals = {
            "aws:Referer" = data.aws_caller_identity.current.account_id
          }
        }
      }
    ]
  })
}

# S3 Bucket for webmail client
resource "aws_s3_bucket" "webmail" {
  bucket = var.s3_webmail_bucket_name
  
  tags = {
    Name        = "VCMail Webmail Client"
    Project     = var.project_name
    ManagedBy   = "Terraform"
  }
}

# Enable public access block (security best practice)
resource "aws_s3_bucket_public_access_block" "webmail" {
  bucket = aws_s3_bucket.webmail.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Origin Access Control for CloudFront (modern, secure approach)
resource "aws_cloudfront_origin_access_control" "webmail" {
  name                              = "${var.project_name}-webmail-oac"
  description                       = "Origin Access Control for VCMail webmail S3 bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# S3 Bucket Policy - allows CloudFront OAC to access objects
resource "aws_s3_bucket_policy" "webmail" {
  bucket = aws_s3_bucket.webmail.id
  depends_on = [
    aws_s3_bucket_public_access_block.webmail,
    aws_cloudfront_distribution.webmail
  ]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontServicePrincipal"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.webmail.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.webmail.arn
          }
        }
      }
    ]
  })
}

# CloudFront distribution for webmail client
# Note: This depends on API Gateway stage being created
resource "aws_cloudfront_distribution" "webmail" {
  depends_on = [aws_api_gateway_stage.main]
  # S3 origin for static webmail files
  origin {
    domain_name              = aws_s3_bucket.webmail.bucket_regional_domain_name
    origin_id                = "S3-${aws_s3_bucket.webmail.bucket}"
    origin_access_control_id = aws_cloudfront_origin_access_control.webmail.id
  }

  # API Gateway origin for /api/* requests
  # Note: origin_path prepends the stage name to all requests
  # So /api/something becomes /prod/api/something when forwarded to API Gateway
  origin {
    domain_name = "${aws_api_gateway_rest_api.main.id}.execute-api.${var.aws_region}.amazonaws.com"
    origin_id   = "API-${aws_api_gateway_rest_api.main.id}"
    origin_path = "/${aws_api_gateway_stage.main.stage_name}"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  enabled             = true
  is_ipv6_enabled     = true
  comment             = "VCMail Webmail Client"
  default_root_object = "index.html"

  aliases = [var.mail_domain]

  # Optional: Enable CloudFront logging for debugging
  # Uncomment and configure S3 bucket for logs if needed
  # logging_config {
  #   include_cookies = false
  #   bucket          = "${var.project_name}-cloudfront-logs.s3.amazonaws.com"
  #   prefix          = "cloudfront/"
  # }

  # Cache behavior for /api/* - forward to API Gateway
  ordered_cache_behavior {
    path_pattern     = "/api/*"
    allowed_methods  = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "API-${aws_api_gateway_rest_api.main.id}"

    forwarded_values {
      query_string = true
      headers      = ["Authorization", "Content-Type", "X-Requested-With"]

      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 0
    max_ttl                = 0
    compress               = true
  }

  # Default cache behavior for S3 (static files)
  default_cache_behavior {
    allowed_methods  = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-${aws_s3_bucket.webmail.bucket}"

    forwarded_values {
      query_string = false

      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 3600
    max_ttl                = 86400
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate.webmail.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = {
    Name      = "VCMail Webmail"
    Project   = var.project_name
    ManagedBy = "Terraform"
  }
}

# ACM Certificate for webmail domain
resource "aws_acm_certificate" "webmail" {
  domain_name       = var.mail_domain
  validation_method = "DNS"

  subject_alternative_names = []

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name      = "VCMail Webmail Certificate"
    Project   = var.project_name
    ManagedBy = "Terraform"
  }
}

# ACM Certificate validation
resource "aws_acm_certificate_validation" "webmail" {
  certificate_arn = aws_acm_certificate.webmail.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
  
  timeouts {
    create = "5m"
  }
}

# Route53 Record for certificate validation
resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.webmail.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = data.aws_route53_zone.main.zone_id
}

# Route53 Record for webmail domain (A record to CloudFront)
resource "aws_route53_record" "webmail" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.mail_domain
  type    = "A"
  
  # Allow overwriting existing records (prevents conflicts when record already exists)
  allow_overwrite = true

  alias {
    name                   = aws_cloudfront_distribution.webmail.domain_name
    zone_id                = aws_cloudfront_distribution.webmail.hosted_zone_id
    evaluate_target_health = false
  }
}

# SES Domain Identity
resource "aws_ses_domain_identity" "main" {
  domain = var.domain
}

# SES Domain Identity Verification
resource "aws_ses_domain_identity_verification" "main" {
  domain = aws_ses_domain_identity.main.id

  timeouts {
    create = "5m"
  }
}

# Route53 Record for SES domain verification
resource "aws_route53_record" "ses_verification" {
  zone_id        = data.aws_route53_zone.main.zone_id
  name           = "_amazonses.${var.domain}"
  type           = "TXT"
  ttl            = 600
  records        = [aws_ses_domain_identity.main.verification_token]
  allow_overwrite = true
}

# SES Domain DKIM
resource "aws_ses_domain_dkim" "main" {
  domain = aws_ses_domain_identity.main.domain
}

# Route53 Records for SES DKIM
resource "aws_route53_record" "dkim" {
  count          = 3
  zone_id        = data.aws_route53_zone.main.zone_id
  name           = "${aws_ses_domain_dkim.main.dkim_tokens[count.index]}._domainkey.${var.domain}"
  type           = "CNAME"
  ttl            = 600
  records        = ["${aws_ses_domain_dkim.main.dkim_tokens[count.index]}.dkim.amazonses.com"]
  allow_overwrite = true
}

# MX Record for receiving emails via SES
# SES uses different inbound endpoints based on region
# For us-east-1: inbound-smtp.us-east-1.amazonaws.com
resource "aws_route53_record" "mx" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.domain
  type    = "MX"
  ttl     = 300
  records = ["10 inbound-smtp.${var.aws_region}.amazonaws.com"]
}

# SPF record for root domain (for email authentication when sending from root domain)
resource "aws_route53_record" "spf" {
  zone_id         = data.aws_route53_zone.main.zone_id
  name            = var.domain
  type            = "TXT"
  ttl             = 600
  records         = ["v=spf1 include:amazonses.com ~all"]
  allow_overwrite = true
}

# DMARC record for email authentication and policy
resource "aws_route53_record" "dmarc" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = 600
  records = ["v=DMARC1; p=quarantine; rua=mailto:dmarc@${var.domain}; ruf=mailto:dmarc@${var.domain}; fo=1"]
}

# SES MAIL FROM domain configuration
# This is required for proper DMARC alignment
# The MAIL FROM domain is used for the Return-Path header in emails
# NOTE: AWS SES requires the MAIL FROM domain to be a SUBDOMAIN of the verified domain
# Using a subdomain (mail.example.com) achieves relaxed SPF alignment, which is valid for DMARC
# Combined with strict DKIM alignment (signing with example.com), this satisfies DMARC requirements
# We use the same subdomain as the webmail domain (var.mail_domain) - they coexist with different record types
resource "aws_ses_domain_mail_from" "main" {
  domain           = aws_ses_domain_identity.main.domain
  mail_from_domain = var.mail_domain
}

# Route53 MX record for MAIL FROM domain (required by SES)
# SES requires this MX record to verify the MAIL FROM domain
resource "aws_route53_record" "mail_from_mx" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = aws_ses_domain_mail_from.main.mail_from_domain
  type    = "MX"
  ttl     = 600
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]
  allow_overwrite = true
}

# Route53 SPF record for MAIL FROM domain (required for DMARC alignment)
# This SPF record authorizes Amazon SES to send emails on behalf of the MAIL FROM domain
resource "aws_route53_record" "mail_from_spf" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = aws_ses_domain_mail_from.main.mail_from_domain
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com ~all"]
  allow_overwrite = true
}

# SES Email Address (for sending emails)
resource "aws_ses_email_identity" "noreply" {
  email = "noreply@${var.domain}"
}

# SES Configuration Set (optional, for tracking)
resource "aws_ses_configuration_set" "main" {
  name = "${var.project_name}-email-config"

  delivery_options {
    tls_policy = "Require"
  }
}

# Determine which rule set to use
locals {
  # Use existing VCMail rule set if provided, otherwise use project-specific one
  rule_set_name = var.shared_rule_set_name != "" ? var.shared_rule_set_name : "${var.project_name}-incoming-email"
  
  # Only create/activate rule set if we're not using a shared one
  should_manage_rule_set = var.shared_rule_set_name == ""
}

# SES Receipt Rule Set (for processing incoming emails)
# Only create if not using a shared rule set
resource "aws_ses_receipt_rule_set" "main" {
  count        = local.should_manage_rule_set ? 1 : 0
  rule_set_name = local.rule_set_name
  
  lifecycle {
    # Prevent Terraform from deleting the rule set if it exists
    # This avoids errors when the rule set is already active
    prevent_destroy = false
    create_before_destroy = false
  }
}

# Activate the rule set
# Only activate if we created the rule set (not using a shared one)
resource "aws_ses_active_receipt_rule_set" "main" {
  count        = local.should_manage_rule_set ? 1 : 0
  rule_set_name = aws_ses_receipt_rule_set.main[0].rule_set_name
  
  lifecycle {
    # Prevent accidental deletion of active rule set
    # Must manually deactivate before destroying
    prevent_destroy = false
  }
}

# SES Receipt Rule (to store emails in S3 and invoke Lambda)
# ALWAYS create - adds rule to either shared or new rule set
resource "aws_ses_receipt_rule" "main" {
  name          = "${var.project_name}-email-rule"
  rule_set_name = local.rule_set_name  # References rule set by name (works even if not in Terraform state)
  enabled       = true
  scan_enabled  = true

  # Recipients: for domain-wide matching, use just the domain without @
  # SES will match all email addresses ending with @domain
  recipients = [var.domain]

  s3_action {
    bucket_name = aws_s3_bucket.mail_inbox.bucket
    position    = 1
  }

  lambda_action {
    function_arn    = aws_lambda_function.email_processor.arn
    invocation_type = "Event"
    position        = 2
  }
  
  lifecycle {
    # Only recreate if the configuration actually changes
    # This prevents unnecessary updates when Terraform state drifts
    create_before_destroy = true
  }
}

# Create Lambda deployment package
# This packages the Lambda code and dependencies
# Note: vcmail-lambda-package is created in the project root (one level up from .vcmail-terraform)
data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../vcmail-lambda-package"
  output_path = "${path.module}/lambda-package.zip"
  excludes    = ["node_modules/.cache", "node_modules/**/test", "node_modules/**/tests", "*.test.js", "*.spec.js"]
  
  depends_on = [] # Lambda package should be prepared before Terraform runs
}

# Lambda function for processing emails
resource "aws_lambda_function" "email_processor" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "${var.project_name}-api"
  role             = aws_iam_role.lambda_email_processor.arn
  handler          = "api/api.handler"
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  runtime          = "nodejs18.x"
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      FIREBASE_CONFIG = jsonencode({
        projectId   = var.firebase_project_id
        databaseURL  = var.firebase_database_url
      })
      VCMAIL_CONFIG = jsonencode({
        domain          = var.domain
        s3BucketName    = var.s3_bucket_name
        ssmPrefix       = var.ssm_prefix
        awsRegion       = var.aws_region
      })
    }
  }

  tags = {
    Name      = "VCMail Email Processor"
    Project   = var.project_name
    ManagedBy = "Terraform"
  }
}

# Lambda permission for SES
resource "aws_lambda_permission" "ses" {
  statement_id  = "AllowExecutionFromSES"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.email_processor.function_name
  principal     = "ses.amazonaws.com"
  source_account = data.aws_caller_identity.current.account_id
}

# IAM Role for Lambda email processor
resource "aws_iam_role" "lambda_email_processor" {
  name = "${var.project_name}-email-processor-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name      = "VCMail Lambda Role"
    Project   = var.project_name
    ManagedBy = "Terraform"
  }
}

# IAM Policy for Lambda email processor
resource "aws_iam_role_policy" "lambda_email_processor" {
  name = "${var.project_name}-email-processor-policy"
  role = aws_iam_role.lambda_email_processor.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:PutObjectAcl"
        ]
        Resource = [
          "${aws_s3_bucket.mail_inbox.arn}/*",
          "${aws_s3_bucket.webmail.arn}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.mail_inbox.arn,
          aws_s3_bucket.webmail.arn
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters"
        ]
        Resource = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${var.ssm_prefix}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "ses:SendEmail",
          "ses:SendRawEmail"
        ]
        Resource = "*"
      }
    ]
  })
}

# API Gateway REST API
resource "aws_api_gateway_rest_api" "main" {
  name        = "${var.project_name}-api"
  description = "VCMail API Gateway"

  endpoint_configuration {
    types = ["REGIONAL"]
  }

  tags = {
    Name      = "VCMail API"
    Project   = var.project_name
    ManagedBy = "Terraform"
  }
}

# API Gateway Resource for proxy
resource "aws_api_gateway_resource" "proxy" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "api"
}

# API Gateway Resource for {proxy+}
resource "aws_api_gateway_resource" "proxy_path" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.proxy.id
  path_part   = "{proxy+}"
}

# API Gateway Method for ANY
resource "aws_api_gateway_method" "proxy" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.proxy_path.id
  http_method   = "ANY"
  authorization = "NONE"
}

# API Gateway Integration with Lambda
resource "aws_api_gateway_integration" "lambda" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.proxy_path.id
  http_method = aws_api_gateway_method.proxy.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.email_processor.invoke_arn
}

# API Gateway Method for OPTIONS (CORS)
resource "aws_api_gateway_method" "options" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.proxy_path.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

# API Gateway Integration for OPTIONS - Use Lambda proxy to handle CORS properly
resource "aws_api_gateway_integration" "options" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.proxy_path.id
  http_method = aws_api_gateway_method.options.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.email_processor.invoke_arn
}

# Note: Method Response and Integration Response are not needed for AWS_PROXY integration
# Lambda proxy integration returns the response directly from Lambda

# Lambda permission for API Gateway
resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.email_processor.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# API Gateway Deployment
resource "aws_api_gateway_deployment" "main" {
  depends_on = [
    aws_api_gateway_integration.lambda,
    aws_api_gateway_integration.options,
  ]

  rest_api_id = aws_api_gateway_rest_api.main.id

  lifecycle {
    create_before_destroy = true
  }

  triggers = {
    redeployment = sha1(jsonencode([
      aws_api_gateway_resource.proxy_path.id,
      aws_api_gateway_method.proxy.id,
      aws_api_gateway_method.options.id,
      aws_api_gateway_integration.lambda.id,
      aws_api_gateway_integration.options.id,
    ]))
  }
}

# API Gateway Stage
# Note: deployment_id references the deployment resource, so Terraform will automatically
# update the stage when a new deployment is created
resource "aws_api_gateway_stage" "main" {
  deployment_id = aws_api_gateway_deployment.main.id
  rest_api_id   = aws_api_gateway_rest_api.main.id
  stage_name    = "prod"
  
  # Ensure stage is updated when deployment changes
  lifecycle {
    create_before_destroy = false
  }
}
