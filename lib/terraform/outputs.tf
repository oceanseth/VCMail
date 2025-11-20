# VCMail Terraform Outputs

output "webmail_url" {
  description = "URL for accessing the webmail client"
  value       = "https://${var.mail_domain}"
}

output "webmail_s3_bucket" {
  description = "S3 bucket name for webmail client"
  value       = aws_s3_bucket.webmail.bucket
}

output "mail_inbox_s3_bucket" {
  description = "S3 bucket name for email inbox"
  value       = aws_s3_bucket.mail_inbox.bucket
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID for webmail"
  value       = aws_cloudfront_distribution.webmail.id
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain name"
  value       = aws_cloudfront_distribution.webmail.domain_name
}

output "api_gateway_id" {
  description = "API Gateway REST API ID"
  value       = aws_api_gateway_rest_api.main.id
}

output "api_gateway_endpoint" {
  description = "API Gateway endpoint URL"
  value       = "https://${aws_api_gateway_rest_api.main.id}.execute-api.${var.aws_region}.amazonaws.com"
}

# Lambda outputs
output "lambda_function_name" {
  description = "Lambda function name for email processor"
  value       = aws_lambda_function.email_processor.function_name
}

output "lambda_function_arn" {
  description = "Lambda function ARN for email processor"
  value       = aws_lambda_function.email_processor.arn
}

output "api_gateway_url" {
  description = "API Gateway endpoint URL"
  value       = "https://${aws_api_gateway_rest_api.main.id}.execute-api.${var.aws_region}.amazonaws.com/${aws_api_gateway_stage.main.stage_name}"
}

output "ses_domain_identity_arn" {
  description = "SES domain identity ARN"
  value       = aws_ses_domain_identity.main.arn
}

output "route53_zone_id" {
  description = "Route53 hosted zone ID"
  value       = data.aws_route53_zone.main.zone_id
}

output "hosted_zone_id" {
  description = "Route53 hosted zone ID (alias for route53_zone_id)"
  value       = data.aws_route53_zone.main.zone_id
}

output "acm_certificate_arn" {
  description = "ACM certificate ARN for webmail domain"
  value       = aws_acm_certificate.webmail.arn
}

output "ssm_parameter_prefix" {
  description = "SSM parameter store prefix"
  value       = var.ssm_prefix
}
