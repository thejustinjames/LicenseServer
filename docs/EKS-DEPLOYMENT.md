# License Server EKS Deployment Guide

This guide covers deploying the License Server to AWS EKS using the existing Agencio infrastructure patterns.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              AWS EKS Cluster                             │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                         preprod namespace                            │ │
│  │                                                                      │ │
│  │  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐          │ │
│  │  │ Kong Gateway │───▶│License Server│───▶│ PostgreSQL   │          │ │
│  │  │   (ingress)  │    │   (2+ pods)  │    │   (RDS)      │          │ │
│  │  └──────────────┘    └──────────────┘    └──────────────┘          │ │
│  │                             │                                        │ │
│  │                             ▼                                        │ │
│  │                      ┌──────────────┐                               │ │
│  │                      │ ElastiCache  │                               │ │
│  │                      │   (Redis)    │                               │ │
│  │                      └──────────────┘                               │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
         │                        │                        │
         ▼                        ▼                        ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ Secrets Manager │    │       S3        │    │    Cognito      │
│ (credentials)   │    │ (file storage)  │    │ (authentication)│
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## Prerequisites

1. **AWS CLI** configured with appropriate credentials
2. **kubectl** configured for your EKS cluster
3. **Docker** for building images
4. **Terraform** >= 1.0.0 (optional, for infrastructure)

## File Structure

```
LicenseServer/
├── k8s/
│   └── eks/
│       ├── namespace.yaml
│       ├── serviceaccount.yaml
│       ├── configmap.yaml
│       ├── secret.yaml
│       ├── deployment.yaml
│       ├── service.yaml
│       ├── hpa.yaml
│       ├── networkpolicy.yaml
│       ├── kustomization.yaml
│       └── deploy.sh
├── terraform/
│   └── eks/
│       └── main.tf
├── bootstrap.mjs
└── Dockerfile.eks
```

## Deployment Steps

### 1. Create AWS Resources (Terraform)

First, create the required AWS resources:

```bash
cd terraform/eks

# Initialize Terraform
terraform init

# Set your EKS OIDC provider
export TF_VAR_eks_oidc_provider="oidc.eks.ap-southeast-1.amazonaws.com/id/XXXXXXXXXX"

# Plan and apply
terraform plan -out=tfplan
terraform apply tfplan
```

This creates:
- S3 bucket: `ag-license-server-assets`
- Secrets Manager secret: `preprod/license-server`
- IAM Role: `Preprod-LicenseServerService-Role`
- ECR Repository: `ag-license-server`

### 2. Configure Secrets

Update the secrets in AWS Secrets Manager:

```bash
aws secretsmanager put-secret-value \
  --secret-id preprod/license-server \
  --secret-string '{
    "DATABASE_URL": "postgresql://user:password@your-rds-endpoint:5432/license_server",
    "JWT_SECRET": "your-secure-jwt-secret",
    "STRIPE_SECRET_KEY": "sk_live_xxx",
    "STRIPE_WEBHOOK_SECRET": "whsec_xxx",
    "COGNITO_USER_POOL_ID": "ap-southeast-1_XXXXXXX",
    "COGNITO_CLIENT_ID": "your-client-id",
    "COGNITO_CLIENT_SECRET": "your-client-secret",
    "REDIS_HOST": "your-elasticache-endpoint.cache.amazonaws.com",
    "HCAPTCHA_SITE_KEY": "your-site-key",
    "HCAPTCHA_SECRET_KEY": "your-secret-key"
  }' \
  --region ap-southeast-1
```

### 3. Build and Push Docker Image

```bash
# Set environment
export AWS_REGION=ap-southeast-1
export AWS_ACCOUNT_ID=772693061584

# Login to ECR
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

# Build image
docker build -f Dockerfile.eks -t ag-license-server:latest .

# Tag for ECR
docker tag ag-license-server:latest \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/ag-license-server:latest

# Push to ECR
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/ag-license-server:latest
```

### 4. Deploy to Kubernetes

```bash
cd k8s/eks

# Verify kubectl context
kubectl config current-context

# Apply with kustomize
kubectl apply -k .

# Watch rollout
kubectl rollout status deployment/license-server -n preprod

# Verify pods
kubectl get pods -n preprod -l app=license-server
```

### 5. Configure Kong Gateway

Add the license server route to Kong:

```bash
# Add service
curl -X POST http://kong-admin:8001/services \
  -d name=license-server \
  -d url=http://license-server.preprod.svc.cluster.local:3030

# Add route
curl -X POST http://kong-admin:8001/services/license-server/routes \
  -d paths[]=/api/licensing \
  -d strip_path=true
```

Or via Kong declarative config:

```yaml
services:
  - name: license-server
    url: http://license-server.preprod.svc.cluster.local:3030
    routes:
      - name: license-server-api
        paths:
          - /api/licensing
        strip_path: true
```

## Using the Deploy Script

The `deploy.sh` script automates the deployment:

```bash
cd k8s/eks
chmod +x deploy.sh

# Full deployment (build + deploy)
./deploy.sh all

# Build only
./deploy.sh build

# Deploy only (uses existing image)
./deploy.sh deploy

# Check status
./deploy.sh status

# Apply Terraform
./deploy.sh terraform
```

## Configuration Reference

### Environment Variables (ConfigMap)

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3030` |
| `NODE_ENV` | Environment | `production` |
| `AUTH_PROVIDER` | Auth provider | `cognito` |
| `CONFIG_PROVIDER` | Config provider | `secrets-manager` |
| `S3_BUCKET` | S3 bucket name | `ag-license-server-assets` |
| `CORS_ORIGINS` | Allowed origins | `https://licensing.agencio.cloud` |

### Secrets (AWS Secrets Manager)

| Secret Key | Description |
|------------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | JWT signing secret |
| `STRIPE_SECRET_KEY` | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook secret |
| `COGNITO_USER_POOL_ID` | Cognito User Pool ID |
| `COGNITO_CLIENT_ID` | Cognito App Client ID |
| `COGNITO_CLIENT_SECRET` | Cognito App Client Secret |
| `REDIS_HOST` | ElastiCache endpoint |

### IAM Role Permissions

The service account IAM role has permissions for:
- **Secrets Manager**: Read secrets from `preprod/license-server`
- **S3**: Read/write to `ag-license-server-assets` bucket
- **Cognito**: User management operations
- **ECR**: Pull container images
- **CloudWatch Logs**: Write application logs

## Monitoring

### Health Checks

- Liveness: `GET /health/live`
- Readiness: `GET /health/ready`

### Prometheus Metrics

Metrics are exposed at `/metrics` on port 3030. Pod annotations enable automatic scraping:

```yaml
prometheus.io/scrape: "true"
prometheus.io/port: "3030"
prometheus.io/path: "/metrics"
```

### Logs

View logs:
```bash
kubectl logs -n preprod -l app=license-server -f
```

## Scaling

### Horizontal Pod Autoscaler

The HPA scales between 2-10 replicas based on:
- CPU utilization > 70%
- Memory utilization > 80%

Check HPA status:
```bash
kubectl get hpa -n preprod license-server-hpa
```

### Manual Scaling

```bash
kubectl scale deployment/license-server -n preprod --replicas=5
```

## Troubleshooting

### Pod Not Starting

1. Check pod events:
   ```bash
   kubectl describe pod -n preprod -l app=license-server
   ```

2. Check secrets loading:
   ```bash
   kubectl logs -n preprod -l app=license-server --previous
   ```

3. Verify IAM role:
   ```bash
   kubectl describe sa license-server-sa -n preprod
   ```

### Database Connection Issues

1. Verify security groups allow traffic from EKS
2. Check DATABASE_URL in Secrets Manager
3. Run Prisma migrations manually if needed:
   ```bash
   kubectl exec -it deployment/license-server -n preprod -- npx prisma migrate deploy
   ```

### S3 Access Denied

1. Verify IRSA is configured correctly
2. Check IAM role policy allows S3 access
3. Ensure bucket exists and has correct permissions

## Rolling Back

```bash
# View rollout history
kubectl rollout history deployment/license-server -n preprod

# Rollback to previous version
kubectl rollout undo deployment/license-server -n preprod

# Rollback to specific revision
kubectl rollout undo deployment/license-server -n preprod --to-revision=2
```
