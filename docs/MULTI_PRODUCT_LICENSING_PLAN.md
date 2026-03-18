# Multi-Product Licensing Strategy

## Overview

This document outlines the licensing architecture for the Agencio product family:

- **K8inspector** - Kubernetes management platform (Web, Windows, Mac)
- **Silo Enterprise** - Enterprise infrastructure platform (seat-based)
- **Plugins** - K8inspector Plugin, Docker Plugin

---

## Product Hierarchy

```
Agencio Product Family
├── K8inspector
│   ├── K8inspector Free (Web)
│   ├── K8inspector Professional (Web)
│   ├── K8inspector Enterprise (Web)
│   ├── K8inspector Home - Windows Standalone
│   └── K8inspector Home - Mac Standalone
│
├── Silo Enterprise
│   ├── Silo Team 5 (5 seats)
│   ├── Silo Team 10 (10 seats)
│   ├── Silo Team 20 (20 seats)
│   ├── Silo Team 50 (50 seats)
│   └── Silo Enterprise (POA - unlimited)
│
└── Plugins
    ├── K8inspector Plugin Pack
    └── Docker Plugin Pack
```

---

## Database Schema Additions

### New Fields for License Model

```prisma
model License {
  // Existing fields...

  // NEW: Seat-based licensing
  seatCount        Int       @default(1)      // Total seats purchased
  seatsUsed        Int       @default(0)      // Seats currently assigned

  // NEW: License type classification
  licenseType      LicenseType @default(INDIVIDUAL)

  // NEW: Volume/Enterprise
  isVolumeLicense  Boolean   @default(false)
  volumeDiscount   Decimal?  @db.Decimal(5, 2) // e.g., 0.20 = 20% off

  // NEW: License terms
  licenseTerm      LicenseTerm @default(SUBSCRIPTION)
  renewalDate      DateTime?

  // NEW: Parent license for seat assignments
  parentLicenseId  String?
  parentLicense    License?  @relation("SeatAssignments", fields: [parentLicenseId], references: [id])
  childLicenses    License[] @relation("SeatAssignments")
}

enum LicenseType {
  INDIVIDUAL      // Single user
  TEAM            // Small team (5-50 seats)
  ENTERPRISE      // Unlimited/custom
  PLUGIN          // Add-on plugin
  TRIAL           // Time-limited trial
}

enum LicenseTerm {
  SUBSCRIPTION    // Monthly/Annual recurring
  PERPETUAL       // One-time purchase, updates for 1 year
  MULTI_YEAR      // 2-3 year terms with discount
}
```

### New Model: Seat Assignment

```prisma
model SeatAssignment {
  id              String    @id @default(uuid())
  licenseId       String
  license         License   @relation(fields: [licenseId], references: [id])

  // Assigned user
  email           String
  name            String?

  // Assignment tracking
  assignedAt      DateTime  @default(now())
  assignedBy      String?   // Admin who assigned

  // Activation tracking
  activated       Boolean   @default(false)
  activatedAt     DateTime?
  machineFingerprint String?
  machineName     String?

  @@unique([licenseId, email])
  @@index([email])
}
```

---

## Product Definitions

### K8inspector Products

| Product ID | Name | Type | Price | Activations | Features |
|------------|------|------|-------|-------------|----------|
| `k8i-free` | K8inspector Free | Web | $0/mo | 1 | `["basic", "read-only", "1-cluster"]` |
| `k8i-pro` | K8inspector Professional | Web | $79/mo | 3 | `["ai-assistant", "cost-analysis", "security", "3-clusters"]` |
| `k8i-ent` | K8inspector Enterprise | Web | $199/mo | Unlimited | `["all-features", "api-keys", "integrations", "unlimited-clusters"]` |
| `k8i-home-win` | K8inspector Home Windows | Desktop | $49/year | 2 | `["desktop", "local-clusters", "offline-mode", "auto-updates"]` |
| `k8i-home-mac` | K8inspector Home Mac | Desktop | $49/year | 2 | `["desktop", "local-clusters", "offline-mode", "auto-updates"]` |
| `k8i-home-bundle` | K8inspector Home Bundle | Desktop | $79/year | 4 | `["desktop", "cross-platform", "offline-mode", "auto-updates"]` |

### Silo Enterprise Products

| Product ID | Name | Seats | Price | Term | Features |
|------------|------|-------|-------|------|----------|
| `silo-team-5` | Silo Team 5 | 5 | $299/mo | Subscription | `["team", "shared-resources", "basic-support"]` |
| `silo-team-10` | Silo Team 10 | 10 | $549/mo | Subscription | `["team", "shared-resources", "priority-support"]` |
| `silo-team-20` | Silo Team 20 | 20 | $999/mo | Subscription | `["team", "shared-resources", "priority-support", "sso"]` |
| `silo-team-50` | Silo Team 50 | 50 | $1,999/mo | Subscription | `["team", "shared-resources", "dedicated-support", "sso", "audit-logs"]` |
| `silo-enterprise` | Silo Enterprise | Unlimited | POA | Custom | `["enterprise", "unlimited", "custom-integrations", "sla"]` |

### Plugin Products

| Product ID | Name | Type | Price | Bundled With |
|------------|------|------|-------|--------------|
| `plugin-k8i` | K8inspector Plugin Pack | Add-on | $29/mo | K8inspector Pro/Ent |
| `plugin-docker` | Docker Plugin Pack | Add-on | $29/mo | K8inspector Pro/Ent |
| `plugin-bundle` | Full Plugin Bundle | Add-on | $49/mo | K8inspector Pro/Ent |

---

## API Additions

### Seat Management Endpoints

```
# List seat assignments for a license
GET /api/admin/licenses/:id/seats
Response: { seats: SeatAssignment[], available: number, total: number }

# Assign seat to user
POST /api/admin/licenses/:id/seats
Body: { email: string, name?: string }
Response: { assignment: SeatAssignment, inviteUrl: string }

# Remove seat assignment
DELETE /api/admin/licenses/:id/seats/:email
Response: { success: true }

# Bulk assign seats (CSV import)
POST /api/admin/licenses/:id/seats/bulk
Body: { assignments: [{ email, name }] }
Response: { assigned: number, failed: [], invitesSent: number }
```

### Volume License Endpoints

```
# Create volume/enterprise license
POST /api/admin/licenses/volume
Body: {
  customerId: string,
  productId: string,
  seatCount: number,
  term: "1-year" | "2-year" | "3-year" | "perpetual",
  discount?: number,
  customFeatures?: string[],
  metadata?: object
}

# Generate enterprise quote
POST /api/admin/quotes
Body: {
  productId: string,
  seatCount: number,
  term: string,
  customRequirements?: string
}
Response: { quoteId, pricing, discount, validUntil }

# Convert quote to license
POST /api/admin/quotes/:id/convert
Body: { customerId: string, paymentMethod?: string }
```

### Desktop App Endpoints

```
# Validate desktop license with machine binding
POST /api/v1/desktop/validate
Body: {
  licenseKey: string,
  machineFingerprint: string,
  platform: "windows" | "macos",
  appVersion: string
}
Response: {
  valid: boolean,
  product: string,
  features: string[],
  offlineToken?: string,  // For offline validation
  checkInDays: number     // Days until next required check-in
}

# Phone-home check-in (called periodically by desktop apps)
POST /api/v1/desktop/checkin
Body: {
  licenseKey: string,
  machineFingerprint: string,
  lastUsed: datetime,
  appVersion: string
}
Response: {
  valid: boolean,
  renewedToken?: string,
  message?: string
}
```

---

## Stripe Product Setup

### Create Products in Stripe Dashboard

```bash
# K8inspector Web Products
stripe products create --name="K8inspector Professional" --metadata[product_id]=k8i-pro
stripe prices create --product=prod_xxx --currency=usd --unit-amount=7900 --recurring[interval]=month
stripe prices create --product=prod_xxx --currency=usd --unit-amount=79000 --recurring[interval]=year

stripe products create --name="K8inspector Enterprise" --metadata[product_id]=k8i-ent
stripe prices create --product=prod_xxx --currency=usd --unit-amount=19900 --recurring[interval]=month
stripe prices create --product=prod_xxx --currency=usd --unit-amount=199000 --recurring[interval]=year

# K8inspector Desktop Products (Annual subscription)
stripe products create --name="K8inspector Home Windows" --metadata[product_id]=k8i-home-win
stripe prices create --product=prod_xxx --currency=usd --unit-amount=4900 --recurring[interval]=year

stripe products create --name="K8inspector Home Mac" --metadata[product_id]=k8i-home-mac
stripe prices create --product=prod_xxx --currency=usd --unit-amount=4900 --recurring[interval]=year

stripe products create --name="K8inspector Home Bundle" --metadata[product_id]=k8i-home-bundle
stripe prices create --product=prod_xxx --currency=usd --unit-amount=7900 --recurring[interval]=year

# Silo Team Products
stripe products create --name="Silo Team 5" --metadata[product_id]=silo-team-5 --metadata[seats]=5
stripe prices create --product=prod_xxx --currency=usd --unit-amount=29900 --recurring[interval]=month
stripe prices create --product=prod_xxx --currency=usd --unit-amount=299000 --recurring[interval]=year

stripe products create --name="Silo Team 10" --metadata[product_id]=silo-team-10 --metadata[seats]=10
stripe prices create --product=prod_xxx --currency=usd --unit-amount=54900 --recurring[interval]=month
stripe prices create --product=prod_xxx --currency=usd --unit-amount=549000 --recurring[interval]=year

# Plugin Products
stripe products create --name="K8inspector Plugin Pack" --metadata[product_id]=plugin-k8i
stripe prices create --product=prod_xxx --currency=usd --unit-amount=2900 --recurring[interval]=month

stripe products create --name="Docker Plugin Pack" --metadata[product_id]=plugin-docker
stripe prices create --product=prod_xxx --currency=usd --unit-amount=2900 --recurring[interval]=month

stripe products create --name="Full Plugin Bundle" --metadata[product_id]=plugin-bundle
stripe prices create --product=prod_xxx --currency=usd --unit-amount=4900 --recurring[interval]=month
```

### Volume Discount Coupons

```bash
# 10+ seats: 10% off
stripe coupons create --percent-off=10 --duration=forever --name="Volume 10+"

# 20+ seats: 15% off
stripe coupons create --percent-off=15 --duration=forever --name="Volume 20+"

# 50+ seats: 25% off
stripe coupons create --percent-off=25 --duration=forever --name="Volume 50+"

# Annual commitment: 2 months free (16.67% off)
stripe coupons create --percent-off=16.67 --duration=forever --name="Annual Commitment"
```

---

## Desktop App Integration

### Windows Standalone (C#/.NET)

```csharp
// Using the LicenseServer C# SDK
using LicenseServer.Client;

var client = new LicenseClient("https://license.agencio.cloud");

// On first launch
var activation = await client.ActivateAsync(new ActivationRequest {
    LicenseKey = userEnteredKey,
    MachineFingerprint = MachineInfo.GetFingerprint(),
    MachineName = Environment.MachineName,
    Platform = "windows"
});

if (activation.Valid) {
    // Store offline token for grace period operation
    Settings.OfflineToken = activation.OfflineToken;
    Settings.LicenseKey = userEnteredKey;
    Settings.CheckInDays = activation.CheckInDays;
}

// Periodic check-in (every 7 days)
var checkIn = await client.CheckInAsync(new CheckInRequest {
    LicenseKey = Settings.LicenseKey,
    MachineFingerprint = MachineInfo.GetFingerprint()
});
```

### Mac Standalone (Swift)

```swift
// Using the LicenseServer Swift SDK
import LicenseServerClient

let client = LicenseClient(baseURL: "https://license.agencio.cloud")

// On first launch
Task {
    let result = try await client.activate(
        licenseKey: userEnteredKey,
        machineFingerprint: MachineInfo.fingerprint(),
        platform: "macos"
    )

    if result.valid {
        UserDefaults.standard.set(result.offlineToken, forKey: "offlineToken")
        UserDefaults.standard.set(userEnteredKey, forKey: "licenseKey")
    }
}
```

### Offline Validation Flow

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Desktop App   │────▶│  License Server  │────▶│     Stripe      │
└─────────────────┘     └──────────────────┘     └─────────────────┘
        │                        │
        │  1. Activate           │
        │──────────────────────▶ │
        │                        │
        │  2. Receive offline    │
        │     token (JWT signed) │
        │◀────────────────────── │
        │                        │
        │  3. Store locally      │
        │                        │
        │  [7-day grace period]  │
        │                        │
        │  4. Check-in (online)  │
        │──────────────────────▶ │
        │                        │
        │  5. Renewed token      │
        │◀────────────────────── │
```

---

## Seat Assignment Workflow

### Admin Assigns Seats

```
1. Company purchases "Silo Team 20" license
2. Admin receives master license key: XXXX-XXXX-XXXX-XXXX
3. Admin logs into License Portal
4. Goes to License Management > Assign Seats
5. Enters employee emails:
   - alice@company.com
   - bob@company.com
   - ...
6. System sends invite emails with individual activation links
7. Employees click link, create account, activate on their machine
8. Admin can view activation status, revoke seats, reassign
```

### Self-Service Portal

```
1. Employee receives invite: "You've been assigned a Silo seat"
2. Clicks activation link
3. Downloads desktop app OR accesses web portal
4. Enters email (pre-filled from invite)
5. Creates password / SSO login
6. License automatically bound to their account
```

---

## Implementation Phases

### Phase 1: Schema & Core API (Week 1-2)

- [ ] Add new Prisma schema fields (LicenseType, SeatAssignment, etc.)
- [ ] Run migrations
- [ ] Update license service with seat management
- [ ] Add seat assignment API endpoints
- [ ] Update admin dashboard UI

### Phase 2: Desktop Integration (Week 2-3)

- [ ] Add desktop-specific validation endpoints
- [ ] Implement offline token generation with configurable grace period
- [ ] Update C# SDK for Windows
- [ ] Update Swift SDK for Mac
- [ ] Add periodic check-in logic

### Phase 3: Stripe Products (Week 3)

- [ ] Create all product SKUs in Stripe
- [ ] Set up volume discount coupons
- [ ] Configure webhook handlers for new products
- [ ] Test purchase flows

### Phase 4: Portal Updates (Week 4)

- [ ] Add seat management UI to customer portal
- [ ] Add bulk invite functionality
- [ ] Add seat usage dashboard
- [ ] Email templates for invites

### Phase 5: Enterprise Features (Week 5+)

- [ ] Quote generation system
- [ ] Custom contract support
- [ ] SSO integration for enterprise
- [ ] Audit logging
- [ ] Usage analytics

---

## Environment Configuration

```bash
# .env additions for LicenseServer

# Desktop App Settings
DESKTOP_OFFLINE_GRACE_DAYS=7
DESKTOP_CHECKIN_INTERVAL_DAYS=7
DESKTOP_MAX_OFFLINE_DAYS=30

# Volume Licensing
VOLUME_DISCOUNT_10_SEATS=0.10
VOLUME_DISCOUNT_20_SEATS=0.15
VOLUME_DISCOUNT_50_SEATS=0.25
ANNUAL_DISCOUNT=0.1667

# Product Categories
PRODUCT_CATEGORY_K8INSPECTOR=k8inspector
PRODUCT_CATEGORY_SILO=silo
PRODUCT_CATEGORY_PLUGINS=plugins
```

---

## Testing Checklist

### K8inspector Home (Desktop)

- [ ] Purchase Windows standalone via Stripe
- [ ] Receive license key via email
- [ ] Enter key in Windows app
- [ ] Verify activation and features
- [ ] Test offline mode (disconnect internet)
- [ ] Verify 7-day grace period
- [ ] Test check-in after reconnecting

### Silo Team Licensing

- [ ] Purchase Silo Team 10
- [ ] Assign 5 seats via admin portal
- [ ] Verify invite emails sent
- [ ] Employee activates seat
- [ ] Verify seat count updates
- [ ] Test reassigning a seat
- [ ] Test exceeding seat limit (should fail)

### Enterprise/POA

- [ ] Generate quote for 100+ seats
- [ ] Apply custom discount
- [ ] Convert quote to license
- [ ] Bulk import seat assignments
- [ ] Verify custom features

---

## Support Contact

- **Technical Support**: k8support@agencio.cloud
- **Sales/Enterprise**: sales@agencio.cloud
- **Documentation**: https://license.agencio.cloud/docs

---

*Last Updated: 2026-03-18*
