# hCaptcha — turning bot protection on

The unified login flow at `licensing.agencio.cloud` has hCaptcha wired but
**not yet enabled in preprod**. This is a one-time operator task: register a
site with hCaptcha, store the keys in Secrets Manager + the k8s mirror, and
restart the deployment.

Until the env vars are set the widget stays hidden, the server skips the
captcha verification, and login behaves exactly as it does today.

## Where the captcha lives in the code

| Surface | File | Behaviour |
|---|---|---|
| Server: gate on `/api/auth/login` | `src/routes/auth.ts` | When `HCAPTCHA_SITE_KEY` + `HCAPTCHA_SECRET_KEY` are set, every password-step request must include a valid `captchaToken`; missing/invalid → 400 `CAPTCHA verification failed`. The MFA challenge step is **not** captcha-gated (already protected by the Cognito session token). |
| Server: config endpoint | `src/routes/auth.ts` (`GET /api/auth/captcha-config`) | Frontend calls this on page load to learn whether to render the widget and which site key to use. |
| Server: verifier | `src/services/captcha.service.ts` | Posts the user's response to `https://hcaptcha.com/siteverify`. Failure mode controlled by `CAPTCHA_FAIL_OPEN` (default `false` — fail-closed). |
| Frontend: widget on the login page | `public/index.html` (`<div id="loginCaptcha">`) | Already present, rendered by `app.js` when `captchaConfig.enabled` is true. |
| Frontend: token wiring | `public/app.js` | `handleLogin()` reads the token via `getCaptchaToken('loginCaptcha')` and sends it as `captchaToken` in the login body. Missing token short-circuits with a "Please complete the human-verification check." alert. |
| Frontend: hidden during MFA step | `public/app.js` (`showLoginMfaStep`) | Captcha widget is hidden while the user enters their TOTP, then re-shown when `resetLoginForm` runs. |

## One-time setup

### 1. Register a site at hCaptcha

1. Go to https://dashboard.hcaptcha.com/signup (or log in if you have an account).
2. **Sites** → **New Site**.
3. Fill in:
   - **Hostname(s)**: `licensing.agencio.cloud`. Add any additional hosts the LS frontend will be served from (e.g. `localhost` for local dev).
   - **Difficulty**: `Auto` is fine. `Always Challenge` is more aggressive if needed later.
4. Save. Copy the **Site Key** (public, ~UUID format).
5. Top-right user menu → **Settings** → copy your **Account Secret** (server-side only — treat like a password).

> **Test pair (DO NOT SHIP):** for wiring-only verification, hCaptcha
> publishes `Site Key: 10000000-ffff-ffff-ffff-000000000001` /
> `Secret: 0x0000000000000000000000000000000000000000`. That pair always
> verifies. Use only to confirm the integration works, then swap.

### 2. Push the keys into the deployment

Set both `HCAPTCHA_SITE_KEY` and `HCAPTCHA_SECRET_KEY` in:

1. **AWS Secrets Manager** (source of truth):
   ```bash
   CURRENT=$(aws secretsmanager get-secret-value \
     --secret-id preprod/license-server --region ap-southeast-1 \
     --query SecretString --output text)
   UPDATED=$(node -e "
     const s = JSON.parse(process.argv[1]);
     s.HCAPTCHA_SITE_KEY  = process.argv[2];
     s.HCAPTCHA_SECRET_KEY = process.argv[3];
     s.CAPTCHA_FAIL_OPEN  = 'false';
     process.stdout.write(JSON.stringify(s));
   " "$CURRENT" '<SITE_KEY>' '<SECRET_KEY>')
   aws secretsmanager put-secret-value \
     --secret-id preprod/license-server \
     --secret-string "$UPDATED" --region ap-southeast-1
   ```

2. **k8s Secret mirror** (the Deployment reads via `envFrom`):
   ```bash
   kubectl patch secret license-server-secret -n preprod --type=json -p="[
     {\"op\":\"add\",\"path\":\"/data/HCAPTCHA_SITE_KEY\",   \"value\":\"$(echo -n '<SITE_KEY>'   | base64 -w0)\"},
     {\"op\":\"add\",\"path\":\"/data/HCAPTCHA_SECRET_KEY\", \"value\":\"$(echo -n '<SECRET_KEY>' | base64 -w0)\"}
   ]"
   ```

   The k8s Secret is a hand-synced mirror of `preprod/license-server`. Skipping
   this step means the AWS-side update doesn't reach the pod (same caveat as
   `MTLS_AGENT_CA_ENABLED`).

3. **Restart the pod** so it picks up the new env:
   ```bash
   kubectl rollout restart deploy/license-server -n preprod
   kubectl rollout status   deploy/license-server -n preprod --timeout=120s
   ```

### 3. Verify

```bash
# Server reports captcha as enabled and exposes the site key:
curl -s https://licensing.agencio.cloud/api/auth/captcha-config
# expect: {"enabled":true,"siteKey":"<SITE_KEY>"}

# Login without a captcha token now fails closed:
curl -s -X POST https://licensing.agencio.cloud/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"justin@agencio.cloud","password":"anything"}'
# expect: {"error":"CAPTCHA verification failed"}
```

In a browser at https://licensing.agencio.cloud/ you should see the hCaptcha
widget above the Sign-in button. Solving the challenge + entering valid
credentials should sign you in.

## Operating notes

- **MFA still auto-submits** after the captcha gate — the current 6-digit
  auto-submit behaviour is independent of captcha.
- **Existing sessions** are unaffected; only new logins pass through the
  gate. `kubectl rollout restart` doesn't drop user sessions because they're
  Cognito-issued, not server-side.
- **Disabling later**: blank both env vars + restart. The frontend's
  `/api/auth/captcha-config` will return `{enabled:false}` and the widget
  will not render; server stops verifying.
- **Fail-open vs fail-closed**: `CAPTCHA_FAIL_OPEN=false` (default) means
  if hCaptcha's API itself is unreachable, login is blocked. Flip to `true`
  if availability matters more than strict bot prevention; it's a
  customer-deployment knob.
- **Domain mismatch**: if the site key is registered for the wrong
  hostname, hCaptcha returns `{"success":false,"error-codes":["invalid-or-already-seen-response"]}`
  and login fails with a generic 400. Add the actual served hostname in the
  hCaptcha dashboard's Site settings.

## What this does NOT cover

- Customer signup / password reset / portal already use captcha via
  `/api/portal/auth/captcha-config` (separate flow, unchanged).
- hCaptcha Enterprise / risk scoring isn't wired — current integration uses
  the free siteverify endpoint.
- No rate-limit-on-CAPTCHA-failure logic; existing `authRateLimit`
  middleware still applies per-IP.
