# License Server AWS Deployment Guide

Complete guide for deploying the License Server to AWS production infrastructure.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Infrastructure Setup](#infrastructure-setup)
4. [Database Setup (RDS)](#database-setup-rds)
5. [Redis Setup (ElastiCache)](#redis-setup-elasticache)
6. [Secrets Manager Configuration](#secrets-manager-configuration)
7. [S3 Storage Setup](#s3-storage-setup)
8. [Cognito Authentication](#cognito-authentication)
9. [EKS Deployment](#eks-deployment)
10. [Alternative: App Runner Deployment](#alternative-app-runner-deployment)
11. [CI/CD Pipeline](#cicd-pipeline)
12. [DNS and SSL Configuration](#dns-and-ssl-configuration)
13. [Monitoring and Logging](#monitoring-and-logging)
14. [Backup and Recovery](#backup-and-recovery)
15. [Security Best Practices](#security-best-practices)
16. [Cost Estimation](#cost-estimation)
17. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
                                    ┌─────────────────────────────────────┐
                                    │           Route 53 DNS              │
                                    │     licensing.agencio.cloud         │
                                    └──────────────┬──────────────────────┘
                                                   │
                                    ┌──────────────▼──────────────────────┐
                                    │      Application Load Balancer      │
                                    │         (SSL Termination)           │
                                    └──────────────┬──────────────────────┘
                                                   │
                    ┌──────────────────────────────┼──────────────────────────────┐
                    │                              │                              │
                    │                    EKS Cluster / App Runner                 │
                    │  ┌───────────────────────────┼───────────────────────────┐  │
                    │  │                           │                           │  │
                    │  │    ┌──────────────────────▼──────────────────────┐    │  │
                    │  │    │              License Server                 │    │  │
                    │  │    │            (2+ replicas/instances)          │    │  │
                    │  │    └──────────────────────┬──────────────────────┘    │  │
                    │  │                           │                           │  │
                    │  └───────────────────────────┼───────────────────────────┘  │
                    │                              │                              │
                    └──────────────────────────────┼──────────────────────────────┘
                                                   │
          ┌────────────────────┬───────────────────┼───────────────────┬────────────────────┐
          │                    │                   │                   │                    │
          ▼                    ▼                   ▼                   ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   RDS PostgreSQL│  │   ElastiCache   │  │    S3 Bucket  │  │ Secrets Manager │  │    Cognito      │
│   (Multi-AZ)    │  │   (Redis)       │  │   (Assets)    │  │  (Credentials)  │  │  (Auth)         │
└─────────────────┘  └─────────────────┘  └───────────────┘  └─────────────────┘  └─────────────────┘
```

### Key Components

| Component | AWS Service | Purpose |
|-----------|-------------|---------|
| Compute | EKS / App Runner | Application hosting |
| Database | RDS PostgreSQL | License and customer data |
| Cache | ElastiCache Serverless | Session cache, rate limiting |
| Storage | S3 | Product bundles, downloads |
| Secrets | Secrets Manager | Credentials, API keys |
| Auth | Cognito | Customer authentication |
| DNS | Route 53 | Domain management |
| SSL | ACM | TLS certificates |
| CDN | CloudFront | Static asset delivery (optional) |

---

## Prerequisites

### Required Tools

```bash
# AWS CLI v2
curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "AWSCLIV2.pkg"
sudo installer -pkg AWSCLIV2.pkg -target /

# Terraform
brew install terraform

# kubectl (for EKS)
brew install kubectl

# Docker
brew install --cask docker

# eksctl (for EKS)
brew install eksctl
```

### AWS Account Setup

1. **AWS Account** with appropriate permissions
2. **IAM User/Role** with admin or deployment permissions
3. **AWS CLI** configured:

```bash
aws configure
# AWS Access Key ID: AKIAXXXXXXXXXX
# AWS Secret Access Key: xxxxxxxxxx
# Default region name: ap-southeast-1
# Default output format: json
```

### Required Permissions

Create an IAM policy for deployment:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:*",
        "eks:*",
        "ec2:*",
        "elasticache:*",
        "rds:*",
        "s3:*",
        "secretsmanager:*",
        "cognito-idp:*",
        "iam:*",
        "logs:*",
        "route53:*",
        "acm:*",
        "elasticloadbalancing:*",
        "apprunner:*"
      ],
      "Resource": "*"
    }
  ]
}
```

---

## Infrastructure Setup

### Option 1: Terraform (Recommended)

All infrastructure can be created using the provided Terraform configuration:

```bash
cd terraform/eks

# Initialize
terraform init

# Set variables
export TF_VAR_aws_region="ap-southeast-1"
export TF_VAR_environment="production"
export TF_VAR_aws_account_id="772693061584"
export TF_VAR_eks_oidc_provider="oidc.eks.ap-southeast-1.amazonaws.com/id/XXXXXXXXXX"

# Plan
terraform plan -out=tfplan

# Apply
terraform apply tfplan
```

### Option 2: AWS Console / CLI

Follow the sections below to create each resource manually.

---

## Database Setup (RDS)

### Create RDS PostgreSQL Instance

```bash
# Create DB subnet group
aws rds create-db-subnet-group \
  --db-subnet-group-name license-server-db-subnet \
  --db-subnet-group-description "License Server DB Subnets" \
  --subnet-ids subnet-xxxxxxxx subnet-yyyyyyyy

# Create security group
aws ec2 create-security-group \
  --group-name license-server-db-sg \
  --description "License Server Database SG" \
  --vpc-id vpc-xxxxxxxx

# Allow inbound PostgreSQL from EKS
aws ec2 authorize-security-group-ingress \
  --group-id sg-xxxxxxxx \
  --protocol tcp \
  --port 5432 \
  --source-group sg-eks-nodes

# Create RDS instance
aws rds create-db-instance \
  --db-instance-identifier license-server-db \
  --db-instance-class db.t3.medium \
  --engine postgres \
  --engine-version 16.1 \
  --master-username postgres \
  --master-user-password "$(openssl rand -base64 24)" \
  --allocated-storage 50 \
  --storage-type gp3 \
  --vpc-security-group-ids sg-xxxxxxxx \
  --db-subnet-group-name license-server-db-subnet \
  --backup-retention-period 7 \
  --multi-az \
  --storage-encrypted \
  --db-name license_server \
  --tags Key=Environment,Value=production Key=Service,Value=license-server
```

### Create Database Schema

```bash
# Get RDS endpoint
RDS_ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier license-server-db \
  --query 'DBInstances[0].Endpoint.Address' --output text)

# Run migrations (from bastion or Cloud9)
DATABASE_URL="postgresql://postgres:PASSWORD@${RDS_ENDPOINT}:5432/license_server" \
  npx prisma migrate deploy
```

### RDS Configuration Recommendations

| Setting | Production Value |
|---------|-----------------|
| Instance Class | db.t3.medium (start), db.r6g.large (scale) |
| Storage | 50GB gp3, auto-scaling to 500GB |
| Multi-AZ | Enabled |
| Backup Retention | 7-14 days |
| Encryption | Enabled (KMS) |
| Performance Insights | Enabled |
| Enhanced Monitoring | Enabled (60s) |

---

## Redis Setup (ElastiCache)

### Option A: ElastiCache Serverless (Recommended)

```bash
# Create serverless cache
aws elasticache create-serverless-cache \
  --serverless-cache-name license-server-cache \
  --engine redis \
  --major-engine-version 7 \
  --security-group-ids sg-xxxxxxxx \
  --subnet-ids subnet-xxxxxxxx subnet-yyyyyyyy \
  --tags Key=Environment,Value=production Key=Service,Value=license-server
```

### Option B: ElastiCache Cluster

```bash
# Create cache subnet group
aws elasticache create-cache-subnet-group \
  --cache-subnet-group-name license-server-cache-subnet \
  --cache-subnet-group-description "License Server Cache Subnets" \
  --subnet-ids subnet-xxxxxxxx subnet-yyyyyyyy

# Create Redis cluster
aws elasticache create-replication-group \
  --replication-group-id license-server-redis \
  --replication-group-description "License Server Redis" \
  --engine redis \
  --engine-version 7.0 \
  --cache-node-type cache.t3.medium \
  --num-cache-clusters 2 \
  --automatic-failover-enabled \
  --cache-subnet-group-name license-server-cache-subnet \
  --security-group-ids sg-xxxxxxxx \
  --at-rest-encryption-enabled \
  --transit-encryption-enabled \
  --tags Key=Environment,Value=production Key=Service,Value=license-server
```

### Redis Configuration

```yaml
# Environment variables for application
REDIS_HOST: "license-server-cache.serverless.apse1.cache.amazonaws.com"
REDIS_PORT: "6379"
REDIS_TLS: "true"
REDIS_DB: "0"
```

---

## Secrets Manager Configuration

### Create Secret

```bash
# Generate secure values
JWT_SECRET=$(openssl rand -base64 48)

# Create secret
aws secretsmanager create-secret \
  --name production/license-server \
  --description "License Server production secrets" \
  --secret-string "{
    \"DATABASE_URL\": \"postgresql://postgres:PASSWORD@rds-endpoint:5432/license_server\",
    \"JWT_SECRET\": \"${JWT_SECRET}\",
    \"STRIPE_SECRET_KEY\": \"sk_live_xxxxxxxxxxxx\",
    \"STRIPE_WEBHOOK_SECRET\": \"whsec_xxxxxxxxxxxx\",
    \"COGNITO_USER_POOL_ID\": \"ap-southeast-1_XXXXXXXXX\",
    \"COGNITO_CLIENT_ID\": \"xxxxxxxxxxxxxxxxxxxxxxxxxx\",
    \"COGNITO_CLIENT_SECRET\": \"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\",
    \"REDIS_HOST\": \"license-server-cache.serverless.apse1.cache.amazonaws.com\",
    \"HCAPTCHA_SITE_KEY\": \"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx\",
    \"HCAPTCHA_SECRET_KEY\": \"0x0000000000000000000000000000000000000000\"
  }" \
  --tags Key=Environment,Value=production Key=Service,Value=license-server
```

### Required Secrets

| Secret Key | Description | Example |
|------------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/db` |
| `JWT_SECRET` | JWT signing key (48+ chars) | Random base64 |
| `STRIPE_SECRET_KEY` | Stripe API secret key | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | `whsec_...` |
| `COGNITO_USER_POOL_ID` | Cognito User Pool ID | `ap-southeast-1_XXXXXXX` |
| `COGNITO_CLIENT_ID` | Cognito App Client ID | `xxxxxxxxxx` |
| `COGNITO_CLIENT_SECRET` | Cognito App Client Secret | `xxxxxxxxxx` |
| `REDIS_HOST` | ElastiCache endpoint | `xxx.cache.amazonaws.com` |
| `HCAPTCHA_SITE_KEY` | hCaptcha site key | `xxxxxxxx-xxxx...` |
| `HCAPTCHA_SECRET_KEY` | hCaptcha secret key | `0xxxxxxxxxxx...` |
| `RSA_PRIVATE_KEY` | Offline license signing key | PEM format |
| `RSA_PUBLIC_KEY` | Offline license verification key | PEM format |

### Update Secret

```bash
aws secretsmanager put-secret-value \
  --secret-id production/license-server \
  --secret-string "$(cat secrets.json)"
```

---

## S3 Storage Setup

### Create Bucket

```bash
# Create bucket
aws s3api create-bucket \
  --bucket ag-license-server-assets \
  --region ap-southeast-1 \
  --create-bucket-configuration LocationConstraint=ap-southeast-1

# Enable versioning
aws s3api put-bucket-versioning \
  --bucket ag-license-server-assets \
  --versioning-configuration Status=Enabled

# Enable encryption
aws s3api put-bucket-encryption \
  --bucket ag-license-server-assets \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'

# Block public access
aws s3api put-public-access-block \
  --bucket ag-license-server-assets \
  --public-access-block-configuration '{
    "BlockPublicAcls": true,
    "IgnorePublicAcls": true,
    "BlockPublicPolicy": true,
    "RestrictPublicBuckets": true
  }'

# Create folders
aws s3api put-object --bucket ag-license-server-assets --key bundles/
aws s3api put-object --bucket ag-license-server-assets --key downloads/
aws s3api put-object --bucket ag-license-server-assets --key temp/
```

### Lifecycle Policy

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket ag-license-server-assets \
  --lifecycle-configuration '{
    "Rules": [
      {
        "ID": "DeleteTempFiles",
        "Status": "Enabled",
        "Filter": {"Prefix": "temp/"},
        "Expiration": {"Days": 1}
      },
      {
        "ID": "DeleteOldVersions",
        "Status": "Enabled",
        "Filter": {},
        "NoncurrentVersionExpiration": {"NoncurrentDays": 90}
      }
    ]
  }'
```

---

## Cognito Authentication

### Create User Pool

```bash
# Create user pool
aws cognito-idp create-user-pool \
  --pool-name license-server-users \
  --policies '{
    "PasswordPolicy": {
      "MinimumLength": 12,
      "RequireUppercase": true,
      "RequireLowercase": true,
      "RequireNumbers": true,
      "RequireSymbols": true
    }
  }' \
  --auto-verified-attributes email \
  --username-attributes email \
  --mfa-configuration OPTIONAL \
  --account-recovery-setting '{
    "RecoveryMechanisms": [
      {"Priority": 1, "Name": "verified_email"}
    ]
  }' \
  --admin-create-user-config '{
    "AllowAdminCreateUserOnly": false
  }' \
  --schema '[
    {"Name": "email", "Required": true, "Mutable": true},
    {"Name": "name", "Required": false, "Mutable": true}
  ]'

# Get User Pool ID
USER_POOL_ID=$(aws cognito-idp list-user-pools --max-results 10 \
  --query "UserPools[?Name=='license-server-users'].Id" --output text)

# Create App Client
aws cognito-idp create-user-pool-client \
  --user-pool-id $USER_POOL_ID \
  --client-name license-server-app \
  --generate-secret \
  --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH ALLOW_USER_SRP_AUTH \
  --supported-identity-providers COGNITO \
  --callback-urls "https://licensing.agencio.cloud/auth/callback" \
  --logout-urls "https://licensing.agencio.cloud/logout" \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes openid email profile \
  --allowed-o-auth-flows-user-pool-client
```

### Cognito Domain

```bash
aws cognito-idp create-user-pool-domain \
  --domain licensing-agencio \
  --user-pool-id $USER_POOL_ID
```

---

## EKS Deployment

### Create EKS Cluster (if not exists)

```bash
# Create cluster with eksctl
eksctl create cluster \
  --name agencio-production \
  --region ap-southeast-1 \
  --version 1.28 \
  --nodegroup-name standard-workers \
  --node-type t3.medium \
  --nodes 3 \
  --nodes-min 2 \
  --nodes-max 10 \
  --managed \
  --with-oidc \
  --alb-ingress-access
```

### Deploy License Server

```bash
cd k8s/eks

# Build and push image
./deploy.sh build

# Deploy to EKS
./deploy.sh deploy

# Verify deployment
kubectl get pods -n preprod -l app=license-server
kubectl get svc -n preprod license-server
```

### Configure Ingress

```yaml
# k8s/eks/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: license-server-ingress
  namespace: preprod
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:ap-southeast-1:772693061584:certificate/xxxxx
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443}]'
    alb.ingress.kubernetes.io/ssl-redirect: '443'
    alb.ingress.kubernetes.io/healthcheck-path: /health
spec:
  rules:
    - host: licensing.agencio.cloud
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: license-server
                port:
                  number: 3030
```

---

## Alternative: App Runner Deployment

For simpler deployments without Kubernetes:

### Create App Runner Service

```bash
# Create App Runner service
aws apprunner create-service \
  --service-name license-server \
  --source-configuration '{
    "ImageRepository": {
      "ImageIdentifier": "772693061584.dkr.ecr.ap-southeast-1.amazonaws.com/ag-license-server:latest",
      "ImageRepositoryType": "ECR",
      "ImageConfiguration": {
        "Port": "3030",
        "RuntimeEnvironmentVariables": {
          "NODE_ENV": "production",
          "PORT": "3030",
          "USE_AWS_SECRETS_MANAGER": "true",
          "AWS_SECRET_NAME": "production/license-server",
          "AWS_REGION": "ap-southeast-1",
          "AUTH_PROVIDER": "cognito",
          "CONFIG_PROVIDER": "secrets-manager"
        }
      }
    },
    "AutoDeploymentsEnabled": true,
    "AuthenticationConfiguration": {
      "AccessRoleArn": "arn:aws:iam::772693061584:role/AppRunnerECRAccessRole"
    }
  }' \
  --instance-configuration '{
    "Cpu": "1024",
    "Memory": "2048",
    "InstanceRoleArn": "arn:aws:iam::772693061584:role/AppRunnerLicenseServerRole"
  }' \
  --health-check-configuration '{
    "Protocol": "HTTP",
    "Path": "/health",
    "Interval": 10,
    "Timeout": 5,
    "HealthyThreshold": 1,
    "UnhealthyThreshold": 5
  }' \
  --auto-scaling-configuration-arn "arn:aws:apprunner:ap-southeast-1:772693061584:autoscalingconfiguration/DefaultConfiguration/1/xxx"
```

### App Runner IAM Role

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue"
      ],
      "Resource": "arn:aws:secretsmanager:ap-southeast-1:772693061584:secret:production/license-server-*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::ag-license-server-assets",
        "arn:aws:s3:::ag-license-server-assets/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "cognito-idp:AdminGetUser",
        "cognito-idp:AdminCreateUser",
        "cognito-idp:AdminDeleteUser",
        "cognito-idp:AdminUpdateUserAttributes",
        "cognito-idp:AdminInitiateAuth",
        "cognito-idp:AdminRespondToAuthChallenge"
      ],
      "Resource": "arn:aws:cognito-idp:ap-southeast-1:772693061584:userpool/*"
    }
  ]
}
```

---

## CI/CD Pipeline

### GitHub Actions Workflow

```yaml
# .github/workflows/deploy-aws.yml
name: Deploy to AWS

on:
  push:
    branches: [main]
  workflow_dispatch:

env:
  AWS_REGION: ap-southeast-1
  ECR_REPOSITORY: ag-license-server
  EKS_CLUSTER: agencio-production

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::772693061584:role/GitHubActionsDeployRole
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build, tag, and push image
        id: build-image
        env:
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          IMAGE_TAG: ${{ github.sha }}
        run: |
          docker build -f Dockerfile.eks -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG .
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG
          docker tag $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG $ECR_REGISTRY/$ECR_REPOSITORY:latest
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:latest
          echo "image=$ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG" >> $GITHUB_OUTPUT

      - name: Update kubeconfig
        run: |
          aws eks update-kubeconfig --name ${{ env.EKS_CLUSTER }} --region ${{ env.AWS_REGION }}

      - name: Deploy to EKS
        run: |
          kubectl set image deployment/license-server \
            license-server=${{ steps.build-image.outputs.image }} \
            -n preprod

      - name: Wait for rollout
        run: |
          kubectl rollout status deployment/license-server -n preprod --timeout=300s

      - name: Verify deployment
        run: |
          kubectl get pods -n preprod -l app=license-server
```

### GitHub OIDC Setup

```bash
# Create OIDC provider for GitHub Actions
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

---

## DNS and SSL Configuration

### Route 53

```bash
# Create hosted zone (if not exists)
aws route53 create-hosted-zone \
  --name agencio.cloud \
  --caller-reference $(date +%s)

# Get ALB DNS name
ALB_DNS=$(kubectl get ingress license-server-ingress -n preprod \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')

# Create A record (alias)
aws route53 change-resource-record-sets \
  --hosted-zone-id ZXXXXXXXXXX \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "licensing.agencio.cloud",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "Z1LMS91P8CMLE5",
          "DNSName": "'$ALB_DNS'",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'
```

### ACM Certificate

```bash
# Request certificate
aws acm request-certificate \
  --domain-name licensing.agencio.cloud \
  --validation-method DNS \
  --subject-alternative-names "*.licensing.agencio.cloud"

# Get validation CNAME
aws acm describe-certificate \
  --certificate-arn arn:aws:acm:ap-southeast-1:772693061584:certificate/xxxxx \
  --query 'Certificate.DomainValidationOptions'

# Add CNAME to Route 53 for validation
# Certificate will be issued after DNS validation
```

---

## Monitoring and Logging

### CloudWatch Logs

```bash
# Create log group
aws logs create-log-group \
  --log-group-name /aws/eks/agencio-production/license-server

# Set retention
aws logs put-retention-policy \
  --log-group-name /aws/eks/agencio-production/license-server \
  --retention-in-days 30
```

### CloudWatch Alarms

```bash
# High CPU alarm
aws cloudwatch put-metric-alarm \
  --alarm-name license-server-high-cpu \
  --alarm-description "License Server CPU > 80%" \
  --metric-name CPUUtilization \
  --namespace AWS/EKS \
  --statistic Average \
  --period 300 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 2 \
  --alarm-actions arn:aws:sns:ap-southeast-1:772693061584:alerts

# Error rate alarm
aws cloudwatch put-metric-alarm \
  --alarm-name license-server-error-rate \
  --alarm-description "License Server Error Rate > 5%" \
  --metric-name 5XXError \
  --namespace AWS/ApplicationELB \
  --statistic Average \
  --period 60 \
  --threshold 5 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 2 \
  --alarm-actions arn:aws:sns:ap-southeast-1:772693061584:alerts
```

### Prometheus & Grafana (EKS)

```bash
# Install Prometheus stack
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace
```

---

## Backup and Recovery

### RDS Automated Backups

```bash
# Modify backup settings
aws rds modify-db-instance \
  --db-instance-identifier license-server-db \
  --backup-retention-period 14 \
  --preferred-backup-window "03:00-04:00" \
  --apply-immediately
```

### Manual Snapshot

```bash
# Create snapshot
aws rds create-db-snapshot \
  --db-instance-identifier license-server-db \
  --db-snapshot-identifier license-server-manual-$(date +%Y%m%d)
```

### S3 Cross-Region Replication

```bash
# Enable replication to another region
aws s3api put-bucket-replication \
  --bucket ag-license-server-assets \
  --replication-configuration '{
    "Role": "arn:aws:iam::772693061584:role/S3ReplicationRole",
    "Rules": [{
      "Status": "Enabled",
      "Priority": 1,
      "DeleteMarkerReplication": {"Status": "Disabled"},
      "Filter": {},
      "Destination": {
        "Bucket": "arn:aws:s3:::ag-license-server-assets-replica"
      }
    }]
  }'
```

---

## Security Best Practices

### Network Security

1. **VPC Configuration**
   - Private subnets for RDS and ElastiCache
   - NAT Gateway for outbound internet access
   - Security groups with least privilege

2. **Security Groups**
   ```bash
   # Example: RDS security group
   aws ec2 authorize-security-group-ingress \
     --group-id sg-rds \
     --protocol tcp \
     --port 5432 \
     --source-group sg-eks-nodes
   ```

### Data Encryption

1. **At Rest**
   - RDS: KMS encryption enabled
   - S3: AES-256 encryption
   - ElastiCache: At-rest encryption

2. **In Transit**
   - TLS 1.2+ for all connections
   - ElastiCache: Transit encryption enabled
   - ALB: HTTPS only

### IAM Security

1. **Least Privilege** - Each service has minimal required permissions
2. **IRSA** - Pod-level IAM roles, not node roles
3. **No Long-term Credentials** - Use IAM roles, not access keys

### Secrets Management

1. **Rotation** - Enable automatic rotation for RDS credentials
2. **No Hardcoded Secrets** - All secrets in Secrets Manager
3. **Audit Logging** - CloudTrail for secrets access

---

## Cost Estimation

### Monthly Costs (Production)

| Service | Configuration | Est. Cost |
|---------|--------------|-----------|
| EKS Cluster | 1 cluster | $73 |
| EC2 (EKS Nodes) | 3x t3.medium | $100 |
| RDS PostgreSQL | db.t3.medium, Multi-AZ | $130 |
| ElastiCache | Serverless | $50-100 |
| S3 | 100GB storage | $5 |
| Secrets Manager | 10 secrets | $5 |
| ALB | 1 ALB | $25 |
| Data Transfer | 100GB/mo | $10 |
| **Total** | | **~$400-450/mo** |

### Cost Optimization Tips

1. **Reserved Instances** - 30-40% savings on RDS and EC2
2. **Spot Instances** - Use for non-critical workloads
3. **Right-sizing** - Start small, scale based on metrics
4. **ElastiCache Serverless** - Pay only for what you use

---

## Troubleshooting

### Common Issues

#### Pod CrashLoopBackOff

```bash
# Check logs
kubectl logs -n preprod -l app=license-server --previous

# Check events
kubectl describe pod -n preprod -l app=license-server
```

#### Database Connection Failed

```bash
# Verify security group
aws ec2 describe-security-groups --group-ids sg-xxxxxxxx

# Test connection from pod
kubectl exec -it deployment/license-server -n preprod -- \
  nc -zv rds-endpoint.amazonaws.com 5432
```

#### Secrets Not Loading

```bash
# Verify IAM role
kubectl describe sa license-server-sa -n preprod

# Test secrets access
kubectl exec -it deployment/license-server -n preprod -- \
  aws secretsmanager get-secret-value --secret-id production/license-server
```

#### Health Check Failing

```bash
# Test health endpoint
kubectl exec -it deployment/license-server -n preprod -- \
  curl -s http://localhost:3030/health

# Check readiness probe
kubectl get pods -n preprod -l app=license-server -o wide
```

### Support

- **Documentation**: `docs/` folder
- **Issues**: https://github.com/agencio/license-server/issues
- **Email**: support@agencio.cloud
