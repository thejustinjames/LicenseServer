# License Server — Customer Cognito + MFA

This document captures the **external customer** authentication setup for the
License Server (separate from the internal/staff Cognito pool documented in
`DEPLOYMENT_REFERENCE.md`).

Snapshot date: **2026-04-25**, region `ap-southeast-1`, account
`772693061584`.

---

## 1. At a glance

| Property | Value |
|---|---|
| Cognito user pool | `ap-southeast-1_7KTxiTaT8` (`ag-license-customers`) |
| Pool ARN | `arn:aws:cognito-idp:ap-southeast-1:772693061584:userpool/ap-southeast-1_7KTxiTaT8` |
| Web app client (no secret, SPA) | `2tolovmjlpk3u9v3se5v4kh3g1` (`ag-license-customers-web`) |
| Server app client (with secret) | `7glm2hp5rgqv59h3levngplbpq` (`ag-license-customers-server`) |
| MFA | `OPTIONAL`, TOTP only (`SOFTWARE_TOKEN_MFA`) |
| Sign-in attribute | email (case-insensitive) |
| Password policy | min 12, upper+lower+number+symbol |
| Self-service signup | enabled |
| Account recovery | verified email only (no SMS) |
| Deletion protection | `ACTIVE` |
| Groups | `customer` (default), `customer-admin`, `staff-support` |
| Audience | external paying customers of the License Server |

The staff/admin pool (`ap-southeast-1_y6HkbFYfL`) is **unchanged** and remains
the directory for Agencio internal users. The license server now verifies JWTs
against **either** pool.

---

## 2. Why a separate pool

External customers (paying license holders) are a different audience to
Agencio staff. Mixing them into a single Cognito directory means:

- shared password policy and MFA configuration
- shared admin surface (any staff with `cognito-idp:Admin*` could see customer
  PII)
- no clean way to issue distinct token audiences (`aud`)

Splitting them gives independent password/MFA policy, isolated user lists, and
a clear authorization boundary in the verifier (a customer-pool token can
never carry `isAdmin=true`).

---

## 3. Resources

### Cognito user pool — `ag-license-customers`

Created via `aws cognito-idp create-user-pool` with:

```
PoolName              ag-license-customers
UsernameAttributes    email
CaseSensitive         false
MfaConfiguration      OPTIONAL
EnabledMfas           SOFTWARE_TOKEN_MFA  (set via set-user-pool-mfa-config)
DeletionProtection    ACTIVE
PasswordPolicy        min 12, upper, lower, number, symbol, temp 3d
AccountRecovery       verified_email
AutoVerifiedAttributes  email
Schema (custom)       custom:tenant_id (mutable, ≤64 chars)
                      custom:license_customer_id (mutable, ≤64 chars)
Tags                  Environment=preprod, Service=license-server,
                      Audience=external-customers, ManagedBy=agencio-platform
```

### App clients

| Client | Use | Secret? | Auth flows |
|---|---|---|---|
| `ag-license-customers-web` | Browser/SPA. Customers log in directly. | no | `USER_SRP_AUTH`, `REFRESH_TOKEN_AUTH` |
| `ag-license-customers-server` | License server admin operations (e.g. `AdminAddUserToGroup`). | yes (in Secrets Manager) | `ADMIN_USER_PASSWORD_AUTH`, `USER_SRP_AUTH`, `REFRESH_TOKEN_AUTH` |

Token TTLs: ID/Access 1h, Refresh 30d (web) / 1d (server). Token revocation
enabled. `prevent-user-existence-errors=ENABLED` so probing for valid emails
returns the same response as invalid ones.

Web client callback/logout URLs:

```
callbackURLs: https://licensing.agencio.cloud/auth/callback
logoutURLs:   https://licensing.agencio.cloud/auth/logout
```

### Groups

| Group | Purpose |
|---|---|
| `customer` | Default group every confirmed customer is added to. |
| `customer-admin` | Org owner / billing contact for an organisation account. |
| `staff-support` | Internal staff doing read-only impersonation; granted via separate workflow, **not** by self-signup. |

### IAM

The license-server IRSA role
`arn:aws:iam::772693061584:role/Preprod-LicenseServerService-Role` was updated
(`LicenseServer-Service-Policy`, version `v2`, set as default) to allow
customer-pool sign-up, login, MFA, and admin user/group operations on the new
pool ARN. The previous statement on the staff pool is retained.

### Secrets Manager — `preprod/license-server`

Added keys:

```
CUSTOMER_AUTH_ENABLED                 "true"
CUSTOMER_COGNITO_USER_POOL_ID         ap-southeast-1_7KTxiTaT8
CUSTOMER_COGNITO_CLIENT_ID            2tolovmjlpk3u9v3se5v4kh3g1
CUSTOMER_COGNITO_SERVER_CLIENT_ID     7glm2hp5rgqv59h3levngplbpq
CUSTOMER_COGNITO_SERVER_CLIENT_SECRET <stored>
CUSTOMER_COGNITO_REGION               ap-southeast-1
```

Loaded by the pod via the existing Secrets Manager bootstrap (no new
mechanism). The ConfigMap (`license-server-config`) only sets non-secret
defaults (e.g. `CUSTOMER_COGNITO_REGION`).

---

## 4. License-server code changes

| Area | Path | Change |
|---|---|---|
| Customer Cognito client | `src/services/customerCognito.service.ts` | New. Wraps `SignUp`, `ConfirmSignUp`, `InitiateAuth`, MFA TOTP enrol/verify, `SetUserMFAPreference`, `ForgotPassword`/`ConfirmForgotPassword`, `GlobalSignOut`, `AdminAddUserToGroup`. |
| Routes | `src/routes/customerAuth.ts` | New. Mounted at `/api/customer/auth` (gated by `CUSTOMER_AUTH_ENABLED`). |
| App wiring | `src/index.ts` | Registers the new router and lists it in `/api`. |
| Dual-pool JWT verifier | `src/auth/cognito.auth.ts` | Builds two `CognitoJwtVerifier`s (staff + customer); `verifyToken` tries both and tags the request with `pool: 'staff' \| 'customer'`. Customer-pool tokens **cannot** be admin. |
| Auth user shape | `src/auth/index.ts` | `AuthUser` gains `pool?: 'staff' \| 'customer'`. |
| Database | `prisma/schema.prisma` | `Customer` gains `cognitoSub` (unique nullable), `cognitoPool`, `mfaEnabledAt`. |
| Migration | `prisma/sql/2026-04-25-customer-cognito.sql` | Idempotent SQL for ops to apply against RDS. |
| ConfigMap | `k8s/eks/configmap.yaml` | Documents the new vars; only `CUSTOMER_COGNITO_REGION` is non-secret. |
| Local dev | `.env.example` | New `CUSTOMER_*` block. |

### Endpoints (`/api/customer/auth/*`)

All routes share the `authRateLimit` middleware (10 attempts / 15 min).

| Method | Path | Purpose |
|---|---|---|
| POST | `/signup` | `SignUp` → returns `userSub`, `userConfirmed`. Creates a local `customers` row keyed by email and stores `cognitoSub`. |
| POST | `/confirm` | `ConfirmSignUp` (email code) and `AdminAddUserToGroup` → `customer`. |
| POST | `/resend` | `ResendConfirmationCode`. |
| POST | `/login` | `InitiateAuth` (USER_PASSWORD_AUTH). Returns either tokens or an MFA challenge `{ challengeName, session }`. |
| POST | `/mfa/challenge` | `RespondToAuthChallenge` for `SOFTWARE_TOKEN_MFA`. |
| POST | `/forgot-password` | `ForgotPassword`. Always returns `{success:true}` (no enumeration). |
| POST | `/reset-password` | `ConfirmForgotPassword`. |
| POST | `/mfa/totp/associate` *(auth)* | `AssociateSoftwareToken` → `{ secretCode, otpauthUri }`. |
| POST | `/mfa/totp/verify` *(auth)* | `VerifySoftwareToken` and on `SUCCESS` set MFA preference + `customers.mfa_enabled_at`. |
| POST | `/mfa/preference` *(auth)* | `SetUserMFAPreference(enabled)`. |
| POST | `/logout` *(auth)* | `GlobalSignOut`. |

`(auth)` = requires a valid customer-pool Bearer token; the dual-pool verifier
handles either.

Error mapping is centralised: `UsernameExistsException` → 409,
`InvalidPasswordException` → 400, `Code{Mismatch,Expired}Exception` → 400,
`NotAuthorizedException` → 401, `UserNotConfirmedException` → 403,
`{TooManyRequests,LimitExceeded}Exception` → 429.

### Database changes

```sql
ALTER TABLE license_server.customers
  ADD COLUMN IF NOT EXISTS cognito_sub      TEXT,
  ADD COLUMN IF NOT EXISTS cognito_pool     TEXT,
  ADD COLUMN IF NOT EXISTS mfa_enabled_at   TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS customers_cognito_sub_key
  ON license_server.customers (cognito_sub) WHERE cognito_sub IS NOT NULL;
```

Existing local-password customers continue to work via the legacy
`/api/portal/auth/*` flow until they are migrated to Cognito.

---

## 5. Deploy / rollout

1. Apply the SQL migration (or run `prisma db push` from a pod):
   ```bash
   $KCTL exec -n preprod deploy/license-server -- \
     psql "$DATABASE_URL" -f /app/prisma/sql/2026-04-25-customer-cognito.sql
   ```
2. Build + push image (the new code already reads
   `CUSTOMER_COGNITO_*` from Secrets Manager):
   ```bash
   cd LicenseServer/k8s/eks && ./deploy.sh all
   ```
3. Restart pods so they pick up the refreshed Secrets Manager value:
   ```bash
   $KCTL rollout restart deploy/license-server -n preprod
   $KCTL rollout status  deploy/license-server -n preprod
   ```
4. Smoke tests (see §6).

To disable the public surface again, set `CUSTOMER_AUTH_ENABLED=false` in
Secrets Manager and restart the pods. Every `/api/customer/auth/*` route then
returns 404 without changing routing or Kong config.

---

## 6. Verification from the bastion

```bash
KCTL=/c/Users/justin/bin/kubectl.exe

# Pool sanity
aws cognito-idp describe-user-pool --region ap-southeast-1 \
  --user-pool-id ap-southeast-1_7KTxiTaT8 \
  --query 'UserPool.{Name:Name,MFA:MfaConfiguration,DeletionProtection:DeletionProtection}'

# App clients
aws cognito-idp list-user-pool-clients --region ap-southeast-1 \
  --user-pool-id ap-southeast-1_7KTxiTaT8

# Secrets present?
aws secretsmanager get-secret-value --region ap-southeast-1 \
  --secret-id preprod/license-server --query 'SecretString' --output text \
  | tr ',' '\n' | grep -i CUSTOMER_

# Public endpoint reachable
curl -s https://licensing.agencio.cloud/api | grep customerAuth

# Sign up a test user (returns userSub + userConfirmed=false)
curl -s -X POST https://licensing.agencio.cloud/api/customer/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"test+'$RANDOM'@example.com","password":"TestPassword!2026"}'
```

To exercise without DNS, hit Kong by Host header:
```bash
curl -s -H 'Host: licensing.agencio.cloud' \
  https://konggw.preprod.agencio.cloud/api/customer/auth/signup \
  -H 'Content-Type: application/json' -d '{...}'
```

---

## 7. Operations cheat-sheet

| Task | Command |
|---|---|
| List recent customer signups | `aws cognito-idp list-users --region ap-southeast-1 --user-pool-id ap-southeast-1_7KTxiTaT8 --limit 20` |
| Disable a customer | `aws cognito-idp admin-disable-user --region ap-southeast-1 --user-pool-id ap-southeast-1_7KTxiTaT8 --username <email>` |
| Force MFA reset | `aws cognito-idp admin-set-user-mfa-preference --region ap-southeast-1 --user-pool-id ap-southeast-1_7KTxiTaT8 --username <email> --software-token-mfa-settings Enabled=false,PreferredMfa=false` |
| Promote to `customer-admin` | `aws cognito-idp admin-add-user-to-group --region ap-southeast-1 --user-pool-id ap-southeast-1_7KTxiTaT8 --username <email> --group-name customer-admin` |
| Rotate server client secret | `aws cognito-idp update-user-pool-client … --generate-secret` then update Secrets Manager and `kubectl rollout restart`. |

---

## 8. Threat-model notes

- **Audience separation**: The token verifier tags `pool` and never trusts a
  customer-pool token for staff/admin actions.
- **No SMS MFA**: only TOTP is enabled, eliminating SIM-swap and SMS pumping
  cost.
- **Email enumeration**: `prevent-user-existence-errors=ENABLED` on both
  clients; `forgot-password` always returns `success:true`.
- **Password storage**: never hashed locally for Cognito-managed customers;
  the `customers.password_hash` column is set to a random sentinel
  (`cognito:<rand>`) so the legacy `bcrypt` login path cannot accept that
  account.
- **Rate limiting**: every `/api/customer/auth/*` route uses `authRateLimit`
  (10 attempts / 15 min, IP-keyed), backed by Redis when available.
- **Token revocation**: enabled on both app clients; logout calls
  `GlobalSignOut`.
- **Deletion protection**: pool is `ACTIVE` so accidental delete needs an
  explicit `update-user-pool --deletion-protection INACTIVE` first.

---

## 9. Files & references

- Service:    `src/services/customerCognito.service.ts`
- Routes:     `src/routes/customerAuth.ts`
- Verifier:   `src/auth/cognito.auth.ts`
- Schema:     `prisma/schema.prisma` + `prisma/sql/2026-04-25-customer-cognito.sql`
- ConfigMap:  `k8s/eks/configmap.yaml`
- Deployment reference: `docs/agencioaws/DEPLOYMENT_REFERENCE.md`
- This document: `docs/agencioaws/CUSTOMER_AUTH.md`
