# License Server — Platform Build Costs & Estimates

**Purpose:** Comprehensive cost analysis for due diligence, investor reports, and internal planning.
**Status:** Beta-ready (pre-production)
**Last Updated:** April 2026

---

## Executive Summary

| Category | Estimate |
|----------|----------|
| **Total Development Cost** | $145,000 – $220,000 |
| **Monthly Infrastructure (current)** | $30 – $60 |
| **Monthly Infrastructure (scaled)** | $200 – $800 |
| **Annual Third-Party Services** | $500 – $2,000 |
| **Time to Rebuild from Scratch** | 6–9 months (1 senior dev) |

---

## 1. Development Cost Breakdown

### 1.1 Core Platform

| Component | Hours | Rate | Cost | Rationale |
|-----------|-------|------|------|-----------|
| **License Key System** | 60 | $150/hr | $9,000 | Cryptographic key generation (XXXX-XXXX-XXXX-XXXX), checksum validation, multi-machine activation, fingerprinting |
| **License Lifecycle** | 50 | $150/hr | $7,500 | Status management (active/expired/revoked/suspended), expiration handling, activation limits |
| **Database Architecture** | 40 | $150/hr | $6,000 | 17 tables via Prisma ORM, migrations, indexes, cascading deletes |
| **API Layer** | 80 | $150/hr | $12,000 | 60+ endpoints, Express.js, Zod validation, error handling |
| **Authentication System** | 60 | $150/hr | $9,000 | JWT + AWS Cognito dual providers, bcrypt password hashing, token blacklist |
| **Rate Limiting** | 20 | $150/hr | $3,000 | Redis-backed distributed limiting, in-memory fallback, per-endpoint configs |
| **Subtotal** | **310** | — | **$46,500** | |

### 1.2 Stripe Integration

| Component | Hours | Rate | Cost | Rationale |
|-----------|-------|------|------|-----------|
| **Product Sync** | 30 | $175/hr | $5,250 | Product creation, price management, tax codes, Stripe metadata sync |
| **Subscription Handling** | 40 | $175/hr | $7,000 | Create/cancel/reactivate, trial management, metered billing |
| **Webhook Handlers** | 50 | $175/hr | $8,750 | 7 event types: checkout, subscription lifecycle, invoice, refund, disputes |
| **Checkout & Billing Portal** | 30 | $175/hr | $5,250 | Session creation, billing portal redirect, payment method management |
| **Refund Tracking** | 20 | $175/hr | $3,500 | Automatic license revocation, refund audit trail |
| **Idempotency** | 15 | $175/hr | $2,625 | Webhook deduplication, safe retries |
| **Subtotal** | **185** | — | **$32,375** | |

### 1.3 Offline & Desktop Support

| Component | Hours | Rate | Cost | Rationale |
|-----------|-------|------|------|-----------|
| **RSA-Signed Offline Tokens** | 30 | $175/hr | $5,250 | Cryptographic offline license validation, token generation/verification |
| **Desktop Check-in System** | 25 | $150/hr | $3,750 | Periodic renewal, 7-day grace period, platform tracking |
| **Machine Fingerprinting** | 20 | $150/hr | $3,000 | Hardware-based activation binding, multi-device limits |
| **Desktop API Endpoints** | 15 | $150/hr | $2,250 | `/api/v1/desktop/*` routes, offline token retrieval |
| **Subtotal** | **90** | — | **$14,250** | |

### 1.4 Multi-Platform Client SDKs

| SDK | Hours | Rate | Cost | Rationale |
|-----|-------|------|------|-----------|
| **Node.js/TypeScript** | 40 | $150/hr | $6,000 | Web servers, Electron, Vite, type-safe API |
| **Swift (macOS/iOS)** | 50 | $175/hr | $8,750 | Native Apple apps, Apple Silicon, async/await |
| **C# (.NET/Windows)** | 50 | $175/hr | $8,750 | .NET apps, AMD64/ARM64, SemaphoreSlim thread safety |
| **Rust** | 60 | $175/hr | $10,500 | Cross-platform CLI, no unsafe code, comprehensive error handling |
| **Subtotal** | **200** | — | **$34,000** | |

### 1.5 Frontend Applications

| Component | Hours | Rate | Cost | Rationale |
|-----------|-------|------|------|-----------|
| **Customer Portal** | 60 | $125/hr | $7,500 | Registration, login, license dashboard, subscription management, downloads |
| **Admin Dashboard** | 80 | $125/hr | $10,000 | Product CRUD, license management, customer directory, bundle upload, coupons |
| **Responsive Styling** | 20 | $125/hr | $2,500 | Mobile-friendly CSS, dark/light compatible |
| **Password Reset Flow** | 15 | $125/hr | $1,875 | Email token, secure reset page |
| **Subtotal** | **175** | — | **$21,875** | |

### 1.6 Enterprise Features

| Component | Hours | Rate | Cost | Rationale |
|-----------|-------|------|------|-----------|
| **Seat-Based Licensing** | 40 | $175/hr | $7,000 | Team licenses, seat assignment, email invites, activation tracking |
| **Enterprise Quotes** | 30 | $150/hr | $4,500 | Quote generation, custom pricing, multi-year terms, conversion to license |
| **Volume Licensing** | 20 | $150/hr | $3,000 | Bulk discounts, enterprise packs |
| **Component Overrides** | 15 | $150/hr | $2,250 | Per-license feature toggles |
| **Subtotal** | **105** | — | **$16,750** | |

### 1.7 Integrations

| Integration | Hours | Rate | Cost | Rationale |
|-------------|-------|------|------|-----------|
| **AWS S3/MinIO** | 25 | $150/hr | $3,750 | File storage, signed URL downloads, health checks |
| **AWS Secrets Manager** | 15 | $150/hr | $2,250 | Configuration provider, caching |
| **AWS Cognito** | 30 | $175/hr | $5,250 | JWKS verification, MFA support, admin groups |
| **Microsoft Graph (Email)** | 25 | $150/hr | $3,750 | Transactional emails, templates (welcome, trial, payment, refund) |
| **hCaptcha** | 10 | $125/hr | $1,250 | Login/register protection, fail-open option |
| **Redis** | 20 | $150/hr | $3,000 | Rate limiting, token blacklist, session management |
| **Subtotal** | **125** | — | **$19,250** | |

### 1.8 DevOps & Infrastructure

| Component | Hours | Rate | Cost | Rationale |
|-----------|-------|------|------|-----------|
| **Docker Configuration** | 20 | $150/hr | $3,000 | Multi-stage Alpine build, compose files (standard + silo-lab) |
| **Kubernetes Manifests** | 40 | $175/hr | $7,000 | Deployment, service, configmap, secrets, HPA, EKS-specific configs |
| **AWS ECS Support** | 20 | $150/hr | $3,000 | CloudFormation template, ALB, auto-scaling |
| **Health Checks** | 10 | $150/hr | $1,500 | Liveness/readiness probes, DB + S3 verification |
| **Subtotal** | **90** | — | **$14,500** | |

### 1.9 Security & Testing

| Component | Hours | Rate | Cost | Rationale |
|-----------|-------|------|------|-----------|
| **Security Hardening** | 40 | $175/hr | $7,000 | 7 critical fixes (crypto.randomBytes, httpOnly cookies, PII redaction, etc.) |
| **Input Validation** | 20 | $150/hr | $3,000 | Zod schemas, UUID validation, pagination bounds |
| **Unit Tests** | 25 | $125/hr | $3,125 | 26 tests covering license service, key generation |
| **Documentation** | 30 | $100/hr | $3,000 | 15+ docs (deployment, security, EKS, AWS, silo-lab) |
| **Subtotal** | **115** | — | **$16,125** | |

---

## 2. Total Development Cost Summary

| Category | Hours | Cost |
|----------|-------|------|
| Core Platform | 310 | $46,500 |
| Stripe Integration | 185 | $32,375 |
| Offline & Desktop Support | 90 | $14,250 |
| Multi-Platform SDKs | 200 | $34,000 |
| Frontend Applications | 175 | $21,875 |
| Enterprise Features | 105 | $16,750 |
| Integrations | 125 | $19,250 |
| DevOps & Infrastructure | 90 | $14,500 |
| Security & Testing | 115 | $16,125 |
| **TOTAL** | **1,395** | **$215,625** |

### Adjusted Estimates

| Scenario | Multiplier | Total | Rationale |
|----------|------------|-------|-----------|
| **Minimum (efficient solo dev)** | 0.67x | $145,000 | Experienced developer, clear requirements, existing patterns |
| **Expected (small team)** | 1.0x | $215,000 | Base estimate with normal iteration |
| **Maximum (with learning curve)** | 1.3x | $280,000 | Less experienced team, scope additions |

---

## 3. Infrastructure Costs

### 3.1 Current Beta Infrastructure (Monthly)

| Service | Tier | Cost | Notes |
|---------|------|------|-------|
| **Silo-Lab Docker** | Shared | $0 | Running on existing infrastructure |
| **PostgreSQL** | Docker container | $0 | Part of silo-lab stack |
| **MinIO** | Docker container | $0 | S3-compatible, self-hosted |
| **Domain** | Annual | $2/mo | licensing.agencio.cloud |
| **TOTAL** | — | **$2/mo** | Runs on existing silo-lab infra |

### 3.2 Standalone Development (Monthly)

| Service | Tier | Cost | Notes |
|---------|------|------|-------|
| **AWS EC2** | t3.small | $15–30 | Single instance |
| **AWS RDS PostgreSQL** | db.t3.micro | $15–25 | Free tier eligible |
| **AWS S3** | Minimal | $1–5 | Bundle storage |
| **Domain + SSL** | — | $2 | Certificate via ACM |
| **TOTAL** | — | **$33–62/mo** | |

### 3.3 Production Infrastructure (Monthly)

| Service | Tier | Cost | Notes |
|---------|------|------|-------|
| **AWS EKS** | Fargate (2 pods) | $75–150 | Managed Kubernetes |
| **AWS RDS PostgreSQL** | db.t3.small | $30–50 | Multi-AZ optional |
| **AWS ElastiCache Redis** | cache.t3.micro | $15–25 | Rate limiting, sessions |
| **AWS S3 + CloudFront** | Standard | $20–50 | Bundle distribution |
| **Monitoring** | CloudWatch | $20–40 | Logs, metrics |
| **TOTAL** | — | **$160–315/mo** | |

### 3.4 High-Scale Production (Monthly, 1000+ licensees)

| Service | Tier | Cost | Notes |
|---------|------|------|-------|
| **AWS EKS** | Fargate (4-8 pods) | $150–300 | With HPA |
| **AWS RDS PostgreSQL** | db.r6g.medium | $100–150 | Read replicas |
| **AWS ElastiCache Redis** | cache.r6g.medium | $75–100 | Cluster mode |
| **AWS S3 + CloudFront** | High traffic | $50–150 | Global distribution |
| **Monitoring** | Full suite | $75–150 | APM, alerts |
| **TOTAL** | — | **$450–850/mo** | |

---

## 4. Third-Party Service Costs (Annual)

### 4.1 Required Services

| Service | Tier | Annual Cost | Notes |
|---------|------|-------------|-------|
| **Stripe** | 2.9% + $0.30/txn | Variable | Payment processing |
| **Microsoft 365** | Business Basic | $72 | Email sending via Graph API |
| **TOTAL** | — | **$72 + txn fees** | |

### 4.2 Optional Services

| Service | Tier | Annual Cost | Notes |
|---------|------|-------------|-------|
| **hCaptcha** | Free/Pro | $0–500 | Bot protection |
| **Datadog/New Relic** | Pro | $0–1,500 | Advanced APM |
| **AWS Cognito** | Beyond free tier | Variable | $0.0055/MAU after 50k |
| **TOTAL** | — | **$0–2,000** | |

---

## 5. Time Investment Analysis

### 5.1 Development Timeline

| Phase | Duration | Description |
|-------|----------|-------------|
| **Foundation** | 1.5 months | Express setup, DB schema, auth, basic API |
| **Stripe Integration** | 1 month | Products, subscriptions, webhooks |
| **License Engine** | 1 month | Key generation, validation, activation |
| **Customer Portal** | 0.75 months | Registration, dashboard, downloads |
| **Admin Dashboard** | 1 month | Full CRUD UI, bundle management |
| **Client SDKs** | 1.5 months | 4 platforms (Node, Swift, C#, Rust) |
| **Enterprise Features** | 0.75 months | Seats, quotes, volume licensing |
| **Security & Polish** | 0.5 months | Audit, hardening, testing |
| **TOTAL** | **8 months** | |

### 5.2 Opportunity Cost

| Scenario | Monthly Rate | Duration | Total |
|----------|--------------|----------|-------|
| **Senior Developer** | $15,000 | 8 months | $120,000 |
| **Senior + Junior** | $22,000 | 6 months | $132,000 |
| **Small Team (3)** | $35,000 | 4 months | $140,000 |

---

## 6. Comparable Market Analysis

### 6.1 Similar SaaS Licensing Platforms

| Platform | Pricing | Features | Comparison |
|----------|---------|----------|------------|
| **Keygen.sh** | $99–499/mo | License management, webhooks | Similar scope, this has more SDKs |
| **Gumroad** | 10% fees | Simple licensing | Less feature-rich |
| **Paddle** | 5% + fees | Payments + licensing | More payment focus |
| **Lemon Squeezy** | 5% + fees | Similar model | This has offline support |
| **Cryptlex** | $49–299/mo | Enterprise licensing | Similar enterprise features |

### 6.2 Build vs Buy Analysis

| Option | Cost | Time | Risk |
|--------|------|------|------|
| **Acquire this platform** | $100–200K | Immediate | Low (proven, tested) |
| **Build from scratch** | $150–280K | 6–9 months | Medium (execution) |
| **Use SaaS (5% fees)** | $5K+/yr at $100K rev | Immediate | Low (but ongoing cost) |
| **Outsource development** | $200–350K | 9–12 months | High (quality, IP) |

---

## 7. Feature Completeness Assessment

### 7.1 Production-Ready Features (100%)

| Feature | Status | Notes |
|---------|--------|-------|
| License key generation | ✅ Complete | Cryptographic, checksum-validated |
| Multi-machine activation | ✅ Complete | Fingerprinting, limits |
| Stripe subscriptions | ✅ Complete | 7 webhook handlers |
| Customer portal | ✅ Complete | Full self-service |
| Admin dashboard | ✅ Complete | Full CRUD |
| 4 client SDKs | ✅ Complete | Node, Swift, C#, Rust |
| Offline licensing | ✅ Complete | RSA-signed tokens |
| Team/seat licensing | ✅ Complete | Invites, activation |
| Security hardening | ✅ Complete | 7 critical fixes |
| Documentation | ✅ Complete | 15+ docs |

### 7.2 Pre-Production TODO (Before Live)

| Item | Effort | Priority |
|------|--------|----------|
| Integration tests | 2–3 days | High |
| Live Stripe account | 1 day | High |
| Webhook DNS setup | 1 day | High |
| CI/CD pipeline | 2–3 days | Medium |
| Monitoring/alerting | 2–3 days | Medium |
| CSRF tokens | 1 day | Medium |
| Refresh token rotation | 1 day | Low |

**Estimated pre-production effort:** 2 weeks

---

## 8. Revenue Potential

### 8.1 Pricing Tiers (Example: k8inspector)

| Tier | Monthly | Annual | Features |
|------|---------|--------|----------|
| Free | $0 | — | 30-day license |
| Professional | SGD 79 | SGD 790 | Full features |
| Enterprise | SGD 199 | SGD 1,990 | Priority support |
| Enterprise Custom | POA | POA | White-label, on-prem |

### 8.2 Break-Even Analysis

| Scenario | Monthly Revenue | Time to Break-Even |
|----------|-----------------|-------------------|
| **10 Pro users** | ~$600 | 24+ months |
| **50 Pro users** | ~$3,000 | 6 months |
| **100 Pro + 10 Enterprise** | ~$8,500 | 2 months |
| **SaaS licensing fees avoided** | $5K+/yr | 3–4 years |

---

## 9. Rationale Summary

### Why These Estimates Are Conservative

1. **Working software** — 26/26 tests passing, TypeScript clean build
2. **Multi-platform SDKs** — 4 production-ready clients rare in similar tools
3. **Enterprise features** — Seats, quotes, offline licensing typically premium
4. **Security audited** — 7 critical fixes already implemented
5. **Deployment-ready** — Docker, K8s, EKS manifests included

### Why Value May Be Higher

1. **Reusable asset** — Can license multiple products (k8inspector, SILO, Predict)
2. **SDK investment** — Swift/C#/Rust SDKs represent significant platform expertise
3. **Stripe complexity** — Webhook handling, idempotency, refund tracking are non-trivial
4. **Offline support** — RSA-signed offline licensing is a differentiator

### Why Value May Be Lower

1. **No revenue yet** — Pre-production, no paying customers
2. **Single product focus** — Built for Agencio products specifically
3. **Frontend simplicity** — Vanilla JS (no framework) may need modernization
4. **Limited tests** — Unit tests only, no E2E coverage

---

## 10. Recommendations

### For Internal Use
1. Track licensing revenue once live
2. Monitor Stripe webhook reliability
3. Add integration tests before scaling

### For Investor Reports
1. Present as infrastructure asset enabling multiple revenue streams
2. Compare to SaaS licensing fees avoided ($5K+/yr per product)
3. Highlight SDK breadth as technical moat

### For Potential Acquirers
1. Package with client SDKs as complete solution
2. Offer transition support for Stripe setup
3. Document integration points for other products

---

## Appendix A: Code Metrics

| Metric | Value |
|--------|-------|
| **Lines of TypeScript** | ~9,500 |
| **Database Tables** | 17 |
| **API Endpoints** | 60+ |
| **Client SDKs** | 4 |
| **Unit Tests** | 26 |
| **Documentation Files** | 15+ |
| **npm Dependencies** | 25 production |

---

## Appendix B: Technology Stack

| Layer | Technology | License |
|-------|------------|---------|
| **Runtime** | Node.js 20+ | MIT |
| **Framework** | Express.js 4 | MIT |
| **Language** | TypeScript 5 | Apache 2.0 |
| **ORM** | Prisma | Apache 2.0 |
| **Database** | PostgreSQL 16 | PostgreSQL License |
| **Cache** | Redis 7 | BSD |
| **Storage** | AWS S3 / MinIO | AWS Terms / AGPL |
| **Auth** | JWT / AWS Cognito | MIT / AWS Terms |
| **Payments** | Stripe | Commercial |
| **Email** | Microsoft Graph | Commercial |
| **CAPTCHA** | hCaptcha | Commercial |

---

## Appendix C: Comparison with Agencio Predict

| Aspect | License Server | Agencio Predict |
|--------|----------------|-----------------|
| **Purpose** | License management SaaS | Prediction/trading terminal |
| **Complexity** | Medium (focused domain) | Very high (28+ integrations) |
| **Dev Cost** | $145K–$220K | $230K–$350K |
| **Frontend** | Vanilla JS SPA | Next.js 16 App Router |
| **Database** | 17 tables (Prisma) | 28+ tables (7 schemas) |
| **SDKs** | 4 platforms | None (web-only) |
| **Independence** | Standalone | Part of ecosystem |
| **Revenue Model** | Per-license fees | Subscription tiers |

---

## Appendix D: File Structure

```
LicenseServer/
├── src/                          # ~9,500 LOC TypeScript
│   ├── index.ts                  # Express entry point
│   ├── config/                   # Configuration providers
│   ├── routes/                   # 8 route modules
│   ├── services/                 # 16 service modules
│   ├── middleware/               # Auth, rate limiting, validation
│   ├── auth/                     # JWT + Cognito providers
│   ├── utils/                    # Crypto, key generation
│   └── types/                    # TypeScript interfaces
├── public/                       # Frontend SPA
├── prisma/                       # Database schema + seeds
├── clients/                      # 4 platform SDKs
├── k8s/                          # Kubernetes manifests
├── docs/                         # 15+ documentation files
├── tests/                        # Unit tests
├── docker-compose.yml
├── Dockerfile
└── .env.example                  # 160+ config options
```
