# License Server — Admin Cognito + MFA

This document captures **License Server admin** authentication. Admins live
in the existing **agencio.cloud staff Cognito pool**
(`ap-southeast-1_y6HkbFYfL`) — the same directory used by the rest of
Agencio. They are gated by membership in the `license-admins` group and MFA
(TOTP) is required at the application layer for every admin operation.

Snapshot: **2026-04-25**, region `ap-southeast-1`, account `772693061584`.

---

## 1. At a glance

| Property | Value |
|---|---|
| Pool | `ap-southeast-1_y6HkbFYfL` (existing agencio.cloud staff pool) |
| MFA on pool | `OPTIONAL`, TOTP enabled at the pool level (already set) |
| Admin group | `license-admins` (new, created 2026-04-25) |
| Admin app client | `r88um79javddi0gkq32pusin9` (`license-server-admin`, no secret, `ALLOW_ADMIN_USER_PASSWORD_AUTH` + `ALLOW_REFRESH_TOKEN_AUTH`) |
| Browser client (existing) | `381dr21a72padpvi3lsajt2rfo` (shared SRP web client, untouched) |
| App-layer enforcement | `requireAdmin` rejects any token without `pool=staff` and `amr` proving MFA when `ADMIN_REQUIRE_MFA=true` |
| Routes | `/api/admin/auth/*` (login + invite + MFA enrol) |

The browser client is unchanged — admins can still log in via SRP from the
agencio.cloud web app. The new `license-server-admin` client is used by the
License Server itself for `AdminInitiateAuth` (driven via IAM/IRSA, no
client secret on the wire).

---

## 2. Why this design

- **Single staff directory**: admins are the same people who already exist
  in agencio.cloud Cognito. Re-using that pool means SSO-friendly identity,
  one place to disable a leaver, and shared password/MFA policy.
- **App-layer MFA gate**: keeping the pool's MFA at `OPTIONAL` avoids
  blocking unrelated agencio.cloud users who don't have MFA yet, but the
  License Server still rejects admin actions whose token didn't go through
  TOTP. Enforcement is in `src/middleware/admin.ts` and reads `amr` from the
  Cognito access token.
- **Group-based authorization**: adding/removing the `license-admins` group
  is the only operation needed to grant or revoke admin on the License
  Server, with no DB change.
- **Server-driven login flow**: the License Server uses
  `AdminInitiateAuth` against a dedicated client (`license-server-admin`)
  authenticated by IRSA. The shared browser SRP client is never used to
  carry passwords through the License Server.

---

## 3. Resources

### Cognito (staff pool `ap-southeast-1_y6HkbFYfL`)
- Group `license-admins` — License Server admins; MFA required at the app
  layer.
- App client `license-server-admin` (`r88um79javddi0gkq32pusin9`) — no secret,
  flows: `ALLOW_ADMIN_USER_PASSWORD_AUTH`, `ALLOW_REFRESH_TOKEN_AUTH`,
  `prevent-user-existence-errors=ENABLED`, token revocation enabled, ID/access 1h, refresh 1d.
- Pool-level TOTP MFA already enabled (`SoftwareTokenMfaConfiguration.Enabled=true`,
  `MfaConfiguration=OPTIONAL`).

### IAM
The role `Preprod-LicenseServerService-Role` got new permissions on the
staff pool ARN (policy version `v3`, default): `AdminCreateUser`,
`AdminAddUserToGroup`/`AdminRemoveUserFromGroup`, `AdminListGroupsForUser`,
`AdminInitiateAuth`/`AdminRespondToAuthChallenge`, `AdminUserGlobalSignOut`,
`AdminSetUserMFAPreference`, `AdminDisableUser`/`AdminEnableUser`,
`AdminResetUserPassword`/`AdminSetUserPassword`,
`AdminUpdateUserAttributes`, `AdminGetUser`, `ListUsers`, `ListGroups`,
`GetGroup`, `DescribeUserPool*`. Customer-pool actions remain on the new
pool ARN.

### Secrets Manager (`preprod/license-server`)
Added:

```
COGNITO_ADMIN_CLIENT_ID  r88um79javddi0gkq32pusin9
ADMIN_GROUP_NAME         license-admins
```

Existing `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` retained.

### ConfigMap (`license-server-config`)
Non-secret defaults:
```
COGNITO_ADMIN_GROUP: license-admins
ADMIN_GROUP_NAME:    license-admins
ADMIN_REQUIRE_MFA:   "true"
```

---

## 4. License-server code

| Area | Path | Change |
|---|---|---|
| Admin Cognito client | `src/services/adminCognito.service.ts` | New. AdminCreateUser invite, AdminInitiateAuth login, NEW_PASSWORD_REQUIRED + MFA_SETUP + SOFTWARE_TOKEN_MFA challenge handlers, MFA preference enforcement. Crypto-strong temp password generator. |
| Admin auth routes | `src/routes/adminAuth.ts` | New. Mounted at `/api/admin/auth`. |
| Admin gate | `src/middleware/admin.ts` | Now also enforces `pool=staff` and `mfaAuthenticated=true` when `AUTH_PROVIDER=cognito` (skipped iff `ADMIN_REQUIRE_MFA=false`). |
| JWT verifier | `src/auth/cognito.auth.ts` | Multi-client-ID support per pool; surfaces `amr` and `mfaAuthenticated` on the user object. |
| Type | `src/types/index.ts`, `src/auth/index.ts` | `AuthUser` gains `pool`, `amr`, `mfaAuthenticated`. |

### Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/admin/auth/login` | public | `AdminInitiateAuth` (USERNAME+PASSWORD). Returns tokens *or* a challenge (`NEW_PASSWORD_REQUIRED` / `MFA_SETUP` / `SOFTWARE_TOKEN_MFA`). |
| POST | `/api/admin/auth/password/new` | public (with session) | Respond to `NEW_PASSWORD_REQUIRED`. |
| POST | `/api/admin/auth/mfa/setup/start` | public (with session) | First-time TOTP enrolment from `MFA_SETUP` challenge. Returns `secretCode` + `otpauthUri`. |
| POST | `/api/admin/auth/mfa/setup/verify` | public (with session) | Verify TOTP, complete `MFA_SETUP`, set permanent MFA preference. Returns tokens. |
| POST | `/api/admin/auth/mfa/challenge` | public (with session) | Respond to `SOFTWARE_TOKEN_MFA` on subsequent logins. Returns tokens. |
| POST | `/api/admin/auth/invite` | admin+MFA | `AdminCreateUser` + add to `license-admins`; Cognito emails the invitee a temp password. |
| POST | `/api/admin/auth/disable` | admin+MFA | `AdminDisableUser` + `AdminUserGlobalSignOut`. |
| POST | `/api/admin/auth/remove-role` | admin+MFA | Remove the user from `license-admins` (does not delete the staff account). |
| POST | `/api/admin/auth/reset-password` | admin+MFA | Force the user back to `FORCE_CHANGE_PASSWORD`. |

“admin+MFA” means the call goes through `authenticate` (Cognito JWT) and
`requireAdmin`, which itself rejects any token without `amr` indicating MFA.

### First-login UX (server side)

```
POST /login                                        → 200 challenge=NEW_PASSWORD_REQUIRED
POST /password/new {newPassword, session}          → 200 challenge=MFA_SETUP
POST /mfa/setup/start {email, session}             → 200 secretCode, otpauthUri, session'
POST /mfa/setup/verify {email, code, session'}     → 200 tokens   (MFA preference enforced)
```

### Subsequent logins

```
POST /login                                        → 200 challenge=SOFTWARE_TOKEN_MFA
POST /mfa/challenge {email, code, session}         → 200 tokens
```

### Token enforcement

`requireAdmin` blocks any admin endpoint when:
- `req.user` missing → 401
- `req.user.isAdmin = false` → 403
- AUTH_PROVIDER=cognito and `pool !== 'staff'` → 403 `Admin token must originate from the staff pool`
- AUTH_PROVIDER=cognito, `ADMIN_REQUIRE_MFA != "false"`, and the token's `amr` does not contain `mfa`/`totp_mfa` → 403 `code: ADMIN_MFA_REQUIRED`

---

## 5. Bootstrap (very first admin)

`/api/admin/auth/invite` requires an *existing* MFA-authenticated admin, so
the very first `license-admins` member must be added out-of-band:

```bash
# Pick an existing staff user already in the pool (or create one):
EMAIL=admin@agencio.cloud
aws cognito-idp admin-create-user --region ap-southeast-1 \
  --user-pool-id ap-southeast-1_y6HkbFYfL \
  --username $EMAIL \
  --user-attributes Name=email,Value=$EMAIL Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL

aws cognito-idp admin-add-user-to-group --region ap-southeast-1 \
  --user-pool-id ap-southeast-1_y6HkbFYfL \
  --username $EMAIL --group-name license-admins
```

The user receives the standard Cognito invitation email. They then run the
self-service flow above to set a password and enrol TOTP. From that point
on, invites flow through `/api/admin/auth/invite`.

---

## 6. Verification from the bastion

```bash
# Pool MFA + groups
aws cognito-idp get-user-pool-mfa-config --region ap-southeast-1 \
  --user-pool-id ap-southeast-1_y6HkbFYfL
aws cognito-idp list-groups --region ap-southeast-1 \
  --user-pool-id ap-southeast-1_y6HkbFYfL

# Admin client present?
aws cognito-idp list-user-pool-clients --region ap-southeast-1 \
  --user-pool-id ap-southeast-1_y6HkbFYfL --output table

# Admin endpoint reachable?
curl -s https://licensing.agencio.cloud/api | grep adminAuth || echo "NOT WIRED"

# Try the public login route (will return a challenge JSON for a real user)
curl -s -X POST https://licensing.agencio.cloud/api/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@agencio.cloud","password":"<temp>"}'
```

---

## 7. Operations cheat-sheet

| Task | Command |
|---|---|
| Add admin (out-of-band) | `aws cognito-idp admin-add-user-to-group --user-pool-id ap-southeast-1_y6HkbFYfL --username <email> --group-name license-admins` |
| List admins | `aws cognito-idp list-users-in-group --user-pool-id ap-southeast-1_y6HkbFYfL --group-name license-admins` |
| Revoke admin | `aws cognito-idp admin-remove-user-from-group --user-pool-id ap-southeast-1_y6HkbFYfL --username <email> --group-name license-admins` |
| Force re-enrol MFA | `aws cognito-idp admin-set-user-mfa-preference --user-pool-id ap-southeast-1_y6HkbFYfL --username <email> --software-token-mfa-settings Enabled=false,PreferredMfa=false` then have the user log in again |
| Force password reset | `aws cognito-idp admin-reset-user-password --user-pool-id ap-southeast-1_y6HkbFYfL --username <email>` |
| Sign user out everywhere | `aws cognito-idp admin-user-global-sign-out --user-pool-id ap-southeast-1_y6HkbFYfL --username <email>` |

---

## 8. Threat-model notes

- **MFA cannot be bypassed by removing `ADMIN_REQUIRE_MFA`** in production
  because the staff Cognito pool already issues `amr=["mfa", "totp_mfa"]`
  only after a successful TOTP challenge. Setting
  `ADMIN_REQUIRE_MFA=false` only relaxes app-layer enforcement; you would
  still need a token from a real pool login.
- **Admin tokens cannot come from the customer pool** — the verifier tags
  `pool` from the JWKS issuer. Even if a customer landed in a group named
  `license-admins`, the middleware refuses any non-staff-pool token.
- **No password is stored locally** for admins. Admin login is a thin
  forwarder to `AdminInitiateAuth`.
- **Temporary passwords** for invites use `crypto.randomInt`-shuffled bytes
  with guaranteed character classes (24 chars by default).
- **First-login flow** binds password and MFA before any token is issued —
  there is no window where an admin holds a non-MFA access token.
- **AdminUserGlobalSignOut** is invoked on disable so existing refresh
  tokens cannot be used after revocation.
- **Self-disable / self-revoke guard**: `/disable` and `/remove-role`
  reject when the email matches the caller's own.

---

## 9. Files & references

- Service:   `src/services/adminCognito.service.ts`
- Routes:    `src/routes/adminAuth.ts`
- Gate:      `src/middleware/admin.ts`
- Verifier:  `src/auth/cognito.auth.ts`
- ConfigMap: `k8s/eks/configmap.yaml`
- Customer Cognito:  `docs/agencioaws/CUSTOMER_AUTH.md`
- Deployment ref:    `docs/agencioaws/DEPLOYMENT_REFERENCE.md`
- This document:     `docs/agencioaws/ADMIN_AUTH.md`
