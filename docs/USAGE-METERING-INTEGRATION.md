# Usage Service + License Server Integration Architecture

**Date:** 2026-03-24
**Status:** APPROVED - Option 1 (Direct Stripe in Usage Service)
**Decision:** No free tier - all organizations billed via Stripe metered billing

---

## Executive Summary

This document outlines the integration strategy for connecting the **usage-service** (AI usage tracking/credits) with the **License Server** (Stripe billing) to enable organization-level metered billing.

### Current State

| System | Billing | Organization Tracking | Stripe Integration |
|--------|---------|----------------------|-------------------|
| **Usage Service** | Credits-based (manual) | Yes (`organization_id`) | None |
| **License Server** | Stripe subscriptions | Per customer | Full (checkout, webhooks, metering) |

### Target State

Organizations subscribe to metered plans via the License Server. The usage-service reports AI consumption, and Stripe bills organizations based on actual usage at the end of each billing cycle.

---

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                        │
│  ┌──────────────┐    ┌─────────────────┐    ┌──────────────────────────┐   │
│  │ Usage        │    │ Settings/Billing │    │ Subscription            │   │
│  │ Dashboard    │    │ Page            │    │ Management              │   │
│  └──────┬───────┘    └────────┬────────┘    └───────────┬──────────────┘   │
└─────────┼─────────────────────┼─────────────────────────┼───────────────────┘
          │                     │                         │
          ▼                     ▼                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           API GATEWAY                                        │
└─────────┬─────────────────────┬─────────────────────────┬───────────────────┘
          │                     │                         │
          ▼                     ▼                         ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────────────────────┐
│ USAGE SERVICE   │   │ AUTH SERVICE    │   │ LICENSE SERVER                  │
│                 │   │                 │   │                                 │
│ • Track usage   │◄──┤ • Organizations │   │ • Stripe subscriptions          │
│ • Credits mgmt  │   │ • Users/Roles   │   │ • Metered billing               │
│ • Cost calc     │   │ • API Keys      │   │ • Webhooks                      │
│ • Analytics     │   │                 │   │ • Usage reporting to Stripe     │
│                 │   │                 │   │                                 │
│ PostgreSQL      │   │ PostgreSQL      │   │ PostgreSQL + Stripe API         │
└────────┬────────┘   └─────────────────┘   └──────────────┬──────────────────┘
         │                                                  │
         │        ┌─────────────────────┐                  │
         └───────►│ USAGE BRIDGE        │◄─────────────────┘
                  │ (New Component)     │
                  │                     │
                  │ • Sync org → sub    │
                  │ • Report to Stripe  │
                  │ • Rate limiting     │
                  │ • Batching          │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │     STRIPE          │
                  │                     │
                  │ • Metered billing   │
                  │ • Invoicing         │
                  │ • Payment processing│
                  └─────────────────────┘
```

---

## Integration Options

### Option 1: Direct Stripe Integration in Usage Service (Recommended)

**Add Stripe metered billing directly to usage-service.**

**Pros:**
- Simplest architecture
- Real-time usage reporting
- Single source of truth for usage

**Cons:**
- Duplicates some Stripe logic
- Need to maintain Stripe credentials in two places

**Implementation:**
1. Add Stripe SDK to usage-service
2. Create metered products in Stripe for AI tiers
3. Map organizations to Stripe subscriptions
4. Report usage on each AI operation

### Option 2: License Server as Billing Gateway

**Usage service calls License Server API to report usage.**

**Pros:**
- Centralized Stripe logic
- License Server already has full Stripe integration
- Single Stripe credential location

**Cons:**
- Additional network hop
- License Server becomes billing bottleneck
- Tighter coupling

**Implementation:**
1. Add `/api/v1/metering/report` endpoint to License Server
2. Usage service calls this endpoint after each operation
3. License Server batches and reports to Stripe

### Option 3: Event-Driven Bridge (Hybrid)

**Usage service publishes events, bridge service syncs to Stripe.**

**Pros:**
- Decoupled systems
- Resilient to failures
- Can batch efficiently

**Cons:**
- Additional infrastructure (message queue)
- Eventual consistency
- More complex

**Implementation:**
1. Usage service publishes to Redis/SQS
2. Bridge service consumes and reports to Stripe
3. License Server manages subscriptions only

---

## Recommended Implementation: Option 1

### Phase 1: Organization-Subscription Mapping

Create a new table to link organizations to Stripe subscriptions:

```sql
-- In usage-service database
CREATE TABLE organization_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE,
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  stripe_subscription_item_id VARCHAR(255),
  plan_tier VARCHAR(50) NOT NULL, -- 'starter', 'professional', 'enterprise'
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  monthly_limit_usd DECIMAL(10, 2),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_org_sub_org_id ON organization_subscriptions(organization_id);
CREATE INDEX idx_org_sub_stripe_sub ON organization_subscriptions(stripe_subscription_id);
```

### Phase 2: Metered Products in Stripe

Create tiered metered products:

```javascript
// Metered pricing tiers - all paid, no free tier
const tiers = [
  {
    name: 'AI Platform - Starter',
    pricePerUnit: 0.001, // $0.001 per credit
    monthlyBase: 0, // Pay-as-you-go, no base fee
  },
  {
    name: 'AI Platform - Professional',
    pricePerUnit: 0.0008, // $0.0008 per credit (20% discount)
    monthlyBase: 49, // $49/month base + usage
  },
  {
    name: 'AI Platform - Enterprise',
    pricePerUnit: 0.0005, // $0.0005 per credit (50% discount)
    monthlyBase: 299, // $299/month base + usage
  },
];
```

### Phase 3: Usage Reporting Flow

```javascript
// In usage-service: Track AI usage and report to Stripe
async function trackAndReportUsage(usageData) {
  // 1. Record usage locally (existing flow)
  const record = await usageService.trackUsage(usageData);

  // 2. Get organization's subscription
  const orgSub = await getOrganizationSubscription(usageData.organization_id);
  if (!orgSub?.stripe_subscription_item_id) {
    console.log('Org not on metered plan, credits only');
    return record;
  }

  // 3. Calculate billable amount (convert cost to credits/units)
  const billableUnits = Math.ceil(record.estimated_cost * 1000); // $0.001 = 1 unit

  // 4. Report to Stripe (batched, see below)
  await queueStripeUsageReport({
    subscriptionItemId: orgSub.stripe_subscription_item_id,
    quantity: billableUnits,
    timestamp: record.timestamp,
    action: 'increment',
  });

  return record;
}
```

### Phase 4: Batched Stripe Reporting

```javascript
// Efficient batched reporting to avoid API rate limits
class StripeUsageReporter {
  constructor() {
    this.buffer = new Map(); // subscriptionItemId -> {quantity, timestamps}
    this.flushInterval = 60000; // Flush every minute
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    setInterval(() => this.flush(), this.flushInterval);
  }

  queue(report) {
    const key = report.subscriptionItemId;
    if (!this.buffer.has(key)) {
      this.buffer.set(key, { quantity: 0, lastTimestamp: null });
    }
    const entry = this.buffer.get(key);
    entry.quantity += report.quantity;
    entry.lastTimestamp = report.timestamp;
  }

  async flush() {
    for (const [subscriptionItemId, entry] of this.buffer) {
      if (entry.quantity === 0) continue;

      try {
        await this.stripe.subscriptionItems.createUsageRecord(
          subscriptionItemId,
          {
            quantity: entry.quantity,
            action: 'increment',
            timestamp: Math.floor(Date.now() / 1000),
          },
          {
            idempotencyKey: `usage-${subscriptionItemId}-${Date.now()}`,
          }
        );
        console.log(`Reported ${entry.quantity} units to Stripe`);
        entry.quantity = 0;
      } catch (error) {
        console.error('Stripe usage report failed:', error);
        // Keep in buffer for retry
      }
    }
  }
}
```

---

## Integration with License Server

The License Server provides these capabilities for the integration:

### 1. Create Metered Subscription

```typescript
// License Server: POST /api/v1/metering/subscribe
export async function createMeteredSubscription(input: {
  organizationId: string;
  planTier: 'starter' | 'professional' | 'enterprise';
  customerEmail: string;
  customerName?: string;
}) {
  // Create or find customer
  let customer = await findOrCreateStripeCustomer(input.customerEmail);

  // Get metered price for tier
  const priceId = METERED_PRICES[input.planTier];

  // Create subscription with metered billing
  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: priceId }],
    metadata: {
      organizationId: input.organizationId,
      planTier: input.planTier,
    },
  });

  return {
    subscriptionId: subscription.id,
    subscriptionItemId: subscription.items.data[0].id,
    customerId: customer.id,
  };
}
```

### 2. Report Usage (if using Option 2)

```typescript
// License Server: POST /api/v1/metering/report
export async function reportUsage(input: {
  organizationId: string;
  quantity: number;
  timestamp?: Date;
  idempotencyKey?: string;
}) {
  const orgSub = await getOrganizationSubscription(input.organizationId);
  if (!orgSub) {
    throw new Error('Organization not subscribed to metered plan');
  }

  await stripe.subscriptionItems.createUsageRecord(
    orgSub.subscriptionItemId,
    {
      quantity: input.quantity,
      action: 'increment',
      timestamp: input.timestamp
        ? Math.floor(input.timestamp.getTime() / 1000)
        : 'now',
    },
    {
      idempotencyKey: input.idempotencyKey,
    }
  );
}
```

### 3. Get Usage Summary

```typescript
// License Server: GET /api/v1/metering/summary/:organizationId
export async function getUsageSummary(organizationId: string) {
  const orgSub = await getOrganizationSubscription(organizationId);
  if (!orgSub) return null;

  const summaries = await stripe.subscriptionItems.listUsageRecordSummaries(
    orgSub.subscriptionItemId,
    { limit: 1 }
  );

  return {
    organizationId,
    currentPeriodUsage: summaries.data[0]?.total_usage || 0,
    subscriptionStatus: orgSub.status,
    planTier: orgSub.planTier,
  };
}
```

---

## Billing Model

**Per-user billing with volume discounts based on organization size.**

### Key Principles
1. Each user in an organization is billed (excluding client portal users)
2. Volume discounts apply based on total user count in the organization
3. User data comes from the authentication-service
4. Credits are consumed per AI operation
5. Billing is via Stripe with per-seat pricing

### User Count Tiers & Discounts

| Users in Org | Per-User Base | Credit Rate | Discount |
|--------------|---------------|-------------|----------|
| 1-5 | $29/user/mo | $0.001/credit | 0% |
| 6-20 | $25/user/mo | $0.0009/credit | ~14% |
| 21-50 | $20/user/mo | $0.0008/credit | ~31% |
| 51-100 | $15/user/mo | $0.0007/credit | ~48% |
| 100+ | Custom | Negotiated | Enterprise |

### What's Excluded from Billing
- Client portal users (different user type in auth-service)
- Service accounts
- Deactivated users

### Integration with Authentication Service

```javascript
// Get billable user count from auth-service
async function getBillableUserCount(organizationId) {
  const response = await fetch(`${AUTH_SERVICE_URL}/api/v1/organizations/${organizationId}/users`, {
    headers: { 'Authorization': `Bearer ${serviceToken}` }
  });
  const data = await response.json();

  // Filter out non-billable users
  const billableUsers = data.users.filter(user =>
    user.status === 'active' &&
    user.userType !== 'client_portal' &&
    user.userType !== 'service_account'
  );

  return billableUsers.length;
}

// Calculate discount tier based on user count
function getDiscountTier(userCount) {
  if (userCount <= 5) return { multiplier: 1.0, perUserRate: 29, creditRate: 0.001 };
  if (userCount <= 20) return { multiplier: 0.86, perUserRate: 25, creditRate: 0.0009 };
  if (userCount <= 50) return { multiplier: 0.69, perUserRate: 20, creditRate: 0.0008 };
  if (userCount <= 100) return { multiplier: 0.52, perUserRate: 15, creditRate: 0.0007 };
  return { multiplier: 'custom', perUserRate: 'negotiated', creditRate: 'negotiated' };
}
```

### Stripe Subscription Structure

For per-user billing, we use Stripe's **per-seat pricing** with quantity:

```javascript
// Create subscription with per-seat pricing
async function createOrgSubscription(organizationId, customerEmail) {
  const userCount = await getBillableUserCount(organizationId);
  const tier = getDiscountTier(userCount);

  // Get the appropriate price ID for this tier
  const priceId = getPriceIdForTier(tier);

  const subscription = await stripe.subscriptions.create({
    customer: stripeCustomerId,
    items: [{
      price: priceId,
      quantity: userCount, // Number of seats
    }],
    metadata: {
      organization_id: organizationId,
      billing_type: 'per_user',
      user_count_at_creation: userCount,
    },
  });

  return subscription;
}

// Update seat count when users are added/removed
async function updateSeatCount(organizationId) {
  const sub = await getOrganizationSubscription(organizationId);
  const newUserCount = await getBillableUserCount(organizationId);

  await stripe.subscriptionItems.update(sub.stripe_subscription_item_id, {
    quantity: newUserCount,
  });
}
```

### Credits System Integration

The existing credits system tracks usage per user:

```javascript
// Track usage with user attribution
async function trackUserUsage(usageData) {
  const { userId, organizationId, estimatedCost } = usageData;

  // Record in usage_records (existing system)
  await usageService.trackUsage(usageData);

  // Get org's current billing tier for credit rate
  const userCount = await getBillableUserCount(organizationId);
  const tier = getDiscountTier(userCount);

  // Calculate credits at tiered rate
  const creditsUsed = estimatedCost / tier.creditRate;

  // Report metered usage to Stripe (if metered component exists)
  await reportMeteredUsage(organizationId, creditsUsed);
}
```

---

## Frontend Integration

### Billing Settings Page

```tsx
// Settings > Billing component
function BillingSettings({ organizationId }) {
  const { data: subscription } = useQuery(['subscription', organizationId]);
  const { data: usage } = useQuery(['usage-summary', organizationId]);

  return (
    <div>
      <h2>Usage & Billing</h2>

      {/* Current Plan */}
      <Card>
        <h3>Current Plan: {subscription?.planTier || 'Free'}</h3>
        {subscription?.status === 'active' && (
          <p>Next invoice: {formatDate(subscription.currentPeriodEnd)}</p>
        )}
        <Button onClick={upgradePlan}>Upgrade Plan</Button>
      </Card>

      {/* Usage This Period */}
      <Card>
        <h3>Usage This Billing Period</h3>
        <UsageChart data={usage?.byProvider} />
        <p>Total: ${usage?.totalCost.toFixed(2)}</p>
        {subscription?.monthlyLimit && (
          <Progress
            value={usage?.totalCost}
            max={subscription.monthlyLimit}
          />
        )}
      </Card>

      {/* Payment Method */}
      <Card>
        <h3>Payment Method</h3>
        <StripePaymentMethod customerId={subscription?.stripeCustomerId} />
      </Card>
    </div>
  );
}
```

---

## Migration Path

### Step 1: Database Changes (Day 1)

1. Add `organization_subscriptions` table to usage-service
2. Add Stripe-related columns to existing tables

### Step 2: Stripe Products Setup (Day 1)

1. Create metered products in Stripe
2. Configure pricing tiers
3. Test in sandbox mode

### Step 3: Backend Integration (Days 2-3)

1. Add Stripe SDK to usage-service (or use License Server API)
2. Implement subscription creation flow
3. Implement usage reporting

### Step 4: Frontend Integration (Days 4-5)

1. Add billing settings page
2. Integrate Stripe Elements for payment
3. Show usage/billing dashboard

### Step 5: Testing & Go-Live (Day 6)

1. Test full flow in sandbox
2. Switch to live Stripe keys
3. Monitor billing accuracy

---

## Environment Variables (Usage Service)

Add these to usage-service `.env`:

```bash
# Stripe Integration (if Option 1)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Or if using License Server API (Option 2)
LICENSE_SERVER_URL=https://licencing.agencio.cloud
LICENSE_SERVER_API_KEY=...

# Metering Configuration
METERING_ENABLED=true
METERING_BATCH_SIZE=100
METERING_FLUSH_INTERVAL_MS=60000

# Plan Price IDs (from Stripe)
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_PROFESSIONAL=price_...
STRIPE_PRICE_ENTERPRISE=price_...
```

---

## API Endpoints Summary

### Usage Service (New Endpoints)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/subscriptions` | Create metered subscription |
| GET | `/api/v1/subscriptions/:orgId` | Get subscription status |
| PUT | `/api/v1/subscriptions/:orgId` | Update subscription |
| DELETE | `/api/v1/subscriptions/:orgId` | Cancel subscription |
| GET | `/api/v1/metering/summary/:orgId` | Get Stripe usage summary |

### License Server (Existing, Enhanced)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/metering/report` | Report usage (Option 2) |
| GET | `/api/v1/metering/products` | List metered products |
| POST | `/api/v1/metering/subscribe` | Create org subscription |

---

## Monitoring & Alerts

1. **Usage Anomalies**: Alert if org usage spikes >200% vs. average
2. **Billing Failures**: Alert on invoice.payment_failed webhook
3. **Reporting Lag**: Alert if Stripe reporting buffer grows >1000 items
4. **Sync Errors**: Alert if org subscription sync fails

---

## Next Steps

1. [ ] Confirm architecture choice (Option 1 vs 2)
2. [ ] Create metered products in Stripe sandbox
3. [ ] Implement organization_subscriptions table
4. [ ] Add Stripe reporting to usage-service
5. [ ] Build frontend billing settings
6. [ ] Test in sandbox
7. [ ] Go live

---

## Decisions Made

1. **Free tier?** No - all organizations billed
2. **Architecture?** Option 1 - Direct Stripe integration in usage-service
3. **Billing model?** Per-user with volume discounts
4. **Billing interval?** Monthly
5. **Credits system?** Keep for tracking, Stripe for billing
6. **Enterprise custom pricing?** Handle via License Server quotes
7. **User source?** Authentication service (excluding client portal users)

## Implementation Status

### Completed
- [x] `stripeBillingService.js` - Per-user billing with volume discounts
- [x] `subscriptionRoutes.js` - CRUD for subscriptions + seat sync
- [x] `stripeWebhookRoutes.js` - Stripe webhook handlers
- [x] Added Stripe dependency to package.json

### Next Steps
1. Create per-seat prices in Stripe for each tier (1-5, 6-20, 21-50, 51-100)
2. Add env vars: STRIPE_PRICE_TIER_1_5, STRIPE_PRICE_TIER_6_20, etc.
3. Register routes in usage-service index.js
4. Set up webhook endpoint in Stripe dashboard
5. Hook into auth-service user events for seat count updates
6. Build frontend billing settings page
