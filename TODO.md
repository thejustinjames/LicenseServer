# License Server - TODO

## Remaining Tasks

### Security (High Priority)

> Full details in [docs/SECURITY.md](./docs/SECURITY.md)

- [x] Move JWT tokens from localStorage to httpOnly cookies
- [x] Implement token revocation/blacklist mechanism
- [x] Add Redis-backed distributed rate limiting
- [x] Strengthen password requirements (12+ chars, complexity)
- [x] Add structured logging with pino (replaces console.log)
- [x] Replace inline onclick handlers with event delegation
- [ ] Implement refresh token rotation
- [ ] Remove unsafe-inline from CSP (use nonces)
- [ ] Add CSRF protection
- [ ] Implement account lockout after failed attempts

### Testing
- [ ] Add integration tests for API endpoints
- [ ] Add E2E tests for Stripe checkout flow
- [ ] Add load testing scripts
- [ ] Add security-focused tests (auth bypass, injection)

### CI/CD Pipeline
- [ ] Set up GitHub Actions workflow
- [ ] Automated testing on PR
- [ ] Automated deployment to staging
- [ ] Docker image build and push
- [ ] Secret scanning in CI

### Monitoring & Alerting
- [ ] CloudWatch/Datadog integration
- [ ] Error tracking (Sentry)
- [ ] Performance monitoring
- [ ] Alert rules for critical metrics
- [ ] Security event alerting (failed logins, rate limits)

### Optional Enhancements
- [ ] License transfer between customers
- [ ] Multi-currency support
- [ ] Webhook retry queue with dead letter handling
- [x] Structured logging (winston/pino)
- [ ] OAuth social login (Google, Facebook) - UI ready, backend pending

---

## Completed

See [COMPLETED.md](./COMPLETED.md) for full details on implemented features.

### Recently Completed
- [x] **Silo-Lab Integration & Product Tiers (2026-03-18)**
  - [x] k8inspector product tiers (Free, Pro, Enterprise, Custom, Source)
  - [x] SILO product tiers (Home, Business, Enterprise, Packs, Custom)
  - [x] SILO add-ons (k8inspector Integration, Docker Monitor) - annual only
  - [x] Enterprise Pack pricing: Server $5,000/year + $45/license/year
  - [x] Docker silo-lab integration (`docker-compose.silo.yml`)
  - [x] Nginx reverse proxy config for `licencing.agencio.cloud`
  - [x] DNS configuration for agencio.cloud domain
  - [x] Stripe sandbox sync for all products with SGD pricing
  - [x] Bundle upload/management in admin panel (drag-and-drop)
  - [x] S3/MinIO storage integration for software bundles
  - [x] Fixed frontend pricing display (was hardcoded $9.99)
  - [x] Promo codes enabled in Stripe checkout
- [x] **Extended Stripe Integration (2026-03-17)**
  - [x] One-time payments for perpetual licenses
  - [x] Monthly/Annual billing intervals
  - [x] Coupon management (create, list, update, delete)
  - [x] Promotion codes with restrictions
  - [x] Promo code validation endpoint
  - [x] Admin panel coupon/promo code management UI
- [x] **Authentication & UI Improvements (2026-03-17)**
  - [x] Modern login modal with required authentication
  - [x] Password reset flow (forgot password, email, reset page)
  - [x] CAPTCHA support (hCaptcha integration)
  - [x] Terms of Service page (`/terms.html`)
  - [x] Privacy Policy page (`/privacy.html`)
  - [x] Footer with legal links and social icons
  - [x] Social login buttons (UI ready - Google, Facebook)
  - [x] AWS hosting documentation (`docs/AWS-HOSTING.md`)
- [x] **Security Hardening (2026-03-17)**
  - [x] httpOnly cookie authentication (SameSite=Strict, Secure)
  - [x] Token revocation/blacklist with Redis support
  - [x] Redis-backed distributed rate limiting
  - [x] Strong password requirements (12+ chars, complexity)
  - [x] Structured logging with pino (PII redaction)
  - [x] Event delegation (replaced inline onclick handlers)
  - [x] Request correlation IDs for debugging
- [x] **Security Audit & Fixes (2026-03-17)**
  - [x] Fixed timing attack vulnerability in authentication
  - [x] Removed PII (customer emails) from logs
  - [x] Added webhook idempotency (duplicate event prevention)
  - [x] Added rate limiting to webhook endpoint
  - [x] Generic error messages (no internal details leaked)
  - [x] Secure CORS defaults in .env.example
  - [x] Created security documentation (docs/SECURITY.md)
- [x] Kubernetes deployments (MinIO + PostgreSQL for dev)
- [x] S3/MinIO download integration with 4-hour configurable expiry
- [x] Product download configuration in admin panel (S3 file path)
- [x] Customer download button after purchase
- [x] Product categories with search and filtering
- [x] Favicon support (SVG with gradient logo)
- [x] Admin icon link in navigation for admin users
- [x] In-app error messages (replaced browser alerts)
- [x] RSA key generation for offline licensing
- [x] Microsoft Graph email service (Office 365)
- [x] Unit tests with Vitest
- [x] Production deployment documentation
