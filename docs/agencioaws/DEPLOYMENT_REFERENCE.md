# License Server — Agencio AWS Deployment Reference

This document describes how the **License Server** is currently deployed in the
Agencio AWS account, and how to connect to AWS / the EKS cluster from the
bastion host to verify it is running.

It is a snapshot of the live state observed on **2026-04-25** in the
`ag-np-cluster` (Singapore) preprod environment.

---

## 1. At a glance

| Property | Value |
|---|---|
| Public URL | `https://licensing.agencio.cloud/` |
| AWS account | `772693061584` (Agencio non-prod) |
| Region | `ap-southeast-1` (Singapore) |
| EKS cluster | `ag-np-cluster` |
| Namespace | `preprod` |
| Deployment | `license-server` (2 replicas, HPA 2–10) |
| Service | `license-server` (ClusterIP, port `3030`) |
| Container image | `772693061584.dkr.ecr.ap-southeast-1.amazonaws.com/ag-license-server:latest` |
| Service account | `license-server-sa` (IRSA → `Preprod-LicenseServerService-Role`) |
| Ingress (HTTP/HTTPS) | Public ALB → Kong Gateway → `license-server` Service |
| Kong service | `silo-license` (`/services/silo-license`) |
| Kong route | `silo-license-route`, host `licensing.agencio.cloud`, paths `/` |
| Database | RDS Postgres `agencio-postgres-dev`, DB `agenciosecurity`, schema `license_server` |
| Cache | ElastiCache Serverless (Valkey/Redis) `ag-preprod-k8-services-auth` |
| Object storage | S3 bucket `ag-license-server-assets` |
| Auth | AWS Cognito user pool `ap-southeast-1_y6HkbFYfL` |
| Secrets | AWS Secrets Manager: `preprod/license-server` |

---

## 2. Architecture

```
                          Internet
                              │
                              ▼
        licensing.agencio.cloud (public DNS, TTL 300)
                              │
                              ▼
      ┌─────────────────────────────────────────────┐
      │  Internet-facing ALB (silo-ingress)         │
      │  k8s-konggateway-a7d2c5a3cc-…elb.amazonaws  │
      │  ACM cert covers licensing.agencio.cloud    │
      └─────────────────────────────────────────────┘
                              │  HTTP :80 (TLS terminates at ALB)
                              ▼
      ┌─────────────────────────────────────────────┐
      │  Kong Gateway (preprod ns)                  │
      │  service: silo-license  (host=licensing…)   │
      │  route:   silo-license-route paths=[/]      │
      └─────────────────────────────────────────────┘
                              │  http
                              ▼
      ┌─────────────────────────────────────────────┐
      │  Kubernetes Service: license-server         │
      │  ClusterIP 172.20.101.158:3030              │
      │  → license-server.preprod.svc.cluster.local │
      └─────────────────────────────────────────────┘
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
   ┌──────────────────────┐     ┌──────────────────────┐
   │ Pod: license-server  │ ... │ Pod: license-server  │
   │ Node.js 3030/tcp     │     │ Node.js 3030/tcp     │
   │ SA: license-server-sa│     │ SA: license-server-sa│
   └──────────────────────┘     └──────────────────────┘
                │
                │ IRSA (Preprod-LicenseServerService-Role)
                ▼
   ┌─────────────────┬─────────────────┬─────────────────┬─────────────────┐
   │ Secrets Manager │ S3              │ Cognito         │ RDS / Redis     │
   │ preprod/license │ ag-license-…    │ ap-southeast-1_ │ Postgres + EC   │
   │ -server         │ server-assets   │ y6HkbFYfL       │ Serverless cache│
   └─────────────────┴─────────────────┴─────────────────┴─────────────────┘
```

Notes:
- The `licensing.agencio.cloud` DNS record is **not** in the AWS-managed
  Route53 zone for `agencio.cloud` (which only contains the ACM validation
  CNAME). It is managed at the registrar / external DNS provider and points at
  the public ALB IPs (currently `18.141.36.74`, `47.131.124.33`).
- The ALB is shared (`alb.ingress.kubernetes.io/group.name: kong-gateway`)
  with the silo hostnames in the `silo-ingress` ingress object. The TLS
  certificate covers `licensing.agencio.cloud` and the silo hosts.
- Inside Kong, the route is host-based (`hosts=[licensing.agencio.cloud]`)
  with `preserve_host: true` so the upstream service sees the original Host
  header.
- Pods are ARM/AMD agnostic; the deployment lives on EKS-managed node group
  nodes in `10.2.x.x`.

---

## 3. AWS resources

### IAM
- **Role**: `arn:aws:iam::772693061584:role/Preprod-LicenseServerService-Role`
- Bound to the ServiceAccount `preprod/license-server-sa` via IRSA
  (`eks.amazonaws.com/role-arn` annotation).
- Permissions (per role policy):
  - `secretsmanager:GetSecretValue` on `preprod/license-server`
  - `s3:GetObject` / `s3:PutObject` / `s3:ListBucket` on `ag-license-server-assets`
  - `cognito-idp:*` operations on user pool `ap-southeast-1_y6HkbFYfL`
  - `ecr:*` pull, `logs:*` for CloudWatch.

### Secrets Manager
- **Secret**: `preprod/license-server`
- **Region**: `ap-southeast-1`
- Loaded at runtime by the pods (`USE_AWS_SECRETS_MANAGER=true`,
  `CONFIG_PROVIDER=secrets-manager`). Keys include:
  `DATABASE_URL`, `JWT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_CLIENT_SECRET`,
  `REDIS_HOST`, `REDIS_URL`, `HCAPTCHA_*`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`.
- The Kubernetes `license-server-secret` is a **bootstrap mirror** of the same
  values used for envFrom; the source of truth is Secrets Manager.

### RDS
- Instance host: `agencio-postgres-dev.chkw4mq047ri.ap-southeast-1.rds.amazonaws.com:5432`
- Database: `agenciosecurity`
- Schema: `license_server`
- App user: `license_server_service`
- TLS required (`sslmode=require`).
- Migrations are managed via Prisma (`prisma migrate deploy`), run inside the
  pod or as a one-shot job.

### ElastiCache
- Serverless cache: `ag-preprod-k8-services-auth`
- Endpoint: `ag-preprod-k8-services-auth-stcpju.serverless.apse1.cache.amazonaws.com:6379`
- TLS enabled (`REDIS_TLS=true`), AUTH user `license-server-user`.
- Used for rate-limit counters, session token caching, license check cache.

### S3
- Bucket: `ag-license-server-assets`
- Region: `ap-southeast-1`
- Used for installer/asset downloads, signed URLs (`S3_DOWNLOAD_EXPIRY_HOURS=4`).

### Cognito
- User pool: `ap-southeast-1_y6HkbFYfL`
- Client: `381dr21a72padpvi3lsajt2rfo` (client ID and secret in Secrets Manager).
- `AUTH_PROVIDER=cognito`.

### ECR
- Repo: `772693061584.dkr.ecr.ap-southeast-1.amazonaws.com/ag-license-server`
- Tag in use: `latest`. Image digest of the pod currently running:
  `sha256:1eedd181955237edc4da842154ce3e2ee9c7d6ad9d549e7f362520819dd2c3ee`.
- Build via `Dockerfile.eks` from the repo root.

### ACM / DNS
- ACM cert ARNs attached to the ALB (in `silo-ingress`):
  - `arn:aws:acm:ap-southeast-1:772693061584:certificate/063c3ad2-a678-42e0-a1c3-0b257b05f8ec`
  - `arn:aws:acm:ap-southeast-1:772693061584:certificate/63880ed4-f258-4f1d-9711-96a74373c16d`
- Public DNS for `licensing.agencio.cloud` is configured outside Route53.
- Route53 hosted zone `Z0936277VUE3UEYCNM5V` (`agencio.cloud.`) only holds
  ACM DNS-validation CNAMEs.

---

## 4. Kubernetes resources

All manifests live in `k8s/eks/` of this repo. Applied via `kubectl apply -k`.

| Kind | Name | Notes |
|---|---|---|
| Namespace | `preprod` | shared with rest of Agencio preprod |
| ServiceAccount | `license-server-sa` | IRSA annotation → `Preprod-LicenseServerService-Role` |
| ConfigMap | `license-server-config` | non-secret env vars, Secrets Manager pointer |
| Secret | `license-server-secret` | envFrom mirror of Secrets Manager |
| Secret | `license-server-keys` | optional, mounted at `/app/keys` (RO) |
| Deployment | `license-server` | 2 replicas, image `…/ag-license-server:latest`, ports `3030/tcp` |
| Service | `license-server` | ClusterIP, port 3030 → 3030 |
| HPA | `license-server-hpa` | min=2 max=10, CPU 70% / mem 80% |
| NetworkPolicy | `license-server-network-policy` | restricts ingress/egress |
| Ingress | (none direct) | Traffic comes via `silo-ingress` → kong-gateway service |

The `silo-ingress` ALB Ingress in `preprod` includes the rule:
```
host: licensing.agencio.cloud
backend: service kong-gateway:80
path: /
```
TLS hosts list includes `licensing.agencio.cloud`.

Probes:
- `livenessProbe`: `GET /health/live` every 30s.
- `readinessProbe`: `GET /health/ready` every 10s — checks DB and S3.

Resources per pod:
- requests `cpu=200m`, `memory=256Mi`
- limits   `cpu=1`,    `memory=1Gi`

---

## 5. Kong configuration

Configured directly via the Kong Admin API (no declarative bundle).

```
GET https://kong-admin.preprod.agencio.cloud/services/silo-license
```
```json
{
  "id": "2d1c10ae-e34f-4124-a7a9-80c89365ab70",
  "name": "silo-license",
  "host": "license-server.preprod.svc.cluster.local",
  "port": 3030,
  "protocol": "http",
  "connect_timeout": 30000,
  "read_timeout": 30000,
  "write_timeout": 30000,
  "retries": 2,
  "enabled": true
}
```

```
GET https://kong-admin.preprod.agencio.cloud/services/silo-license/routes
```
```json
{
  "id": "d9e5e43d-4eef-47a9-af36-a40849b356c8",
  "name": "silo-license-route",
  "hosts": ["licensing.agencio.cloud"],
  "paths": ["/"],
  "strip_path": false,
  "preserve_host": true,
  "protocols": ["http", "https"],
  "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
}
```

---

## 6. Connecting from the bastion

This Windows host is **inside the VPC** and is the recommended jump point.

### 6.1 Prereqs already in place
- AWS CLI logged in as `arn:aws:iam::772693061584:user/justin-agencio`
  (verify with `aws sts get-caller-identity`).
- `kubectl` at `/c/Users/justin/bin/kubectl.exe`, kubeconfig already pointing
  at `ag-np-cluster`.
- DNS resolves the public ALB and the internal ALBs (Kong Admin, Konga,
  K8Inspector) directly from this host.

### 6.2 Verify AWS access
```bash
aws sts get-caller-identity
aws eks describe-cluster --name ag-np-cluster --region ap-southeast-1 \
  --query 'cluster.{status:status,version:version,endpoint:endpoint}'
```

If `kubectl` ever loses context, refresh the kubeconfig:
```bash
aws eks update-kubeconfig --name ag-np-cluster --region ap-southeast-1
```

### 6.3 Verify pods / service / HPA
```bash
KCTL=/c/Users/justin/bin/kubectl.exe

# Pods
$KCTL get pods -n preprod -l app=license-server -o wide

# Service + HPA
$KCTL get svc,hpa -n preprod -l app=license-server

# Recent logs (all pods)
$KCTL logs -n preprod -l app=license-server --tail=100 -f
```

Expected: 2 pods `Running`, HPA showing `cpu: <70%/70%, memory: <80%/80%`.

### 6.4 Hit the service three ways

**a) Public hostname (full path: ALB → Kong → Service → Pod)**
```bash
curl -s https://licensing.agencio.cloud/health/live
curl -s https://licensing.agencio.cloud/health/ready
curl -s https://licensing.agencio.cloud/api          # API index
```

**b) Direct from inside the cluster (skip Kong) via K8Inspector**
```bash
curl -s -X POST https://k8inspector.preprod.agencio.cloud/api/network/diagnostics/curl \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://license-server.preprod.svc.cluster.local:3030/health/ready"}'
```

**c) Direct from the bastion via port-forward**
```bash
$KCTL port-forward -n preprod svc/license-server 13030:3030
# in another shell:
curl -s http://localhost:13030/health/ready
```

### 6.5 Verify Kong wiring
```bash
# Service object in Kong
curl -s https://kong-admin.preprod.agencio.cloud/services/silo-license | jq .

# Routes attached to the service
curl -s https://kong-admin.preprod.agencio.cloud/services/silo-license/routes | jq .

# Hit through Kong by Host header (without DNS)
curl -s -H 'Host: licensing.agencio.cloud' \
  https://kong-admin.preprod.agencio.cloud/../  # not useful — use konggw

curl -s -H 'Host: licensing.agencio.cloud' https://konggw.preprod.agencio.cloud/health/ready
```

### 6.6 Inspect Secrets Manager (read-only)
```bash
aws secretsmanager describe-secret \
  --secret-id preprod/license-server --region ap-southeast-1

# Print just the keys, not the values
aws secretsmanager get-secret-value \
  --secret-id preprod/license-server --region ap-southeast-1 \
  --query 'SecretString' --output text | jq 'keys'
```

### 6.7 Database / Redis sanity (from a pod)
```bash
# Open a shell inside one of the pods
$KCTL exec -it -n preprod deploy/license-server -- sh

# Inside the pod:
node -e "console.log(process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@'))"
npx prisma migrate status   # if Prisma is bundled
```

### 6.8 ECR / image
```bash
aws ecr describe-images --region ap-southeast-1 \
  --repository-name ag-license-server \
  --query 'reverse(sort_by(imageDetails,& imagePushedAt))[:5].[imageTags,imagePushedAt,imageDigest]' \
  --output table
```

---

## 7. CI/CD

**Status as of 2026-04-25: there is no automated CI/CD for the License Server.**

What was checked and found absent:

| System | Result |
|---|---|
| `.github/workflows/` | does not exist in the repo |
| Jenkinsfile / `.gitlab-ci.yml` / `azure-pipelines.yml` / `buildspec.yml` | none present |
| AWS CodeBuild projects (account `772693061584`, `ap-southeast-1`) | no project matching `licens*` |
| AWS CodePipeline pipelines | no pipeline matching `licens*` |
| ArgoCD / Flux GitOps | not in use for this workload |
| ECR push history | one image pushed manually on 2026-04-24 (tags `latest`, `dev`, `dev-2`, digest `sha256:1eedd181…dd2c3ee`) |

Implications:
- Image promotion is **manual**: build locally → `docker push` to ECR → `kubectl rollout restart` (or re-`apply -k`) on the cluster.
- The `latest` tag is mutable and is what the live deployment pulls
  (`imagePullPolicy: Always`), so a fresh push + rollout restart updates prod.
- There is **no test gate, no security scan, no signing, no GitOps reconciliation** between repo state and cluster state.
- Drift between `k8s/eks/*.yaml` in git and what is actually applied is possible
  and not currently detected. `kubectl diff -k k8s/eks/` from the bastion is the
  way to check.

If/when CI/CD is added, the natural shape (matching the rest of the Agencio
estate) would be:
1. **GitHub Actions** workflow on push to `main`:
   - `npm ci && npm test && npx prisma validate`
   - `docker build -f Dockerfile.eks` → push to ECR with tag `git-${SHA}` and `latest`.
   - Authenticate to AWS via OIDC role (no long-lived keys).
2. **Deploy step**: either
   - `aws eks update-kubeconfig` + `kubectl set image deploy/license-server …:git-${SHA}` + `kubectl rollout status`, or
   - commit the new tag into `k8s/eks/kustomization.yaml` (`images.newTag`) and let an ArgoCD app reconcile it.
3. **Migrations**: a separate Job (or `prisma migrate deploy` init container) gated on the new image, before pods serve traffic.

Until that exists, treat any deploy as a manual change-controlled action.

## 8. Deploy / update flow (manual, current process)

The end-to-end flow used today (from this repo on the bastion or from a dev
machine with AWS + kubectl + docker access):

```bash
cd LicenseServer/k8s/eks

# Build, push, deploy, status
./deploy.sh all

# OR step-by-step
./deploy.sh build       # docker build + ECR push (Dockerfile.eks)
./deploy.sh deploy      # kubectl apply -k . + rollout status
./deploy.sh status      # pods/svc/hpa/recent logs
```

After `deploy.sh deploy`, the `imagePullPolicy: Always` setting plus the
floating `latest` tag means a `kubectl rollout restart deploy/license-server`
will pick up a freshly pushed image. Prefer pushing an immutable tag (e.g.
git SHA) and updating `kustomization.yaml` `images.newTag` for production
work.

Rollback:
```bash
$KCTL rollout history deploy/license-server -n preprod
$KCTL rollout undo    deploy/license-server -n preprod
```

---

## 9. Common troubleshooting

| Symptom | First checks |
|---|---|
| Public URL 502/504 | `kubectl get pods -n preprod -l app=license-server`; pod readiness; ALB target health in EC2 console for the silo-ingress ALB. |
| Pods `CrashLoopBackOff` | `kubectl logs -n preprod -l app=license-server --previous`; missing/invalid keys in `preprod/license-server` secret. |
| `database` reporting bad in `/health/ready` | RDS reachability from EKS SGs; check `DATABASE_URL` host/credentials in Secrets Manager; `npx prisma migrate status` inside a pod. |
| `s3` reporting bad in `/health/ready` | IRSA role attached? `kubectl describe sa -n preprod license-server-sa` should show the `eks.amazonaws.com/role-arn` annotation; verify role policy still has access to `ag-license-server-assets`. |
| 401 on Cognito-protected routes | `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` mismatch in Secrets Manager vs. user pool `ap-southeast-1_y6HkbFYfL`. |
| Public hostname not resolving | DNS is at the registrar — confirm A/CNAME for `licensing.agencio.cloud` still points at the kong-gateway ALB. From the bastion: `nslookup licensing.agencio.cloud` should return the same IPs as `nslookup k8s-konggateway-a7d2c5a3cc-792126770.ap-southeast-1.elb.amazonaws.com`. |
| Kong route gone / 404 from Kong | `curl https://kong-admin.preprod.agencio.cloud/services/silo-license` and `…/routes`; recreate per section 5 if missing. |

---

## 10. Files & references

- Helm/manifests: `k8s/eks/`
- Build script: `k8s/eks/deploy.sh`
- Container build: `Dockerfile.eks`
- Existing public deployment guide: `docs/EKS-DEPLOYMENT.md` (template/how-to)
- This document: `docs/agencioaws/DEPLOYMENT_REFERENCE.md` (live state, 2026-04-25)
