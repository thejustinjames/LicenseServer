# License Server — Test Data + Test License Generation

How to create the test SKUs, sample licenses, and one-off QA keys that drive
end-to-end testing of the License Server, **without going through Stripe**.

Snapshot date: **2026-04-25**.

---

## 1. Two paths

| You want to… | Use |
|---|---|
| Bring a fresh DB up with the four test SKUs and one sample license per tier | `licensing_seeds/01-test-skus.cjs` then `licensing_seeds/02-test-licenses.cjs` |
| Issue a single ad-hoc license key from the admin UI for a hands-on test | **Generate Test License** button on `/admin.html` → Licenses |
| Issue a license programmatically | `POST /api/admin/licenses/test` (admin-gated, no Stripe) |

All three paths bypass Stripe entirely. They tag every issued license with
`metadata.test = true` so the test rows can be filtered or cleaned up later
without touching production data.

---

## Components

SILO can deploy individual services (cortex, dashboard, ml, dist, agent,
core). The licensing model carries this on two columns:

- `Product.components: String[]` — the maximum set this SKU is permitted
  to enable.
- `License.enabledComponents: String[]` — per-license override. Empty/null
  means inherit the product's full set.

The license validate API (`POST /api/v1/validate`) accepts an optional
`component` field — a SILO service can call it at startup to check whether
its license authorises that component. There's also a public read-only
endpoint:

```
GET  /api/v1/licenses/<key>/components
  → 200 { valid: true, product, components: [...], features: [...] }
  → 400 { valid: false, error: "License has expired" }
```

deployment tooling polls this to learn which services to spin up per
license.

The default component allocation per test SKU:

| SKU | components |
|---|---|
| `SILO Standalone Home` | `core` |
| `SILO Standalone Professional` | `core` |
| `SILO Cortex Business` | `core, cortex, dashboard, agent` |
| `SILO Cortex Enterprise` | `core, cortex, dashboard, agent, ml, dist, enterprise-plugins` |

Migration: `prisma/sql/2026-04-25-components.sql` (idempotent).

---

## 2. Test SKUs (`licensing_seeds/01-test-skus.cjs`)

Four products, prices in USD cents, idempotent (keyed by `name`):

| SKU | Annual price | Default seats | Max seats | Platforms | Features |
|---|---|---|---|---|---|
| `SILO Standalone Home` | $29.99 | 1 | 1 | Windows, macOS | `standalone, single-machine, offline-mode, community-support` |
| `SILO Standalone Professional` | $49.99 | 1 | 1 | Windows, macOS | `standalone, single-machine, offline-mode, all-modules, advanced-reporting, priority-support` |
| `SILO Cortex Business` | $499 | 5 | 5 | Web, Windows, macOS, Linux | `cortex-managed, team-dashboard, mtls-agent, all-modules, priority-support` |
| `SILO Cortex Enterprise` | $1999 | 10 | 10 | Web, Windows, macOS, Linux | `cortex-managed, team-dashboard, mtls-agent, all-modules, enterprise-plugins, sso, audit-logs, dedicated-support, sla` |

Run inside a pod:

```bash
KCTL=/c/Users/justin/bin/kubectl.exe
POD=$($KCTL get pods -n preprod -l app=license-server \
  --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
cat licensing_seeds/01-test-skus.cjs | $KCTL exec -n preprod -i $POD -- \
  sh -c 'cat > /app/seed.cjs && cd /app && node ./seed.cjs && rm -f /app/seed.cjs'
```

Verify via the public catalog:
```bash
curl -sk https://licensing.agencio.cloud/api/portal/products | head -c 600
```

---

## 3. Sample test licenses (`licensing_seeds/02-test-licenses.cjs`)

One license per SKU, keyed against tier-specific QA customers
(`qa-{tier}@licenseserver.test`). Idempotent on `(customerId, productId)`.

### Activation + seat policy

| SKU | `maxActivations` (devices) | `seatCount` (named users) | Enterprise modules |
|---|---|---|---|
| `SILO Standalone Home` | **1** | 1 | no |
| `SILO Standalone Professional` | **1** | 1 | no |
| `SILO Cortex Business` | **2** | **5** | no |
| `SILO Cortex Enterprise` | **2** | **10** | **yes** |

- `maxActivations` is enforced by `license.service.activate(...)` and caps
  the number of distinct device fingerprints that can ever activate the key.
- `seatCount` is enforced by `seat.service` and caps the number of named
  user seats that can be assigned under the licence.
- "Enterprise modules" is a *feature-flag gate*, not a license field. The
  Enterprise SKU's `features[]` array on the product includes
  `enterprise-plugins`; the runtime checks
  `license.product.features.includes('enterprise-plugins')` to allow
  enterprise plugin install / module creation.

### Run

```bash
cat licensing_seeds/02-test-licenses.cjs | $KCTL exec -n preprod -i $POD -- \
  sh -c 'cat > /app/seed.cjs && cd /app && node ./seed.cjs && rm -f /app/seed.cjs'
```

The seeder prints each license key on success — capture them for the QA
fixtures.

---

## 4. Admin UI: "Generate Test License"

`/admin.html` → **Licenses** section now has two buttons:

- **Generate Test License** — single-step QA issuance, no Stripe.
- **+ Create License** — original flow (pick customer + product manually).

The test-license modal asks for:

| Field | Default | Notes |
|---|---|---|
| Product | required | Dropdown of every product in the catalog. |
| Seat count override | product default | Leave blank to honour the product's `defaultSeatCount`. |
| Expires in (days) | (no expiry) | Optional time-box for the licence. |
| Customer email override | `qa-tester@licenseserver.test` | Auto-creates the customer on first use. |
| Note | empty | Stored verbatim in `metadata.note`. |

Submitting hits the dedicated endpoint described next. The result is
displayed in a copyable result modal (no more `alert(license.key)`).

---

## 5. API: `POST /api/admin/licenses/test`

Admin-gated (Cognito staff pool + MFA). Bypasses Stripe entirely.

```
POST /api/admin/licenses/test
Authorization: Bearer <staff access token>
Content-Type: application/json

{
  "productId": "<uuid>",
  "seatCount": 5,            // optional — defaults to product.defaultSeatCount
  "expiresInDays": 30,       // optional — no expiry by default
  "customerEmail": "qa-cortex@licenseserver.test",  // optional — defaults to qa-tester@licenseserver.test
  "note": "Cortex sidecar smoke test 2026-04-25"     // optional, ≤200 chars
}
```

Response (201):
```
{
  "license": { "id": "...", "key": "XXXX-XXXX-XXXX-XXXX", ... },
  "product": { "id": "...", "name": "..." },
  "customer": { "id": "...", "email": "..." }
}
```

What it does:
1. Finds or creates the customer row (with an unmatchable bcrypt sentinel
   so the legacy `/api/portal/auth/login` can never authenticate it).
2. Issues the licence with `metadata`:
   ```
   {
     "test": true,
     "issuedBy": "<admin email>",
     "issuedAt": "<ISO timestamp>",
     "note": "<optional>"
   }
   ```
3. Defaults `seatCount` to `product.defaultSeatCount` (so Cortex Business
   issues 5 seats, Enterprise 10).

Audit-logged as `test-license-issue` and (if a new customer was created)
`test-customer-create`.

---

## 6. Cleanup

To drop all test data on a preprod refresh:

```sql
-- inside the pod or via a one-shot psql Job
DELETE FROM license_server.license_activations
  WHERE license_id IN (SELECT id FROM license_server.licenses WHERE metadata->>'test' = 'true');

DELETE FROM license_server.seat_assignments
  WHERE license_id IN (SELECT id FROM license_server.licenses WHERE metadata->>'test' = 'true');

DELETE FROM license_server.licenses
  WHERE metadata->>'test' = 'true';

DELETE FROM license_server.customers
  WHERE email LIKE 'qa-%@licenseserver.test';
```

Products from `01-test-skus.cjs` are NOT deleted by this; drop them
manually with `DELETE FROM products WHERE category IN ('silo-standalone',
'silo-cortex')` if needed.

---

## 7. Files & references

- Seeders:        `licensing_seeds/01-test-skus.cjs`,
                  `licensing_seeds/02-test-licenses.cjs`,
                  `licensing_seeds/README.md`
- Admin route:    `src/routes/admin.ts` (`POST /api/admin/licenses/test`)
- License service:`src/services/license.service.ts` (`createLicense` honours `seatCount` from input or product default)
- Admin UI:       `public/admin.html` (`#testLicenseModal`, `#licenseResultModal`),
                  `public/admin.js` (`openTestLicenseModal`, `handleTestLicenseSubmit`, `showLicenseResult`)
- Deployment:     `docs/agencioaws/DEPLOYMENT_REFERENCE.md`
- Change log:     `docs/agencioaws/CHANGE_LOG_2026-04-25.md`
- This document:  `docs/agencioaws/TEST_DATA.md`
