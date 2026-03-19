# License Server

> **PROPRIETARY SOFTWARE** - Copyright (c) 2026 Justin James. All Rights Reserved.
>
> This software is confidential and proprietary. Unauthorized copying, distribution, or use is strictly prohibited. See [LICENSE](LICENSE) for details.

A Lemon Squeezy-style license server with Stripe payments, license key management, software distribution via S3, and a customer portal.

## Features

- **License Management**: Generate, validate, activate, and revoke license keys
- **Machine Fingerprinting**: Limit activations per license to prevent sharing
- **Stripe Integration**: Subscriptions & one-time payments with automatic license provisioning
- **Coupon & Promo Codes**: Create discount coupons and shareable promo codes
- **Monthly/Annual Billing**: Support for different billing intervals
- **Customer Portal**: Self-service license management and downloads
- **Admin Dashboard**: Full product, license, and coupon management UI (`/admin.html`)
- **Bundle Management**: Upload, manage, and distribute software packages via S3/MinIO
- **Product Categories**: Organize products with categories, search, and filtering
- **Admin API**: Full product, license, and coupon CRUD operations
- **S3 Downloads**: Signed URLs for secure software distribution (4-hour expiry)
- **MinIO Support**: S3-compatible storage for local development
- **Offline Licensing**: RSA-signed tokens for offline validation
- **Email Notifications**: Microsoft Graph / Office 365 integration
- **Rate Limiting**: Protection against brute-force attacks
- **Security Hardened**: httpOnly cookies, token revocation, Redis rate limiting
- **Silo-Lab Integration**: Docker deployment with nginx reverse proxy and DNS

## Tech Stack

- **Backend**: Node.js + TypeScript + Express
- **Database**: PostgreSQL with Prisma ORM
- **Auth**: JWT + bcrypt
- **Payments**: Stripe
- **Storage**: AWS S3
- **Deployment**: Docker + Docker Compose

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- Stripe account (for payments)
- AWS account (for S3 downloads, optional)

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd license-server

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Start PostgreSQL
docker-compose up -d postgres

# Generate Prisma client
npm run db:generate

# Push schema to database
npm run db:push

# Start development server
npm run dev
```

### Environment Variables

Edit `.env` with your configuration:

```env
# Database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/license_server"

# JWT (min 32 characters)
JWT_SECRET=your-super-secret-jwt-key-change-in-production
JWT_EXPIRES_IN=7d

# Admin credentials
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=your-secure-password

# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_SUCCESS_URL=http://localhost:3000/success
STRIPE_CANCEL_URL=http://localhost:3000/cancel

# AWS S3 (optional)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
S3_BUCKET_NAME=your-bucket
```

## API Reference

### Public License Validation (`/api/v1`)

#### Validate License
```http
POST /api/v1/validate
Content-Type: application/json

{
  "licenseKey": "XXXX-XXXX-XXXX-XXXX",
  "machineFingerprint": "optional-fingerprint"
}
```

Response:
```json
{
  "valid": true,
  "product": "MyApp Pro",
  "expiresAt": "2025-01-15T00:00:00Z",
  "features": ["feature1", "feature2"]
}
```

#### Activate License
```http
POST /api/v1/activate
Content-Type: application/json

{
  "licenseKey": "XXXX-XXXX-XXXX-XXXX",
  "machineFingerprint": "unique-machine-id",
  "machineName": "My Computer"
}
```

#### Deactivate License
```http
POST /api/v1/deactivate
Content-Type: application/json

{
  "licenseKey": "XXXX-XXXX-XXXX-XXXX",
  "machineFingerprint": "unique-machine-id"
}
```

### Customer Portal (`/api/portal`)

#### Register
```http
POST /api/portal/auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword",
  "name": "John Doe"
}
```

#### Login
```http
POST /api/portal/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword"
}
```

#### Get My Licenses
```http
GET /api/portal/licenses
Authorization: Bearer <token>
```

#### Get Download URL
```http
GET /api/portal/downloads/:productId
Authorization: Bearer <token>
```

#### Create Checkout Session
```http
POST /api/portal/billing/checkout
Authorization: Bearer <token>
Content-Type: application/json

{
  "productId": "uuid"
}
```

### Admin Dashboard

Access the admin dashboard at `/admin.html` to manage:
- **Products**: Create, edit, delete with Stripe integration and categories
- **Licenses**: Create, suspend, revoke, reactivate
- **Customers**: View customer list
- **Subscriptions**: View subscription status
- **Refunds**: Track refunds and license revocations

Admin users see a gear icon in the navigation bar linking to the dashboard.

### Admin API (`/api/admin`) - Requires Admin JWT

#### Products
```http
GET    /api/admin/products              # List all products
GET    /api/admin/products?search=term  # Search products by name/description
GET    /api/admin/products?category=X   # Filter by category
GET    /api/admin/products/categories   # List all categories
POST   /api/admin/products              # Create product
GET    /api/admin/products/:id          # Get product
PUT    /api/admin/products/:id          # Update product
DELETE /api/admin/products/:id          # Delete product
```

#### Licenses
```http
GET    /api/admin/licenses              # List all licenses
POST   /api/admin/licenses              # Create license
GET    /api/admin/licenses/:id          # Get license
PUT    /api/admin/licenses/:id          # Update license
POST   /api/admin/licenses/:id/revoke   # Revoke license
POST   /api/admin/licenses/:id/suspend  # Suspend license
POST   /api/admin/licenses/:id/reactivate # Reactivate license
```

#### Customers
```http
GET /api/admin/customers      # List all customers
GET /api/admin/customers/:id  # Get customer
```

#### Dashboard
```http
GET /api/admin/dashboard/stats  # Get statistics
```

#### Bundle Management
```http
POST   /api/admin/products/:id/upload      # Upload bundle file (multipart/form-data)
GET    /api/admin/products/:id/bundles     # List all bundles for product
PUT    /api/admin/products/:id/bundle      # Set active bundle (s3Key in body)
DELETE /api/admin/products/:id/bundles/:key # Delete bundle file
```

### Webhooks

```http
POST /webhooks/stripe  # Stripe webhook endpoint
```

Handled events:
- `checkout.session.completed` - Creates customer and license
- `customer.subscription.updated` - Updates subscription status
- `customer.subscription.deleted` - Expires licenses
- `invoice.payment_failed` - Suspends licenses

## License Key Format

Keys use the format `XXXX-XXXX-XXXX-XXXX` with:
- Alphanumeric characters (excluding ambiguous: 0, 1, I, O, L)
- Built-in checksum for validation
- Cryptographically secure generation

## Client SDKs

Ready-to-use client libraries for integrating license validation:

| Platform | Language | Directory | Use Case |
|----------|----------|-----------|----------|
| **Node.js/Vite** | TypeScript | `clients/node/` | Web servers, Electron, Vite builds |
| **macOS** | Swift | `clients/swift/` | Native Mac apps (Apple Silicon) |
| **Windows** | C# | `clients/csharp/` | .NET apps (AMD64/ARM64) |
| **Cross-platform** | Rust | `clients/rust/` | Native apps, CLI tools |

### Example: Node.js

```typescript
import { LicenseClient } from '@license-server/client';

const client = new LicenseClient({ serverUrl: 'https://license.example.com' });
const result = await client.validate('XXXX-XXXX-XXXX-XXXX');

if (result.valid) {
  console.log(`Features: ${result.features?.join(', ')}`);
}
```

### Example: Swift (macOS)

```swift
let client = LicenseClient(config: LicenseClientConfig(
    serverUrl: "https://license.example.com"
))
let result = await client.validate(licenseKey: "XXXX-XXXX-XXXX-XXXX")
```

### Example: C# (Windows)

```csharp
var client = new LicenseClient(new LicenseClientConfig {
    ServerUrl = "https://license.example.com"
});
var result = await client.ValidateAsync("XXXX-XXXX-XXXX-XXXX");
```

See [`clients/README.md`](clients/README.md) for full documentation.

## Project Structure

```
/license-server
├── src/
│   ├── index.ts              # Express app entry
│   ├── config/               # Configuration
│   ├── routes/               # API routes
│   ├── services/             # Business logic (incl. storage.service.ts)
│   ├── middleware/           # Auth & rate limiting
│   ├── utils/                # Helpers
│   └── types/                # TypeScript types
├── public/
│   ├── index.html            # Customer portal
│   ├── admin.html            # Admin dashboard
│   ├── favicon.svg           # Site favicon
│   ├── app.js                # Customer portal JS
│   ├── admin.js              # Admin dashboard JS
│   └── styles.css            # Stylesheets
├── clients/
│   ├── node/                 # Node.js/TypeScript SDK
│   ├── swift/                # Swift SDK (macOS/iOS)
│   ├── csharp/               # C# SDK (Windows)
│   └── rust/                 # Rust SDK (cross-platform)
├── prisma/
│   ├── schema.prisma         # Database schema
│   ├── seed-k8inspector.ts   # k8inspector product seeding
│   ├── seed-silo.ts          # SILO product seeding
│   └── sync-stripe.ts        # Stripe product sync
├── keys/                     # RSA keys for offline licensing
├── k8s/                      # Kubernetes manifests
├── docs/                     # Documentation
├── docker-compose.yml        # Standard deployment
├── docker-compose.silo.yml   # Silo-lab integration
├── Dockerfile
└── package.json
```

## Scripts

```bash
npm run dev            # Start development server with hot reload
npm run build          # Build for production
npm run start          # Start production server
npm run db:generate    # Generate Prisma client
npm run db:migrate     # Run migrations
npm run db:push        # Push schema to database
npm run db:studio      # Open Prisma Studio
npm run seed:k8inspector # Seed k8inspector products
npm run seed:silo      # Seed SILO products
npm run seed:all       # Seed all products
npm run sync:stripe    # Sync products to Stripe
npm test               # Run unit tests
npm run test:watch     # Run tests in watch mode
npm run test:coverage  # Run tests with coverage report
```

## Docker Deployment

```bash
# Build and run everything
docker-compose up -d

# Or build the image separately
docker build -t license-server .
```

### Silo-Lab Deployment

For integration with silo-lab infrastructure at `licencing.agencio.cloud`:

```bash
# Start with silo-lab network integration
docker-compose -f docker-compose.silo.yml up -d

# Run database migrations
docker exec license-server npx prisma db push

# Seed products
docker exec license-server npm run seed:k8inspector
docker exec license-server npm run seed:silo
```

This connects to:
- **silo-nginx** (172.30.0.5) - SSL termination at `https://licencing.agencio.cloud`
- **silo-storage** (172.30.0.12) - MinIO for software bundles
- **silo-redis** (172.30.0.15) - Rate limiting and token blacklist
- **silo-dns** (172.30.0.2) - Internal DNS resolution

## Product Tiers

### k8inspector
| Tier | Price | Features |
|------|-------|----------|
| Free | SGD 0/month | Basic inspection, CLI access, 30-day license |
| Professional | SGD 79/month or SGD 790/year | Advanced inspection, API access, offline mode |
| Enterprise | SGD 199/month or SGD 1,990/year | SSO, audit logs, team management |
| Enterprise Custom | POA | Custom integration, on-premise, SLA |
| Enterprise Source | POA | Source code access, white-label |

### SILO
| Tier | Price | Features |
|------|-------|----------|
| Home (Windows/macOS) | SGD 99 one-time | 1-year license, 1 machine, basic modules |
| Business | SGD 199/month or SGD 1,990/year | 5 machines, all modules, priority support |
| Enterprise | SGD 499/month or SGD 4,990/year | Unlimited machines, SSO, dedicated support |
| Enterprise Pack 5 | SGD 5,225/year | Server + 5 seat licenses |
| Enterprise Pack 10 | SGD 5,450/year | Server + 10 seat licenses |
| Enterprise Pack 20 | SGD 5,900/year | Server + 20 seat licenses |
| Enterprise Pack 50 | SGD 7,250/year | Server + 50 seat licenses |
| Enterprise Custom | POA | On-premise, air-gapped, white-label |

### SILO Add-ons (Annual Only)
| Add-on | Price | Features |
|--------|-------|----------|
| k8inspector Integration | SGD 490/year | Kubernetes inspection for SILO |
| Docker Monitor | SGD 290/year | Container monitoring and security |

## Security Considerations

- All admin routes require JWT authentication with admin role
- License validation endpoints are rate-limited (60 req/min)
- Authentication endpoints are rate-limited (10 req/15min)
- Webhook endpoints are rate-limited (100 req/min) with idempotency checks
- Stripe webhook signatures are verified
- Passwords are hashed with bcrypt (12 rounds)
- Machine fingerprinting prevents license sharing
- Constant-time password comparison prevents timing attacks
- Generic error messages prevent information disclosure

For a comprehensive security overview, audit results, and deployment checklist, see [docs/SECURITY.md](docs/SECURITY.md).

## Kubernetes Deployment

Deploy to Kubernetes using Kustomize:

```bash
# Production deployment
kubectl apply -k k8s/

# Development deployment (includes MinIO + PostgreSQL)
kubectl apply -k k8s/overlays/dev/
```

The K8s manifests include:
- **Deployment**: License server with health probes
- **Service**: ClusterIP service
- **ConfigMap**: Environment configuration
- **Secret**: Sensitive credentials (template)
- **ServiceAccount**: For IRSA (EKS)
- **HPA**: Horizontal Pod Autoscaler
- **MinIO**: S3-compatible storage (dev only)
- **PostgreSQL**: Database (dev only)

For production, use managed services (RDS, S3) and configure via environment variables or AWS Secrets Manager.

## Offline Licensing

For offline validation, generate RSA keys:

```bash
mkdir -p keys
openssl genrsa -out keys/private.pem 2048
openssl rsa -in keys/private.pem -pubout -out keys/public.pem
```

The public key can be embedded in your client application for offline license verification.

## License

**Proprietary Software** - Copyright (c) 2026 Justin James. All Rights Reserved.

This software is proprietary and confidential. No license is granted for use, copying, modification, or distribution without prior written consent from the copyright holder.

See [LICENSE](LICENSE) for full terms.
