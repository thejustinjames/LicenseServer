# Security Documentation

This document outlines the security measures implemented in the License Server, known vulnerabilities, and recommended improvements.

## Table of Contents

- [Security Features](#security-features)
- [Authentication & Authorization](#authentication--authorization)
- [API Security](#api-security)
- [Data Protection](#data-protection)
- [Webhook Security](#webhook-security)
- [Security Audit Results](#security-audit-results)
- [Security TODO](#security-todo)
- [Deployment Security Checklist](#deployment-security-checklist)

---

## Security Features

### Implemented Protections

| Feature | Implementation | Location |
|---------|---------------|----------|
| Password Hashing | bcrypt with 12 salt rounds | `customer.service.ts` |
| JWT Authentication | HS256 signed tokens | `src/auth/jwt.auth.ts` |
| SQL Injection Prevention | Prisma ORM (parameterized queries) | All database operations |
| Rate Limiting | In-memory per-IP limiting | `src/middleware/rateLimit.ts` |
| Webhook Signature Verification | Stripe signature validation | `src/routes/webhooks.ts` |
| CSP Headers | Helmet middleware | `src/index.ts` |
| CORS Configuration | Configurable origins | `src/config/cors.ts` |
| Input Validation | Zod schema validation | All route handlers |
| Timing Attack Prevention | Constant-time password comparison | `customer.service.ts` |
| Webhook Idempotency | Event deduplication | `src/routes/webhooks.ts` |

---

## Authentication & Authorization

### JWT Token Security

- **Algorithm**: HS256 (HMAC-SHA256)
- **Expiration**: Configurable via `JWT_EXPIRES_IN` (default: 7 days)
- **Secret Requirements**: Minimum 32 characters
- **Claims**: `id`, `email`, `isAdmin`

```typescript
// Token payload structure
{
  id: string;       // Customer UUID
  email: string;    // Customer email
  isAdmin: boolean; // Admin role flag
  iat: number;      // Issued at
  exp: number;      // Expiration
}
```

### Role-Based Access Control

| Role | Access Level |
|------|-------------|
| Anonymous | Public endpoints only (`/api/v1/*`, `/health`) |
| Customer | Portal endpoints (`/api/portal/*`) |
| Admin | All endpoints including `/api/admin/*` |

### Password Security

- **Hashing**: bcrypt with 12 rounds
- **Minimum Length**: 8 characters
- **Timing-Safe Comparison**: Always performs bcrypt comparison to prevent user enumeration

---

## API Security

### Rate Limiting

| Endpoint Group | Limit | Window |
|---------------|-------|--------|
| Authentication (`/api/portal/auth/*`) | 10 requests | 15 minutes |
| License Validation (`/api/v1/*`) | 60 requests | 1 minute |
| Webhooks (`/webhooks/stripe`) | 100 requests | 1 minute |
| Admin (`/api/admin/*`) | No limit | - |

### Input Validation

All request bodies are validated using Zod schemas before processing:

```typescript
// Example: Registration validation
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
});
```

### Error Handling

- Generic error messages returned to clients
- Detailed errors logged server-side only
- No stack traces exposed in responses
- Validation errors return field names but not internal details

---

## Data Protection

### Sensitive Data Handling

| Data Type | Protection |
|-----------|------------|
| Passwords | bcrypt hashed, never logged |
| JWT Secrets | Environment variable only |
| Stripe Keys | Environment variable only |
| Customer Emails | Not logged (customer IDs used instead) |
| License Keys | Checksummed, cryptographically generated |

### Database Security

- Prisma ORM prevents SQL injection
- UUID primary keys prevent enumeration
- Sensitive fields excluded from default queries

---

## Webhook Security

### Stripe Webhook Protection

1. **Signature Verification**: All webhooks verified using Stripe's signature
2. **Rate Limiting**: 100 requests/minute per IP
3. **Idempotency**: Duplicate events are detected and skipped
4. **Error Isolation**: Webhook failures don't expose internal errors

```typescript
// Webhook flow
1. Verify stripe-signature header
2. Check if event.id already processed
3. Handle event in try-catch
4. Mark event as processed
5. Return 200 OK
```

---

## Security Audit Results

### Audit Date: 2026-03-17

### Fixed Vulnerabilities

| Severity | Issue | Resolution |
|----------|-------|------------|
| HIGH | Timing attack in authentication | Added constant-time comparison |
| HIGH | PII logged in production | Replaced emails with customer IDs |
| HIGH | No webhook idempotency | Added event deduplication |
| HIGH | No webhook rate limiting | Added 100 req/min limit |
| MEDIUM | Error message disclosure | Generic messages to clients |
| MEDIUM | CORS defaults to `*` | Changed default to localhost |

### Secure By Design

| Check | Status |
|-------|--------|
| SQL Injection | Protected (Prisma ORM) |
| Webhook Signature Verification | Implemented |
| Password Hashing | bcrypt 12 rounds |
| JWT Validation | Implemented |
| Admin Authorization | Implemented |

---

## Security TODO

### Critical Priority

- [ ] **Rotate Exposed Credentials**
  - If `.env` was ever committed, rotate all secrets immediately
  - Generate new JWT_SECRET: `openssl rand -base64 32`
  - Rotate Stripe API keys in dashboard
  - Rotate AWS credentials if used

### High Priority (Completed)

- [x] **Move JWT tokens from localStorage to httpOnly cookies**
  - Implemented: httpOnly, Secure, SameSite=Strict cookies
  - Files updated: `src/auth/jwt.auth.ts`, `src/routes/portal.ts`, `public/app.js`, `public/admin.js`
  - Backward compatible: Still supports Authorization header

- [x] **Implement token revocation/blacklist**
  - Implemented: Redis-backed token blacklist (in-memory fallback)
  - Added: Logout endpoint at `/api/portal/auth/logout`
  - Tokens checked against blacklist on every request

- [x] **Add distributed rate limiting**
  - Implemented: Redis-backed rate limiting via ioredis
  - Falls back to in-memory if Redis unavailable
  - Configure with `REDIS_URL` environment variable

- [x] **Strengthen password requirements**
  - Implemented: 12+ chars, uppercase, lowercase, number, special character
  - Added: Password requirements endpoint at `/api/portal/auth/password-requirements`
  - Rejects common passwords and repeated characters

### Medium Priority

- [ ] **Implement refresh token rotation**
  - Short-lived access tokens (15 min)
  - Long-lived refresh tokens (7 days)
  - Rotate refresh token on each use

- [x] **Add audit logging**
  - Implemented: Structured logging with pino
  - Audit events logged for: login, logout, register
  - Request correlation IDs included

- [ ] **Remove unsafe-inline from CSP**
  - Current: `scriptSrc: ["'self'", "'unsafe-inline'"]`
  - Target: Nonce-based inline scripts
  - Requires frontend refactoring

- [ ] **Add CSRF protection**
  - Generate CSRF tokens for state-changing operations
  - Validate on all POST/PUT/DELETE requests
  - Note: SameSite=Strict cookies provide partial protection

- [ ] **Implement account lockout**
  - Lock account after 5 failed login attempts
  - Unlock after 30 minutes or admin intervention
  - Notify user via email

### Low Priority (Completed)

- [x] **Replace console.log with structured logging**
  - Implemented: pino logger with pretty printing in dev
  - Log levels: error, warn, info, debug
  - JSON format in production for log aggregation
  - Automatic PII redaction configured

- [x] **Add request correlation IDs**
  - Implemented: Request ID generated and added to headers
  - Included in all log entries

- [ ] **Implement Content-Security-Policy reporting**
  - Add `report-uri` directive
  - Monitor for CSP violations
  - Gradually tighten policy

- [ ] **Add security headers**
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: geolocation=(), microphone=()`

- [x] **Frontend: Replace inline onclick handlers**
  - Implemented: Event delegation with data attributes
  - Files updated: `public/admin.js`

---

## Deployment Security Checklist

### Pre-Deployment

- [ ] Generate strong JWT_SECRET (32+ random bytes)
- [ ] Set unique ADMIN_PASSWORD (not default)
- [ ] Configure CORS_ORIGINS for production domain
- [ ] Enable HTTPS only (redirect HTTP)
- [ ] Set `NODE_ENV=production`
- [ ] Remove or secure Prisma Studio access
- [ ] Verify `.env` is not in git history

### Production Environment

- [ ] Use managed secrets (AWS Secrets Manager, K8s Secrets)
- [ ] Enable database SSL/TLS
- [ ] Configure firewall rules (allow only necessary ports)
- [ ] Set up log aggregation
- [ ] Enable error tracking (Sentry, etc.)
- [ ] Configure backup strategy for database

### Monitoring

- [ ] Set up alerts for:
  - [ ] High rate of 401/403 errors (brute force attempts)
  - [ ] Webhook signature failures
  - [ ] Database connection failures
  - [ ] High error rates

### Kubernetes-Specific

- [ ] Use ServiceAccount with minimal permissions
- [ ] Enable Pod Security Standards
- [ ] Use NetworkPolicies to restrict traffic
- [ ] Store secrets in K8s Secrets (not ConfigMaps)
- [ ] Enable IRSA for AWS access (no hardcoded credentials)

---

## Reporting Security Issues

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public GitHub issue
2. Email security concerns to [your-security-email]
3. Include steps to reproduce
4. Allow reasonable time for a fix before disclosure

---

## References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [OWASP API Security Top 10](https://owasp.org/www-project-api-security/)
- [Stripe Webhook Security](https://stripe.com/docs/webhooks/signatures)
- [JWT Best Practices](https://datatracker.ietf.org/doc/html/rfc8725)
- [Node.js Security Checklist](https://blog.risingstack.com/node-js-security-checklist/)
