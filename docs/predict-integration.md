# Agencio Predict Integration

**Version:** 1.0
**Last Updated:** 2026-05-12
**Status:** Production Ready

---

## Overview

The License Server provides billing and licensing services to Agencio Predict:
- **Customer Management** - External customer creation and linking
- **AI Credits** - Pay-per-use token billing with reserve/consume pattern
- **Subscription Management** - Plan checkout and billing portal
- **Deployment Validation** - License verification and anti-piracy

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        AGENCIO PREDICT (Vercel)                         │
│                        predict.agencio.cloud                            │
│                                                                         │
│  User Registration → Customer Creation                                  │
│  Billing Page → Credit Checkout                                         │
│  LLM Calls → Credit Reserve/Consume                                     │
│  App Startup → Deployment Validation                                    │
│                                                                         │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ HTTPS + API Key Auth
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        LICENSE SERVER (AWS EKS)                         │
│                        licensing.agencio.cloud                          │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                     PORTAL ROUTES (/api/portal)                   │  │
│  │                                                                   │  │
│  │  POST /customers           Create external customer               │  │
│  │  GET  /customers/:id       Get customer by external ID            │  │
│  │  GET  /credits             Get credit balance                     │  │
│  │  GET  /credits/packages    List credit packages                   │  │
│  │  POST /credits/checkout    Create Stripe checkout                 │  │
│  │  POST /credits/reserve     Reserve credits before LLM call        │  │
│  │  POST /credits/consume     Consume credits after LLM call         │  │
│  │  POST /credits/release     Release reservation on failure         │  │
│  │  PUT  /credits/auto-refill Configure auto-refill                  │  │
│  │  POST /billing/checkout    Subscription checkout                  │  │
│  │  POST /billing/portal      Billing portal session                 │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                  DEPLOYMENT ROUTES (/api/deployments)             │  │
│  │                                                                   │  │
│  │  POST /validate            Validate deployment on startup         │  │
│  │  POST /heartbeat           Periodic check-in                      │  │
│  │  POST /register            Register new deployment (admin)        │  │
│  │  POST /:id/kill            Remote kill deployment (admin)         │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                     STRIPE WEBHOOKS (/webhooks)                   │  │
│  │                                                                   │  │
│  │  checkout.session.completed → Create license / Add credits        │  │
│  │  charge.refunded            → Process refund                      │  │
│  │  subscription.*             → Sync subscription status            │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                     │                                   │
│                                     ▼                                   │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    WEBHOOK DISPATCH TO PREDICT                    │  │
│  │                                                                   │  │
│  │  POST predict.agencio.cloud/api/predict/v1/billing/webhooks/     │  │
│  │       license-server                                              │  │
│  │                                                                   │  │
│  │  Events: credit.purchased, credit.consumed, credit.refunded,     │  │
│  │          subscription.created, subscription.updated, etc.        │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Environment Variables

### Required on License Server

| Variable | Description | Example |
|----------|-------------|---------|
| `ADMIN_API_KEY` | Server-to-server API key (32+ chars) | `your-secure-api-key-here` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://...` |
| `STRIPE_SECRET_KEY` | Stripe API secret | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature secret | `whsec_...` |
| `JWT_SECRET` | JWT signing secret | `<256-bit secret>` |

### Shared with Predict

| Variable (License Server) | Variable (Predict) | Purpose |
|---------------------------|-------------------|---------|
| `ADMIN_API_KEY` | `LICENSE_SERVER_API_KEY` | Server-to-server auth |
| - | `LICENSE_SERVER_URL` | License Server URL |
| - | `LICENSE_SERVER_WEBHOOK_SECRET` | Webhook verification |
| - | `DEPLOYMENT_KEY` | Deployment validation |

---

## Database Schema

### Customer Model (with External ID)

```prisma
model Customer {
  id                  String    @id @default(uuid())
  email               String    @unique
  passwordHash        String    @map("password_hash")
  stripeCustomerId    String?   @unique @map("stripe_customer_id")
  name                String?

  // External system linkage (Predict)
  externalId          String?   @unique @map("external_id")
  externalSource      String?   @map("external_source")

  // ... other fields
  creditBalance       CreditBalance?

  @@map("customers")
}
```

### Credit Balance Model

```prisma
model CreditBalance {
  id         String @id @default(uuid())
  customerId String @unique @map("customer_id")

  // Link to Predict user
  predictUserId String? @unique @map("predict_user_id")
  predictOrgId  String? @map("predict_org_id")

  // Balance in cents
  availableCents         BigInt @default(0) @map("available_cents")
  reservedCents          BigInt @default(0) @map("reserved_cents")
  lifetimePurchasedCents BigInt @default(0) @map("lifetime_purchased_cents")
  lifetimeUsedCents      BigInt @default(0) @map("lifetime_used_cents")

  // Auto-refill configuration
  autoRefillEnabled         Boolean @default(false)
  autoRefillPackageId       String?
  autoRefillThresholdCents  Int?
  autoRefillMaxCount        Int     @default(3)
  autoRefillCurrentCount    Int     @default(0)

  customer     Customer      @relation(fields: [customerId], references: [id])
  transactions CreditTransaction[]

  @@map("credit_balances")
}
```

### Migration: External Customer Fields

```sql
-- prisma/migrations/add_external_customer_fields.sql

ALTER TABLE customers
ADD COLUMN IF NOT EXISTS external_id VARCHAR(255) UNIQUE;

ALTER TABLE customers
ADD COLUMN IF NOT EXISTS external_source VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_customers_external_id
ON customers(external_id);
```

---

## API Endpoints for Predict

### Customer Management

#### Create External Customer

Creates or links a customer from Predict.

```http
POST /api/portal/customers
X-API-Key: <ADMIN_API_KEY>
Content-Type: application/json

{
  "externalId": "predict-user-uuid",
  "email": "user@example.com",
  "name": "John Doe",
  "source": "predict"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "license-server-customer-id",
    "externalId": "predict-user-uuid",
    "email": "user@example.com",
    "name": "John Doe",
    "stripeCustomerId": "cus_xxx",
    "createdAt": "2026-05-12T00:00:00.000Z"
  }
}
```

**Behavior:**
- Idempotent: returns existing customer if `externalId` already exists
- Links by email: if email exists, adds `externalId` to existing customer
- Creates Stripe customer automatically

#### Get Customer by External ID

```http
GET /api/portal/customers/:externalId
X-API-Key: <ADMIN_API_KEY>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "license-server-customer-id",
    "externalId": "predict-user-uuid",
    "email": "user@example.com",
    "stripeCustomerId": "cus_xxx"
  }
}
```

---

### Credit Operations

#### Get Credit Balance

```http
GET /api/portal/credits
Authorization: Bearer <user-jwt>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "available": 10000,
    "reserved": 500,
    "effective": 9500,
    "lifetime": {
      "purchased": 50000,
      "consumed": 40000,
      "bonus": 5000,
      "refunded": 0
    },
    "autoRefill": {
      "enabled": true,
      "amount": 10000,
      "trigger": 1000,
      "packageId": "pkg-uuid"
    }
  }
}
```

#### List Credit Packages

```http
GET /api/portal/credits/packages
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "pkg-uuid",
      "name": "Starter Pack",
      "creditAmountCents": 10000,
      "priceCents": 1000,
      "bonusCents": 500,
      "isActive": true,
      "isFeatured": true
    }
  ]
}
```

#### Create Credit Checkout

```http
POST /api/portal/credits/checkout
Authorization: Bearer <user-jwt>
Content-Type: application/json

{
  "packageId": "pkg-uuid",
  "successUrl": "https://predict.agencio.cloud/settings/ai-billing/credits?success=true",
  "cancelUrl": "https://predict.agencio.cloud/settings/ai-billing/credits?canceled=true"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "checkoutUrl": "https://checkout.stripe.com/c/pay/...",
    "sessionId": "cs_xxx"
  }
}
```

#### Reserve Credits (Pre-LLM Call)

```http
POST /api/portal/credits/reserve
Authorization: Bearer <user-jwt>
Content-Type: application/json

{
  "amountCents": 100,
  "idempotencyKey": "llm-call-uuid"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "reservationId": "res-uuid",
    "amountReserved": 100,
    "available": 9900
  }
}
```

#### Consume Credits (Post-LLM Call)

```http
POST /api/portal/credits/consume
Authorization: Bearer <user-jwt>
Content-Type: application/json

{
  "reservationId": "res-uuid",
  "amountCents": 85,
  "usage": {
    "externalCallId": "predict-call-uuid",
    "model": "claude-3-opus",
    "provider": "anthropic",
    "inputTokens": 1000,
    "outputTokens": 500
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "newBalance": 9915,
    "transactionId": "txn-uuid",
    "autoRefillTriggered": false
  }
}
```

#### Release Reservation (On Failure)

```http
POST /api/portal/credits/release
Authorization: Bearer <user-jwt>
Content-Type: application/json

{
  "reservationId": "res-uuid"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "released": 100
  }
}
```

---

### Deployment Validation

#### Validate Deployment

Called on Predict startup.

```http
POST /api/deployments/validate
X-Deployment-ID: predict-prod-vercel
X-Deployment-Signature: <hmac-sha256>
Content-Type: application/json

{
  "deploymentId": "predict-prod-vercel",
  "machineHash": "<sha256-of-machine-fingerprint>",
  "version": "1.6.1",
  "environment": "production",
  "productId": "agencio-predict",
  "timestamp": "2026-05-12T00:00:00.000Z"
}
```

**Response (signed):**
```json
{
  "valid": true,
  "message": "Deployment validated",
  "tier": "enterprise",
  "action": "continue",
  "_ts": 1715472000000,
  "_did": "predict-prod-vercel",
  "_sig": "<hmac-sha256>"
}
```

**Actions:**
| Action | Meaning |
|--------|---------|
| `continue` | Deployment is valid, proceed normally |
| `warn` | Deployment has issues but can continue (grace period) |
| `kill` | Deployment is unauthorized, must stop |

#### Heartbeat

Called hourly from Predict.

```http
POST /api/deployments/heartbeat
Content-Type: application/json

{
  "deploymentId": "predict-prod-vercel",
  "metrics": {
    "uptime": 3600,
    "requests": 10000
  }
}
```

**Response:**
```json
{
  "action": "continue",
  "commands": [],
  "_ts": 1715472000000,
  "_sig": "<hmac-sha256>"
}
```

#### Register Deployment (Admin)

```http
POST /api/deployments/register
X-API-Key: <ADMIN_API_KEY>
Content-Type: application/json

{
  "deploymentId": "predict-prod-vercel",
  "productId": "agencio-predict",
  "customerId": "customer-uuid",
  "licenseId": "license-uuid",
  "environment": "production",
  "secret": "<optional-hmac-secret>"
}
```

---

## Webhook Events to Predict

When billing events occur, the License Server should send webhooks to Predict.

**Endpoint:** `POST https://predict.agencio.cloud/api/predict/v1/billing/webhooks/license-server`

**Headers:**
```
Content-Type: application/json
X-License-Signature: sha256=<hmac-of-body>
X-License-Timestamp: <unix-timestamp>
```

**Signature Generation:**
```javascript
const timestamp = Date.now();
const signature = crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(`${timestamp}.${JSON.stringify(body)}`)
  .digest('hex');
```

### Event Types

#### credit.purchased

```json
{
  "id": "evt-uuid",
  "type": "credit.purchased",
  "createdAt": "2026-05-12T00:00:00.000Z",
  "data": {
    "customerId": "ls-customer-id",
    "externalId": "predict-user-id",
    "transactionId": "txn-uuid",
    "packageId": "pkg-uuid",
    "amountCents": 10000,
    "bonusCents": 500,
    "totalCents": 10500,
    "balance": {
      "available": 20500,
      "reserved": 0
    },
    "stripeSessionId": "cs_xxx"
  }
}
```

#### credit.consumed

```json
{
  "id": "evt-uuid",
  "type": "credit.consumed",
  "createdAt": "2026-05-12T00:00:00.000Z",
  "data": {
    "customerId": "ls-customer-id",
    "externalId": "predict-user-id",
    "transactionId": "txn-uuid",
    "amountCents": 85,
    "balance": {
      "available": 20415,
      "reserved": 0
    },
    "usage": {
      "model": "claude-3-opus",
      "provider": "anthropic",
      "inputTokens": 1000,
      "outputTokens": 500
    }
  }
}
```

#### credit.refunded

```json
{
  "id": "evt-uuid",
  "type": "credit.refunded",
  "createdAt": "2026-05-12T00:00:00.000Z",
  "data": {
    "customerId": "ls-customer-id",
    "externalId": "predict-user-id",
    "transactionId": "txn-uuid",
    "amountCents": 5000,
    "reason": "Customer request",
    "balance": {
      "available": 15415,
      "reserved": 0
    }
  }
}
```

#### subscription.created / subscription.updated

```json
{
  "id": "evt-uuid",
  "type": "subscription.created",
  "createdAt": "2026-05-12T00:00:00.000Z",
  "data": {
    "customerId": "ls-customer-id",
    "customerEmail": "user@example.com",
    "subscriptionId": "sub-uuid",
    "subscriptionStatus": "ACTIVE",
    "productId": "product-uuid",
    "productName": "Pro Plan"
  }
}
```

---

## Service Layer

### Customer Service Functions

**File:** `src/services/customer.service.ts`

```typescript
// Create customer from external system (Predict)
export async function createExternalCustomer(input: {
  email: string;
  name?: string;
  externalId: string;
  externalSource: string;
}): Promise<CustomerWithoutPassword>;

// Get customer by external ID
export async function getCustomerByExternalId(
  externalId: string
): Promise<CustomerWithoutPassword | null>;
```

### Credit Service Functions

**File:** `src/services/credit.service.ts`

```typescript
// Get or create credit balance
export async function getOrCreateCreditBalance(
  customerId: string
): Promise<CreditBalanceResponse>;

// Reserve credits before LLM call
export async function reserveCredits(
  customerId: string,
  amountCents: number,
  idempotencyKey: string
): Promise<ReservationResult>;

// Consume credits after successful LLM call
export async function consumeCredits(
  customerId: string,
  reservationId: string,
  amountCents: number,
  usage?: UsageInfo
): Promise<ConsumptionResult>;

// Release reservation on failure
export async function releaseReservation(
  customerId: string,
  reservationId: string
): Promise<ReleaseResult>;
```

---

## Security

### API Key Authentication

Server-to-server endpoints use `X-API-Key` header:

```typescript
router.post('/customers', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!config.ADMIN_API_KEY || apiKey !== config.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // ... handle request
});
```

### Deployment Signature Verification

```typescript
function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}
```

### Response Signing

```typescript
function signResponse(payload: object, secret: string): object {
  const withMeta = { ...payload, _ts: Date.now() };
  const signature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(withMeta))
    .digest('hex');
  return { ...withMeta, _sig: signature };
}
```

---

## Deployment

### Apply Migration

```bash
# On License Server EKS pod
psql $DATABASE_URL -f prisma/migrations/add_external_customer_fields.sql
```

### Regenerate Prisma Client

```bash
npx prisma generate
```

### Restart Pods

```bash
kubectl rollout restart deployment/license-server -n <namespace>
```

### Verify Integration

```bash
# Test customer creation
curl -X POST https://licensing.agencio.cloud/api/portal/customers \
  -H "X-API-Key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"externalId": "test-123", "email": "test@example.com", "source": "predict"}'

# Test credit packages
curl https://licensing.agencio.cloud/api/portal/credits/packages
```

---

## Monitoring

### Logs

```bash
# Customer operations
kubectl logs -l app=license-server | grep "external customer"

# Credit operations
kubectl logs -l app=license-server | grep "credits"

# Deployment validation
kubectl logs -l app=license-server | grep "deployment"
```

### Metrics to Track

- Customer creation rate
- Credit purchase volume
- Credit consumption rate
- Reservation success/failure ratio
- Deployment validation success rate

---

## Related Files

| File | Purpose |
|------|---------|
| `src/routes/portal.ts` | Portal API routes including customer/credit endpoints |
| `src/services/customer.service.ts` | Customer CRUD with external ID support |
| `src/services/credit.service.ts` | Credit balance and transaction management |
| `src/routes/deployments.ts` | Deployment validation and heartbeat |
| `prisma/schema.prisma` | Database models |
| `prisma/migrations/` | Database migrations |
