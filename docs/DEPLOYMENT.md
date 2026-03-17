# Production Deployment Guide

This guide covers deploying the License Server to production environments.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Docker Deployment](#docker-deployment)
3. [Kubernetes Deployment](#kubernetes-deployment)
4. [AWS Deployment](#aws-deployment)
5. [Environment Variables](#environment-variables)
6. [Database Setup](#database-setup)
7. [SSL/TLS Configuration](#ssltls-configuration)
8. [Security Checklist](#security-checklist)
9. [Monitoring](#monitoring)
10. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- Node.js 20+ or Docker
- PostgreSQL 14+
- Stripe account with API keys
- (Optional) AWS account for S3, Secrets Manager, Cognito
- (Optional) Azure AD for email notifications

---

## Docker Deployment

### Build the Image

```bash
docker build -t license-server:latest .
```

### Run with Docker Compose

```bash
# Copy and configure environment
cp .env.example .env
# Edit .env with production values

# Start services
docker-compose up -d
```

### Docker Compose Production Example

```yaml
version: '3.8'
services:
  app:
    image: license-server:latest
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://user:pass@db:5432/license_server
      - NODE_ENV=production
    depends_on:
      - db
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  db:
    image: postgres:16-alpine
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      - POSTGRES_USER=license_user
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_DB=license_server
    restart: unless-stopped

volumes:
  postgres_data:
```

---

## Kubernetes Deployment

### Apply Manifests

```bash
# Create namespace
kubectl create namespace license-server

# Apply configurations
kubectl apply -f k8s/configmap.yaml -n license-server
kubectl apply -f k8s/secret.yaml -n license-server
kubectl apply -f k8s/serviceaccount.yaml -n license-server
kubectl apply -f k8s/deployment.yaml -n license-server
kubectl apply -f k8s/service.yaml -n license-server
kubectl apply -f k8s/hpa.yaml -n license-server
```

### EKS with IRSA (IAM Roles for Service Accounts)

1. Create IAM role with required policies
2. Associate role with service account:

```bash
eksctl create iamserviceaccount \
  --name license-server \
  --namespace license-server \
  --cluster your-cluster \
  --attach-policy-arn arn:aws:iam::ACCOUNT:policy/LicenseServerPolicy \
  --approve
```

### Ingress Configuration

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: license-server
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
    - hosts:
        - license.yourdomain.com
      secretName: license-server-tls
  rules:
    - host: license.yourdomain.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: license-server
                port:
                  number: 3000
```

---

## AWS Deployment

### ECS Fargate

1. Create ECR repository and push image:

```bash
aws ecr create-repository --repository-name license-server
aws ecr get-login-password | docker login --username AWS --password-stdin ACCOUNT.dkr.ecr.REGION.amazonaws.com
docker tag license-server:latest ACCOUNT.dkr.ecr.REGION.amazonaws.com/license-server:latest
docker push ACCOUNT.dkr.ecr.REGION.amazonaws.com/license-server:latest
```

2. Create task definition with environment from Secrets Manager
3. Create ECS service with ALB target group
4. Configure auto-scaling based on CPU/memory

### AWS Secrets Manager

Store sensitive configuration:

```bash
# Create secrets
aws secretsmanager create-secret \
  --name license-server/database-url \
  --secret-string "postgresql://user:pass@host:5432/db"

aws secretsmanager create-secret \
  --name license-server/jwt-secret \
  --secret-string "your-32-char-minimum-secret-key"

aws secretsmanager create-secret \
  --name license-server/stripe-keys \
  --secret-string '{"secretKey":"sk_live_xxx","webhookSecret":"whsec_xxx"}'
```

Enable in app:
```env
CONFIG_PROVIDER=secrets-manager
AWS_SECRETS_PREFIX=license-server/
```

### RDS PostgreSQL

```bash
aws rds create-db-instance \
  --db-instance-identifier license-server-db \
  --db-instance-class db.t3.micro \
  --engine postgres \
  --master-username admin \
  --master-user-password YOUR_PASSWORD \
  --allocated-storage 20 \
  --vpc-security-group-ids sg-xxx \
  --db-subnet-group-name your-subnet-group
```

---

## Environment Variables

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/db` |
| `JWT_SECRET` | Secret for JWT signing (min 32 chars) | `your-super-secret-key-min-32-chars` |
| `STRIPE_SECRET_KEY` | Stripe API secret key | `sk_live_xxx` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | `whsec_xxx` |
| `STRIPE_SUCCESS_URL` | Redirect URL after checkout | `https://app.yourdomain.com/success` |
| `STRIPE_CANCEL_URL` | Redirect URL on checkout cancel | `https://app.yourdomain.com/cancel` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment | `development` |
| `ADMIN_EMAIL` | Initial admin email | - |
| `ADMIN_PASSWORD` | Initial admin password | - |
| `CONFIG_PROVIDER` | Config source | `env` |
| `AUTH_PROVIDER` | Auth method | `jwt` |
| `CORS_ORIGINS` | Allowed origins | `*` |

See `.env.example` for complete list.

---

## Database Setup

### Run Migrations

```bash
# Generate Prisma client
npx prisma generate

# Run migrations
npx prisma migrate deploy
```

### Backup Strategy

```bash
# Daily backup
pg_dump -h HOST -U USER -d license_server > backup_$(date +%Y%m%d).sql

# Restore
psql -h HOST -U USER -d license_server < backup.sql
```

---

## SSL/TLS Configuration

### Behind Reverse Proxy (nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name license.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/license.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/license.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### AWS ALB

- Use ACM certificate
- Configure HTTPS listener on port 443
- Redirect HTTP to HTTPS

---

## Security Checklist

### Before Deployment

- [ ] Change all default passwords
- [ ] Set `NODE_ENV=production`
- [ ] Use strong JWT_SECRET (32+ chars)
- [ ] Configure CORS_ORIGINS (not `*`)
- [ ] Enable HTTPS only
- [ ] Set secure headers (handled by Helmet)
- [ ] Review rate limiting settings
- [ ] Verify Stripe webhook secret

### Database Security

- [ ] Use non-default database user
- [ ] Enable SSL for database connections
- [ ] Restrict database network access
- [ ] Regular backups enabled
- [ ] Enable audit logging

### Infrastructure

- [ ] Private subnets for database
- [ ] Security groups configured
- [ ] IAM roles with least privilege
- [ ] Secrets in Secrets Manager (not env vars)
- [ ] Enable CloudWatch/monitoring

---

## Monitoring

### Health Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness probe - server running |
| `GET /health/ready` | Readiness probe - DB connected |
| `GET /health/live` | Alias for /health |

### CloudWatch Metrics (AWS)

```bash
# Create log group
aws logs create-log-group --log-group-name /ecs/license-server

# Set retention
aws logs put-retention-policy \
  --log-group-name /ecs/license-server \
  --retention-in-days 30
```

### Key Metrics to Monitor

- Request latency (p50, p95, p99)
- Error rate (5xx responses)
- Database connection pool usage
- Memory and CPU utilization
- License validation rate
- Stripe webhook success rate

### Alerts

Configure alerts for:
- Error rate > 1%
- Latency p99 > 2s
- Database connections > 80%
- Health check failures
- Stripe webhook failures

---

## Troubleshooting

### Common Issues

#### Database Connection Failed

```bash
# Check connectivity
psql -h HOST -U USER -d license_server -c "SELECT 1"

# Check environment variable
echo $DATABASE_URL
```

#### Stripe Webhooks Not Working

1. Verify webhook secret matches
2. Check endpoint is accessible
3. Review Stripe Dashboard for failed events
4. Check server logs for signature errors

#### License Validation Failing

```bash
# Test validation endpoint
curl -X POST http://localhost:3000/api/v1/validate \
  -H "Content-Type: application/json" \
  -d '{"licenseKey":"YOUR-LICENSE-KEY"}'
```

#### Email Not Sending

1. Verify Azure AD credentials
2. Check Mail.Send permission granted
3. Verify sender email exists in organization
4. Check logs for authentication errors

### Logs

```bash
# Docker
docker logs license-server

# Kubernetes
kubectl logs -f deployment/license-server -n license-server

# ECS
aws logs tail /ecs/license-server --follow
```

---

## Scaling

### Horizontal Scaling

- Stateless design allows multiple instances
- Use load balancer for distribution
- Share sessions via Redis (if needed)

### Database Scaling

- Use read replicas for read-heavy workloads
- Consider connection pooling (PgBouncer)
- Monitor and tune query performance

### Caching

Consider adding Redis for:
- License validation caching
- Rate limiting (distributed)
- Session storage

---

## Updates and Maintenance

### Rolling Updates (Kubernetes)

```bash
# Update image
kubectl set image deployment/license-server \
  license-server=ACCOUNT.dkr.ecr.REGION.amazonaws.com/license-server:v2.0.0 \
  -n license-server
```

### Database Migrations

```bash
# Run migrations (with downtime)
kubectl exec -it deployment/license-server -n license-server -- \
  npx prisma migrate deploy

# Zero-downtime: Use separate migration job
```

### Backup Before Updates

Always backup database before major updates:

```bash
pg_dump -h HOST -U USER -d license_server > pre_update_backup.sql
```
