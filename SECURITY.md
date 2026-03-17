# Security Policy

> For detailed security documentation, implementation details, and audit results, see [docs/SECURITY.md](docs/SECURITY.md).

## Reporting Security Vulnerabilities

If you discover a security vulnerability in this software, please report it privately to the repository owner. Do not create public issues for security vulnerabilities.

### What to Include

When reporting a vulnerability, please include:

1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Suggested remediation (if any)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 7 days
- **Resolution**: Dependent on severity and complexity

## Security Measures Implemented

This software implements the following security measures:

### Authentication & Authorization
- JWT-based authentication with httpOnly cookies
- Token revocation/blacklist mechanism
- Strong password requirements (12+ characters, complexity)
- Admin role separation
- CAPTCHA protection (hCaptcha)

### Data Protection
- bcrypt password hashing with salt
- Constant-time comparison for authentication
- PII redaction in logs
- Secure session management

### API Security
- Rate limiting (Redis-backed)
- Webhook signature verification (Stripe)
- Input validation with Zod
- CORS configuration
- Request correlation IDs

### Infrastructure
- Environment-based configuration
- No hardcoded credentials
- AWS IAM role support
- Kubernetes secrets support

## Supported Versions

Only the latest version receives security updates.

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |
| Older   | :x:                |

## Confidentiality

This is proprietary software. All security-related communications should be treated as confidential.

---

Copyright (c) 2026 Justin James. All Rights Reserved.
