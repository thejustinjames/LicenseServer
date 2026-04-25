# License Server — 2026-04-25 Change Log

End-to-end record of the auth/CICD/UX work completed on **2026-04-25** for
the License Server (`SILO/PreProduction/license-server`) running in EKS
`ag-np-cluster` (Singapore, account `772693061584`).

---

## 1. Goal

Replace the single legacy local-bcrypt login flow with a Cognito-backed
two-pool model:

- **Staff pool** (`ap-southeast-1_y6HkbFYfL`, the existing `agencio.cloud`
  directory) for License Server admins, MFA enforced.
- **New customer pool** (`ap-southeast-1_7KTxiTaT8`, `ag-license-customers`)
  for external paying users, MFA optional.

…with a **single login entry point at `/`** for both audiences, and a cog
icon that surfaces `/admin.html` only for admin users.

---

## 2. Completed

### 2.1 AWS infrastructure

| Resource | Action | ID / value |
|---|---|---|
| Cognito user pool | **Created** `ag-license-customers` | `ap-southeast-1_7KTxiTaT8` (deletion-protected, MFA OPTIONAL/TOTP-only, password ≥12, email-only sign-in, verified-email recovery) |
| Customer web client (no secret, SRP) | **Created** | `2tolovmjlpk3u9v3se5v4kh3g1` (`ag-license-customers-web`) |
| Customer server client (with secret) | **Created** | `7glm2hp5rgqv59h3levngplbpq` (`ag-license-customers-server`); secret stored in Secrets Manager |
| Customer pool groups | **Created** | `customer`, `customer-admin`, `staff-support` |
| Staff pool admin group | **Created** | `license-admins` (on existing `ap-southeast-1_y6HkbFYfL`) |
| Staff pool admin client | **Created** | `r88um79javddi0gkq32pusin9` (`license-server-admin`, no secret, `ALLOW_ADMIN_USER_PASSWORD_AUTH` + `ALLOW_REFRESH_TOKEN_AUTH`) |
| IAM policy | **Updated** to v3 (default) | `LicenseServer-Service-Policy` — added `cognito-idp:Admin*`, `cognito-idp:SignUp/InitiateAuth/RespondToAuthChallenge/AssociateSoftwareToken/VerifySoftwareToken/SetUserMFAPreference/ForgotPassword/ConfirmForgotPassword/GlobalSignOut/RevokeToken/Forgot*` etc. on both pool ARNs |
| Secrets Manager | **Patched** `preprod/license-server` | Added `CUSTOMER_AUTH_ENABLED`, `CUSTOMER_COGNITO_USER_POOL_ID`, `CUSTOMER_COGNITO_CLIENT_ID`, `CUSTOMER_COGNITO_SERVER_CLIENT_ID`, `CUSTOMER_COGNITO_SERVER_CLIENT_SECRET`, `CUSTOMER_COGNITO_REGION`, `COGNITO_ADMIN_CLIENT_ID`, `ADMIN_GROUP_NAME` |
| K8s secret | **Patched** `license-server-secret` (preprod) | Same keys as above (envFrom carries them to the container) |
| RDS schema | **Migrated** | `license_server.customers` gained `cognito_sub` (unique partial idx), `cognito_pool`, `mfa_enabled_at` (one-shot Job using `postgres:16-alpine`) |
| First admin | **Bootstrapped** | `justin@agencio.cloud` already existed, added to `license-admins` group; TOTP MFA already enrolled and preferred |

### 2.2 Code (server)

| Path | Status | Purpose |
|---|---|---|
| `src/services/customerCognito.service.ts` | **new** | Customer pool wrapper: SignUp, ConfirmSignUp, login (`AdminInitiateAuth` against server client + `SECRET_HASH`), TOTP MFA, password reset, `GlobalSignOut`. |
| `src/services/adminCognito.service.ts` | **new** | Staff pool wrapper: invite (`AdminCreateUser`), login, password change challenge, MFA setup challenge + verify, TOTP challenge, `enforceMfaPreference`, **`hasTotpEnforced` (5-min cached)** for the admin gate. |
| `src/auth/cognito.auth.ts` | **updated** | Dual-pool JWT verifier; multi-client-ID per pool; surfaces `pool`, `amr`, `mfaAuthenticated` on the user object. |
| `src/auth/index.ts`, `src/types/index.ts` | **updated** | `AuthUser` gains `pool`, `amr`, `mfaAuthenticated`. |
| `src/routes/customerAuth.ts` | **new** | `/api/customer/auth/*` — signup, confirm, resend, login, MFA challenge, forgot/reset password, MFA self-service (TOTP associate/verify, preference), logout. Feature-flagged on `CUSTOMER_AUTH_ENABLED`. Uses `crypto.randomBytes(32)` for the local sentinel password. Refuses to run unless `AUTH_PROVIDER=cognito`. |
| `src/routes/adminAuth.ts` | **new** | `/api/admin/auth/*` — login, NEW_PASSWORD_REQUIRED, MFA setup start/verify, TOTP challenge, invite/disable/remove-role/reset-password (admin-gated). |
| `src/routes/auth.ts` | **new** | **Unified** `/api/auth/*` — `login`, `mfa/challenge`, `signup`, `confirm`, `forgot-password`, `reset-password`, `logout`. Email-domain routes the call to staff or customer pool. |
| `src/middleware/admin.ts` | **updated** | `requireAdmin` now requires `pool='staff'` AND `hasTotpEnforced(email)` (cached `AdminGetUser.PreferredMfaSetting`); `ADMIN_REQUIRE_MFA` env can disable for dev. The `amr`-claim check was removed because Cognito does **not** emit `amr` for direct user-pool flows. |
| `src/index.ts` | **updated** | Mounts `/api/auth`, `/api/admin/auth`, `/api/customer/auth`. Lists them at `/api`. |
| `prisma/schema.prisma` | **updated** | `Customer` gains `cognitoSub`, `cognitoPool`, `mfaEnabledAt`. |
| `prisma/sql/2026-04-25-customer-cognito.sql` | **new** | Idempotent migration (additive `ADD COLUMN IF NOT EXISTS`, partial unique index). |
| `bootstrap.mjs` | **updated** | Allow-list extended with the new keys. **Note:** see §4 — bootstrap is effectively a no-op in the current container CMD; the K8s secret carries the runtime env. |
| `k8s/eks/configmap.yaml` | **updated** | Documents non-secret defaults (`CUSTOMER_COGNITO_REGION`, `COGNITO_ADMIN_GROUP=license-admins`, `ADMIN_GROUP_NAME=license-admins`, `ADMIN_REQUIRE_MFA=true`). |
| `k8s/eks/deployment.yaml` | **updated** | Added the missing `secretRef: license-server-secret` envFrom (it was being added out-of-band in the live cluster; without it Prisma can't read DATABASE_URL before bootstrap). |
| `.env.example` | **updated** | New `CUSTOMER_*` and `COGNITO_ADMIN_*` blocks. |

### 2.3 Code (frontend)

| Path | Status | Purpose |
|---|---|---|
| `public/index.html` | **updated** | Removed Google/Facebook social-login buttons, "Remember me", and the social-divider markup (none of it was wired). Login form now has a hidden TOTP field that appears on the MFA step. |
| `public/app.js` | **updated** | Login posts to `/api/auth/login`. On `SOFTWARE_TOKEN_MFA` challenge the form switches to the TOTP step; on tokens it decodes the ID token, sets `user.isAdmin=true` iff `pool='staff'` and `cognito:groups` contains `license-admins`, stores under unified keys (`lsAccessToken`/`lsRefreshToken`/`lsUser`), and calls `updateAuthUI` which un-hides the cog (`#adminLink`) for admins. Signup posts to `/api/auth/signup`; forgot-password to `/api/auth/forgot-password`; logout to `/api/auth/logout`. `api()` helper bounces to the login modal on 401. |
| `public/admin.html` | **updated** | Inline login form removed. The `#login` section is now a brief "Redirecting…" stub with a manual link to `/`. |
| `public/admin.js` | **updated** | Reads unified `lsAccessToken`/`lsUser` from localStorage. If missing, or `pool!='staff'`, or not admin, it redirects to `/`. Logout calls `/api/auth/logout` and redirects to `/`. The `api()` helper redirects to `/` on 401/403. |

### 2.4 Documentation

| Path | Status |
|---|---|
| `docs/agencioaws/DEPLOYMENT_REFERENCE.md` | Updated — Cognito section now lists both pools, customer pool, app clients, license-admins group, MFA enforcement, and pointers to the two new docs. |
| `docs/agencioaws/CUSTOMER_AUTH.md` | **new** — full pool/clients/IAM/secrets layout, code change index, endpoint table, deploy steps, bastion verification, ops cheat-sheet, threat-model notes. |
| `docs/agencioaws/ADMIN_AUTH.md` | **new** — staff pool admin group, license-server-admin client, full first-login UX, app-layer MFA enforcement (`PreferredMfaSetting`), bootstrap of first admin out-of-band, ops cheat-sheet. |
| `docs/agencioaws/TEST_DATA.md` | **new** — test SKUs, sample licenses per tier, activation/seat policy, admin "Generate Test License" button, `POST /api/admin/licenses/test` endpoint, cleanup SQL. |
| `docs/agencioaws/CHANGE_LOG_2026-04-25.md` | **new** — this file. |
| `licensing_seeds/README.md` | **new** — folder of CommonJS seeders that can be piped into a running pod (no TypeScript build step needed). |

### 2.5 Deployment

| Build | Tag | Pushed | Notes |
|---|---|---|---|
| Jenkins #3 | `dev-3` + `latest` + `dev` | 2026-04-25 11:48Z | First image with new code. Customer auth disabled because bootstrap secrets weren't loaded (allow-list miss) and verifier didn't have customer client wired. |
| Jenkins #4 | `dev-4` + `latest` + `dev` | 2026-04-25 12:06Z | bootstrap.mjs allow-list extended; deployment.yaml restored `secretRef`. Still no customer verifier in env (root cause: bootstrap process exits before app starts). |
| Jenkins #5 | `dev-5` + `latest` + `dev` | 2026-04-25 12:35Z | Admin MFA gate switched from `amr`-claim to cached `PreferredMfaSetting` check. Admin login + MFA + protected endpoint **end-to-end PASS** for `justin@agencio.cloud`. |
| Jenkins #6 | `dev-6` + `latest` + `dev` | 2026-04-25 13:13Z | Unified `/api/auth/*` endpoint live; single login form; cog icon appears for admins; `/admin.html` becomes dashboard-only. |

Each build is followed by `kubectl rollout restart deploy/license-server -n preprod`.

### 2.6 Smoke tests passed

- **DB migration**: `psql \\d license_server.customers` shows the three new columns + unique partial index on `cognito_sub`.
- **Pod startup**: both replicas log `Cognito staff verifier initialized for pool ap-southeast-1_y6HkbFYfL (2 clients)` AND `Cognito customer verifier initialized for pool ap-southeast-1_7KTxiTaT8 (2 clients)`.
- **Public endpoints**: `/api` lists `auth, admin, portal, customerAuth, adminAuth, validation, desktop, webhooks, health, ready`. `/health/ready` returns DB + S3 OK.
- **Admin login**: `POST /api/auth/login` with `justin@agencio.cloud` / `1Amersham!` → `{"pool":"staff","challenge":{"challengeName":"SOFTWARE_TOKEN_MFA"…}}`. Following with the TOTP code returns ID/access/refresh tokens.
- **Admin gate**: with the issued access token, `POST /api/admin/auth/invite` with empty body → `400 Validation` (middleware accepted MFA, blocked only on the empty payload). `POST /api/admin/auth/invite` without a token → `401`. `GET /api/admin/customers` → `200` with the local customer rows.
- **Customer auth surface**: `POST /api/customer/auth/signup` with `{}` → `400 Validation` (route mounted, feature flag green; not 404 / 503).

### 2.7 Memory saved (`~/.claude/projects/.../memory/`)

- `MEMORY.md` (index)
- `jenkins_server.md` — server URL, layout, the prior NPE fix
- `jenkins_api_token.md` — secret, local-only, instructions to rotate
- `licenseserver_jenkins_pipeline.md` — pipeline path, tag policy, trigger commands, no SCM webhook
- `licenseserver_eks_quirks.md` — secret envFrom drift + bootstrap.mjs `&&` chain pitfall
- `licenseserver_cognito.md` — pool IDs, clients, IAM, env-key map
- `feedback_git_commit_identity.md` — never commit in Claude's name; use the user's configured git identity only

### 2.8 Side fixes (related infra)

- **Jenkins NPE on the All-jobs page** (`View.getOwner()` returned `null` on AllView in the SILO folder + two SILO sub-folders). Fixed via the script console: walked every folder's `folderViews` reflectively, called `view.setOwner(folder)` for any view with a null owner, set `primaryView='All'` on the 27 folders where the field was null, and saved each `AbstractFolder`. Root jobs listing returned to normal without a Jenkins restart.

---

## 3. TODO / pending

### 3.1 Smoke tests not yet run

- **Customer signup end-to-end** — `POST /api/auth/signup` with a real inbox you can check, follow the Cognito confirmation email to `POST /api/auth/confirm`, then `/api/auth/login`. Will exercise the customer pool path that admin-bootstrap doesn't touch.
- **Admin invite flow** — `POST /api/admin/auth/invite` while authenticated as `justin@agencio.cloud` (with a real second admin's email). Cognito should email a temp password; second admin then runs through `/login` → `password/new` → `mfa/setup/start` → `mfa/setup/verify`.
- **TOTP enrolment via UI** — the index.html flow currently handles login + MFA *challenge* but not first-time TOTP *enrolment* (`MFA_SETUP` challenge). New customer accounts can opt into MFA via `/api/customer/auth/mfa/totp/associate` + `verify` after they're logged in; not yet wired into the UI.

### 3.2 UX polish (next session)

- **Frosted dashboard behind the admin redirect** — `/admin.html` now redirects on missing token rather than rendering a frosted modal. If you want the page to *briefly* render a frosted backdrop during the redirect, add `backdrop-filter: blur(10px)` + a darkened overlay to `.admin-main` and `.sidebar` while `#login` is the active section. Lower priority than the functional path.
- **Cog icon styling / placement** — currently `#adminLink` lives next to `userEmail`/Dashboard/Logout in the header; consider a tooltip and pulse-on-first-login affordance.
- **Token refresh** — the access token expires after ~1h; today the `api()` helper bounces the user back to login. Wire `/api/auth/refresh` to call Cognito `InitiateAuth` with `REFRESH_TOKEN_AUTH` and rotate transparently.
- **Cookie-based auth** vs localStorage tokens — current path stores tokens in `localStorage` (XSS-exposed). For a production hardening pass, set httpOnly cookies for the access + refresh tokens and CSRF-token the mutating endpoints.

### 3.3 Backend cleanup

- **Replace bootstrap.mjs `&&` chain** so Secrets Manager becomes the single source of truth and the K8s secret can shrink. Two viable shapes:
  1. `node --import ./bootstrap.mjs dist/index.js` — bootstrap mutates `process.env` in the same process as the app.
  2. Rewrite bootstrap to write env vars to a `/tmp/.env` file, then `set -a && . /tmp/.env && node dist/index.js`. Removes the K8s-secret bootstrap mirror.
- **Legacy `/api/portal/auth/*` (bcrypt)** is still mounted but the unified flow has superseded it. With no users on it (greenfield), remove the legacy endpoints in a follow-up commit and drop `Customer.passwordHash` from the schema once the JWT provider is gone.
- **Customer Cognito UI** — wire `/api/customer/auth/mfa/totp/{associate,verify,preference}` into the customer dashboard so customers can self-enrol TOTP.

### 3.4 Operational

- **Cleanup of evicted pods on `ip-10-2-6-7`** — the node was under disk pressure during the rollouts and produced ~25 evicted license-server pods. Already deleted manually but the underlying node-pressure should be investigated (it also evicted teams-service / runwayml-service). Not on the License Server team's plate but worth a Slack ping to platform.
- **Cloudbees-folder plugin upgrade** on Jenkins to permanently close the View-owner NPE class of bugs.
- **Schedule a follow-up agent in 2 weeks** to:
  - verify the cog flow is still working in the wild,
  - check the customer pool for any orphaned non-confirmed signups,
  - sweep evicted pods,
  - bump cloudbees-folder if a release is out.

---

## 4. Architectural notes worth carrying forward

- **Cognito does not emit `amr` on tokens issued via `AdminInitiateAuth` / `AdminRespondToAuthChallenge`**. Only Hosted-UI / federated flows include the claim. The MFA gate must therefore be derived from `AdminGetUser.PreferredMfaSetting` (or from an in-app session marker), **not** from `amr`.
- **`bootstrap.mjs && node dist/index.js` does not propagate `process.env` mutations** to the second `node` process. Today the K8s secret carries every runtime env var; bootstrap is effectively a no-op for env injection. Updating bootstrap's allow-list is harmless future-proofing only.
- **Repo `deployment.yaml` was missing `secretRef: license-server-secret`** — the live cluster carried the secret envFrom out-of-band. A `kubectl apply -k` reverted it and crashed Prisma at startup until the manifest was patched. The repo manifest is now authoritative again; never re-introduce that drift.
- **Domain-based pool routing** (`STAFF_EMAIL_DOMAINS`, default `agencio.cloud`) is the simplest signal, but it forks UX based on email format. If staff ever need non-`agencio.cloud` addresses, the unified endpoint can fall back to "try staff pool first, then customer on `NotAuthorizedException`" — at the cost of one extra Cognito call per customer login.
- **Greenfield assumption is load-bearing in this design**. The unified entry point treats `password_hash` rows in `customers` as legacy junk; if there ever were real bcrypt-only customers, they'd now be locked out. Confirmed during the 2026-04-25 work that there are none in production.

---

## 5. Files & references

- Cognito setup: `docs/agencioaws/CUSTOMER_AUTH.md`, `docs/agencioaws/ADMIN_AUTH.md`
- Live deployment: `docs/agencioaws/DEPLOYMENT_REFERENCE.md`
- Migration: `prisma/sql/2026-04-25-customer-cognito.sql`
- Backend routers: `src/routes/auth.ts`, `src/routes/adminAuth.ts`, `src/routes/customerAuth.ts`
- Backend services: `src/services/adminCognito.service.ts`, `src/services/customerCognito.service.ts`
- Backend gates: `src/middleware/admin.ts`, `src/auth/cognito.auth.ts`
- Frontend: `public/index.html`, `public/app.js`, `public/admin.html`, `public/admin.js`
- Jenkins job: `SILO/PreProduction/license-server` at `http://47.130.189.172:8080/`
- ECR: `772693061584.dkr.ecr.ap-southeast-1.amazonaws.com/ag-license-server` (latest = `dev-6` at the time of writing)
- This document: `docs/agencioaws/CHANGE_LOG_2026-04-25.md`
