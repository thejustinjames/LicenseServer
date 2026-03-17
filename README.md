# License Server

A Lemon Squeezy-style license server with Stripe payments, license key management, software distribution via S3, and a customer portal.

## Features

- **License Management**: Generate, validate, activate, and revoke license keys
- **Machine Fingerprinting**: Limit activations per license to prevent sharing
- **Stripe Integration**: Subscription payments with automatic license provisioning
- **Customer Portal**: Self-service license management and downloads
- **Admin API**: Full product and license CRUD operations
- **S3 Downloads**: Signed URLs for secure software distribution
- **Offline Licensing**: RSA-signed tokens for offline validation
- **Rate Limiting**: Protection against brute-force attacks

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

### Admin API (`/api/admin`) - Requires Admin JWT

#### Products
```http
GET    /api/admin/products          # List all products
POST   /api/admin/products          # Create product
GET    /api/admin/products/:id      # Get product
PUT    /api/admin/products/:id      # Update product
DELETE /api/admin/products/:id      # Delete product
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
│   ├── services/             # Business logic
│   ├── middleware/           # Auth & rate limiting
│   ├── utils/                # Helpers
│   └── types/                # TypeScript types
├── clients/
│   ├── node/                 # Node.js/TypeScript SDK
│   ├── swift/                # Swift SDK (macOS/iOS)
│   ├── csharp/               # C# SDK (Windows)
│   └── rust/                 # Rust SDK (cross-platform)
├── prisma/
│   └── schema.prisma         # Database schema
├── docker-compose.yml
├── Dockerfile
└── package.json
```

## Scripts

```bash
npm run dev          # Start development server with hot reload
npm run build        # Build for production
npm run start        # Start production server
npm run db:generate  # Generate Prisma client
npm run db:migrate   # Run migrations
npm run db:push      # Push schema to database
npm run db:studio    # Open Prisma Studio
```

## Docker Deployment

```bash
# Build and run everything
docker-compose up -d

# Or build the image separately
docker build -t license-server .
```

## Security Considerations

- All admin routes require JWT authentication with admin role
- License validation endpoints are rate-limited (60 req/min)
- Authentication endpoints are rate-limited (10 req/15min)
- Stripe webhook signatures are verified
- Passwords are hashed with bcrypt (12 rounds)
- Machine fingerprinting prevents license sharing

## Offline Licensing

For offline validation, generate RSA keys:

```bash
mkdir -p keys
openssl genrsa -out keys/private.pem 2048
openssl rsa -in keys/private.pem -pubout -out keys/public.pem
```

The public key can be embedded in your client application for offline license verification.

## License

MIT
