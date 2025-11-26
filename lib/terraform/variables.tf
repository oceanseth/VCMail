# VCMail Terraform Variables

variable "domain" {
  description = "Main domain name (e.g., example.com)"
  type        = string
}

variable "project_name" {
  description = "Project name used for resource naming (lowercase, alphanumeric, hyphens only)"
  type        = string
}

variable "mail_domain" {
  description = "Mail subdomain (e.g., mail.example.com)"
  type        = string
}

variable "aws_region" {
  description = "AWS region for resources"
  type        = string
  default     = "us-east-1"
}

variable "firebase_project_id" {
  description = "Firebase project ID"
  type        = string
}

variable "firebase_database_url" {
  description = "Firebase Realtime Database URL"
  type        = string
}

variable "ssm_prefix" {
  description = "SSM parameter store prefix"
  type        = string
  default     = "/vcmail/prod"
}

variable "s3_bucket_name" {
  description = "S3 bucket name for email inbox"
  type        = string
}

variable "s3_webmail_bucket_name" {
  description = "S3 bucket name for webmail client"
  type        = string
}


variable "tags" {
  description = "Common tags for all resources"
  type        = map(string)
  default = {
    ManagedBy = "Terraform"
    Project   = "VCMail"
  }
}
