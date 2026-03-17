# License Server Implementation Plan

## Overview
Build a Lemon Squeezy-style license server with Stripe payments, license key management, software distribution via S3, and a customer portal.

## Tech Stack
- **Backend**: Node.js + TypeScript + Express
- **Database**: PostgreSQL with Prisma ORM
- **Auth**: JWT + bcrypt (admin), License keys (customers)
- **Payments**: Stripe (subscriptions, webhooks)
- **Storage**: AWS S3 (software packages)
- **Deployment**: Docker + Docker Compose

---

## Architecture

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                     License Server                          │
├─────────────┬─────────────┬─────────────┬──────────────────┤
│  Admin API  │ Customer    │  License    │  Stripe          │
│  (Products, │ Portal API  │  Validation │  Webhooks        │
│   Licenses) │ (Auth, DL)  │  API        │                  │
├─────────────┴─────────────┴─────────────┴──────────────────┤
│                    Service Layer                            │
├─────────────┬─────────────┬─────────────┬──────────────────┤
│  License    │  Customer   │  Product    │  Payment         │
│  Service    │  Service    │  Service    │  Service         │
├─────────────┴─────────────┴─────────────┴──────────────────┤
│                    PostgreSQL + S3                          │
└─────────────────────────────────────────────────────────────┘
```

---

## Database Schema

### Tables

**products**
- id, name, description, stripe_product_id, stripe_price_id
- validation_mode (ONLINE | OFFLINE | HYBRID)
- license_duration_days (null = perpetual within subscription)
- s3_package_key, version, created_at, updated_at

**customers**
- id, email, password_hash, stripe_customer_id
- name, created_at, updated_at

**licenses**
- id, key (unique), customer_id, product_id
- status (ACTIVE | EXPIRED | REVOKED | SUSPENDED)
- expires_at, last_validated_at
- machine_fingerprint (optional hardware binding)
- created_at, updated_at

**subscriptions**
- id, customer_id, stripe_subscription_id
- status (ACTIVE | CANCELED | PAST_DUE)
- current_period_end, created_at, updated_at

**license_activations**
- id, license_id, machine_fingerprint, ip_address
- activated_at, last_seen_at

---

## API Endpoints

### Admin API (`/api/admin/*`) - JWT Protected

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /products | Create product |
| GET | /products | List products |
| PUT | /products/:id | Update product |
| DELETE | /products/:id | Delete product |
| GET | /licenses | List all licenses |
| POST | /licenses | Manually create license |
| PUT | /licenses/:id | Update/revoke license |
| GET | /customers | List customers |
| GET | /dashboard/stats | Revenue, active licenses, etc. |

### Customer Portal API (`/api/portal/*`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /auth/register | Create account |
| POST | /auth/login | Login, get JWT |
| GET | /me | Get profile |
| GET | /licenses | Get my licenses |
| GET | /downloads/:productId | Get signed S3 URL |
| POST | /billing/portal | Get Stripe billing portal URL |

### License Validation API (`/api/v1/*`) - Public

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /validate | Validate license key |
| POST | /activate | Activate on machine |
| POST | /deactivate | Deactivate machine |

### Stripe Webhooks (`/webhooks/stripe`)

Handle:
- `checkout.session.completed` → Create customer + license
- `customer.subscription.updated` → Update subscription status
- `customer.subscription.deleted` → Expire licenses
- `invoice.payment_failed` → Suspend licenses

---

## License Validation Modes

### Online Validation
```
Client → POST /api/v1/validate
{
  "license_key": "XXXX-XXXX-XXXX-XXXX",
  "machine_fingerprint": "abc123"
}

Response:
{
  "valid": true,
  "product": "MyApp Pro",
  "expires_at": "2025-01-15T00:00:00Z",
  "features": ["feature1", "feature2"]
}
```

### Offline Validation (Signed Token)
License key contains embedded signed JWT:
- Payload: product_id, expires_at, features, customer_id
- Signed with server's private key
- Client validates signature with embedded public key
- Grace period field for offline tolerance

---

## Project Structure

```
/license-server
├── src/
│   ├── index.ts                 # Entry point
│   ├── config/
│   │   ├── index.ts             # Environment config
│   │   └── stripe.ts            # Stripe setup
│   ├── routes/
│   │   ├── admin.ts             # Admin API routes
│   │   ├── portal.ts            # Customer portal routes
│   │   ├── validation.ts        # License validation routes
│   │   └── webhooks.ts          # Stripe webhooks
│   ├── services/
│   │   ├── license.service.ts   # License CRUD + validation
│   │   ├── customer.service.ts  # Customer management
│   │   ├── product.service.ts   # Product management
│   │   ├── payment.service.ts   # Stripe integration
│   │   └── storage.service.ts   # S3 signed URLs
│   ├── middleware/
│   │   ├── auth.ts              # JWT auth middleware
│   │   └── admin.ts             # Admin role check
│   ├── utils/
│   │   ├── license-key.ts       # Key generation
│   │   └── crypto.ts            # Signing for offline
│   └── types/
│       └── index.ts             # TypeScript types
├── prisma/
│   └── schema.prisma            # Database schema
├── docker-compose.yml           # PostgreSQL + app
├── Dockerfile
├── package.json
├── tsconfig.json
└── .env.example
```

---

## Security Considerations

- Rate limiting on validation endpoints
- License key format: `XXXX-XXXX-XXXX-XXXX` (alphanumeric, checksum)
- Machine fingerprinting to prevent sharing
- Webhook signature verification
- Admin routes protected by JWT + role
- HTTPS only in production
- Environment variables for secrets
