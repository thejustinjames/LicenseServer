# Terraform configuration for License Server EKS deployment
# This creates the AWS resources needed by the license server

terraform {
  required_version = ">= 1.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Backend configuration - adjust for your setup
  # backend "s3" {
  #   bucket = "agencio-terraform-state"
  #   key    = "preprod/license-server/terraform.tfstate"
  #   region = "ap-southeast-1"
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Environment = var.environment
      Project     = "agencio"
      Service     = "license-server"
      ManagedBy   = "terraform"
    }
  }
}

# =============================================================================
# Variables
# =============================================================================

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "ap-southeast-1"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "preprod"
}

variable "aws_account_id" {
  description = "AWS Account ID"
  type        = string
  default     = "772693061584"
}

variable "eks_cluster_name" {
  description = "EKS cluster name"
  type        = string
  default     = "agencio-preprod"
}

variable "eks_oidc_provider" {
  description = "EKS OIDC provider URL (without https://)"
  type        = string
}

# =============================================================================
# S3 Bucket for License Server Assets
# =============================================================================

resource "aws_s3_bucket" "license_server_assets" {
  bucket = "ag-license-server-assets"
}

resource "aws_s3_bucket_versioning" "license_server_assets" {
  bucket = aws_s3_bucket.license_server_assets.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "license_server_assets" {
  bucket = aws_s3_bucket.license_server_assets.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "license_server_assets" {
  bucket = aws_s3_bucket.license_server_assets.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "license_server_assets" {
  bucket = aws_s3_bucket.license_server_assets.id

  rule {
    id     = "cleanup-old-versions"
    status = "Enabled"

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

# =============================================================================
# AWS Secrets Manager Secret
# =============================================================================

resource "aws_secretsmanager_secret" "license_server" {
  name        = "${var.environment}/license-server"
  description = "Secrets for License Server service"

  recovery_window_in_days = 7
}

# Initial secret value - should be updated manually or via CI/CD
resource "aws_secretsmanager_secret_version" "license_server" {
  secret_id = aws_secretsmanager_secret.license_server.id

  secret_string = jsonencode({
    DATABASE_URL           = "postgresql://user:password@host:5432/license_server"
    JWT_SECRET             = "CHANGE_ME_TO_SECURE_VALUE"
    STRIPE_SECRET_KEY      = "sk_test_CHANGE_ME"
    STRIPE_WEBHOOK_SECRET  = "whsec_CHANGE_ME"
    COGNITO_USER_POOL_ID   = "ap-southeast-1_XXXXXXX"
    COGNITO_CLIENT_ID      = "CHANGE_ME"
    COGNITO_CLIENT_SECRET  = "CHANGE_ME"
    REDIS_HOST             = "ag-preprod-cache.serverless.apse1.cache.amazonaws.com"
    HCAPTCHA_SITE_KEY      = ""
    HCAPTCHA_SECRET_KEY    = ""
    RSA_PRIVATE_KEY        = ""
    RSA_PUBLIC_KEY         = ""
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# =============================================================================
# IAM Role for Service Account (IRSA)
# =============================================================================

data "aws_iam_policy_document" "license_server_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "Federated"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:oidc-provider/${var.eks_oidc_provider}"]
    }

    actions = ["sts:AssumeRoleWithWebIdentity"]

    condition {
      test     = "StringEquals"
      variable = "${var.eks_oidc_provider}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${var.eks_oidc_provider}:sub"
      values   = ["system:serviceaccount:preprod:license-server-sa"]
    }
  }
}

resource "aws_iam_role" "license_server" {
  name               = "Preprod-LicenseServerService-Role"
  assume_role_policy = data.aws_iam_policy_document.license_server_assume_role.json
}

# =============================================================================
# IAM Policy for License Server
# =============================================================================

data "aws_iam_policy_document" "license_server_policy" {
  # Secrets Manager - Read secrets
  statement {
    sid    = "SecretsManagerRead"
    effect = "Allow"

    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret"
    ]

    resources = [
      aws_secretsmanager_secret.license_server.arn
    ]
  }

  # S3 - Full access to license server bucket
  statement {
    sid    = "S3BucketAccess"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
      "s3:GetObjectVersion",
      "s3:GetBucketLocation"
    ]

    resources = [
      aws_s3_bucket.license_server_assets.arn,
      "${aws_s3_bucket.license_server_assets.arn}/*"
    ]
  }

  # Cognito - User management operations
  statement {
    sid    = "CognitoUserManagement"
    effect = "Allow"

    actions = [
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminDeleteUser",
      "cognito-idp:AdminUpdateUserAttributes",
      "cognito-idp:AdminInitiateAuth",
      "cognito-idp:AdminRespondToAuthChallenge",
      "cognito-idp:AdminSetUserPassword",
      "cognito-idp:AdminResetUserPassword",
      "cognito-idp:ListUsers",
      "cognito-idp:DescribeUserPool"
    ]

    resources = [
      "arn:aws:cognito-idp:${var.aws_region}:${var.aws_account_id}:userpool/*"
    ]
  }

  # ECR - Pull images
  statement {
    sid    = "ECRPullImages"
    effect = "Allow"

    actions = [
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetAuthorizationToken"
    ]

    resources = ["*"]
  }

  # CloudWatch Logs
  statement {
    sid    = "CloudWatchLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams"
    ]

    resources = [
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/eks/*"
    ]
  }
}

resource "aws_iam_policy" "license_server" {
  name        = "Preprod-LicenseServerService-Policy"
  description = "IAM policy for License Server service"
  policy      = data.aws_iam_policy_document.license_server_policy.json
}

resource "aws_iam_role_policy_attachment" "license_server" {
  role       = aws_iam_role.license_server.name
  policy_arn = aws_iam_policy.license_server.arn
}

# =============================================================================
# ECR Repository
# =============================================================================

resource "aws_ecr_repository" "license_server" {
  name                 = "ag-license-server"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "license_server" {
  repository = aws_ecr_repository.license_server.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 images"
        selection = {
          tagStatus     = "any"
          countType     = "imageCountMoreThan"
          countNumber   = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# =============================================================================
# Outputs
# =============================================================================

output "iam_role_arn" {
  description = "IAM role ARN for license server service account"
  value       = aws_iam_role.license_server.arn
}

output "s3_bucket_name" {
  description = "S3 bucket name for license server assets"
  value       = aws_s3_bucket.license_server_assets.id
}

output "secrets_manager_arn" {
  description = "Secrets Manager secret ARN"
  value       = aws_secretsmanager_secret.license_server.arn
}

output "ecr_repository_url" {
  description = "ECR repository URL"
  value       = aws_ecr_repository.license_server.repository_url
}
