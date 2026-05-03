output "lambda_function_name" {
  description = "Shared VCMail Lambda function name"
  value       = aws_lambda_function.email_processor.function_name
}

output "lambda_function_arn" {
  description = "Shared VCMail Lambda ARN"
  value       = aws_lambda_function.email_processor.arn
}

output "lambda_invoke_arn" {
  description = "Invoke ARN for API Gateway integrations"
  value       = aws_lambda_function.email_processor.invoke_arn
}

output "ses_receipt_rule_set_name" {
  description = "Canonical SES receipt rule set managed by this stack"
  value       = aws_ses_receipt_rule_set.main.rule_set_name
}
