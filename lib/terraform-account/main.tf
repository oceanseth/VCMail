# VCMail account-level stack: one apply per AWS account (shared Lambda, IAM, canonical SES rule set).
# Per-domain resources (S3, CloudFront, API Gateway, per-domain SES receipt rules) live in ../.vcmail-terraform (site stack).

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
}

data "aws_caller_identity" "current" {}

data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../vcmail-lambda-package"
  output_path = "${path.module}/lambda-package.zip"
  excludes    = ["node_modules/.cache", "node_modules/**/test", "node_modules/**/tests", "*.test.js", "*.spec.js"]
}

resource "aws_lambda_function" "email_processor" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "VCMail-api"
  role             = aws_iam_role.lambda_email_processor.arn
  handler          = "api/api.handler"
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  runtime          = "nodejs18.x"
  timeout          = 30
  memory_size      = 1024

  environment {
    variables = {}
  }

  tags = {
    Name      = "VCMail Email Processor"
    Project   = "VCMail-Shared"
    ManagedBy = "Terraform"
  }
}

resource "aws_lambda_permission" "ses" {
  statement_id   = "AllowExecutionFromSES"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.email_processor.function_name
  principal      = "ses.amazonaws.com"
  source_account = data.aws_caller_identity.current.account_id
}

resource "aws_iam_role" "lambda_email_processor" {
  name = "VCMail-api-role"

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
    Project   = "VCMail-Shared"
    ManagedBy = "Terraform"
  }

  lifecycle {
    ignore_changes = [assume_role_policy]
  }
}

# S3: wildcard only (no per-site bucket ARNs) so this policy is stable across all domain stacks.
resource "aws_iam_role_policy" "lambda_email_processor" {
  name = "VCMail-api-policy"
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
          "arn:aws:s3:::*-mail-inbox/*",
          "arn:aws:s3:::mail.*/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:ListBucket"
        ]
        Resource = [
          "arn:aws:s3:::*-mail-inbox",
          "arn:aws:s3:::mail.*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters"
        ]
        Resource = [
          "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/*/prod/*"
        ]
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

resource "aws_ses_receipt_rule_set" "main" {
  rule_set_name = "vcmail_rule_set"

  lifecycle {
    prevent_destroy       = false
    create_before_destroy = false
  }
}

resource "aws_ses_active_receipt_rule_set" "main" {
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name

  lifecycle {
    prevent_destroy = false
  }
}
