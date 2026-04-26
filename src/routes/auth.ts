/**
 * Unified authentication routes (single entry point for staff + customers).
 *
 * Mounted at `/api/auth`. Email-domain based pool routing: addresses whose
 * domain matches `STAFF_EMAIL_DOMAINS` (default `agencio.cloud`) hit the
 * staff Cognito pool; everyone else hits the customer pool.
 *
 * The frontend (single login form on `/index.html`) only ever talks to
 * these endpoints. Pool-specific routes (`/api/admin/auth/*`,
 * `/api/customer/auth/*`) remain available for admin-only operations
 * (invites, group membership, MFA self-service).
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { authRateLimit } from '../middleware/rateLimit.js';
import { seedSession } from '../middleware/idleTimeout.js';
import { clearSession } from '../config/redis.js';
import { passwordSchema } from '../utils/password.js';
import * as adminAuth from '../services/adminCognito.service.js';
import * as customerAuth from '../services/customerCognito.service.js';
import * as captchaService from '../services/captcha.service.js';
import { logger } from '../services/logger.service.js';

const router = Router();

router.use((_req, res, next) => {
  if ((process.env.AUTH_PROVIDER || 'jwt') !== 'cognito') {
    res.status(503).json({ error: 'Unified auth requires AUTH_PROVIDER=cognito' });
    return;
  }
  next();
});

type Pool = 'staff' | 'customer';

function staffDomains(): string[] {
  const env = process.env.STAFF_EMAIL_DOMAINS || 'agencio.cloud';
  return env.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
}

function poolForEmail(email: string): Pool {
  const at = email.lastIndexOf('@');
  const domain = at >= 0 ? email.slice(at + 1).toLowerCase() : '';
  return staffDomains().includes(domain) ? 'staff' : 'customer';
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  // hCaptcha token from the login form. Required when CAPTCHA is enabled
  // (HCAPTCHA_SITE_KEY + HCAPTCHA_SECRET_KEY set); ignored otherwise.
  captchaToken: z.string().min(1).optional(),
});
const mfaSchema = z.object({
  email: z.string().email(),
  code: z.string().min(6).max(8),
  session: z.string().min(1),
  pool: z.enum(['staff', 'customer']),
});
const signupSchema = z.object({
  email: z.string().email(),
  password: passwordSchema,
  name: z.string().max(100).optional(),
});
const confirmSchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(10),
});
const forgotSchema = z.object({ email: z.string().email() });
const resetSchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(10),
  password: passwordSchema,
});
const tokenOnly = z.object({ accessToken: z.string().min(1).optional() });

// Captcha-config endpoint so the login form on `/index.html` can decide
// whether to render the hCaptcha widget. Mirrors the existing
// `/api/portal/auth/captcha-config` so frontend code can use either.
router.get('/captcha-config', (_req, res: Response) => {
  res.json({
    enabled: captchaService.isCaptchaEnabled(),
    siteKey: captchaService.getCaptchaSiteKey(),
  });
});

router.post('/login', authRateLimit, async (req, res: Response) => {
  try {
    const data = loginSchema.parse(req.body);

    // CAPTCHA gate — only the password step requires it. The MFA challenge
    // step that follows is already gated by the Cognito session token, so
    // we don't ask the user to re-solve a captcha mid-login.
    if (captchaService.isCaptchaEnabled()) {
      const ok = await captchaService.verifyCaptcha(data.captchaToken);
      if (!ok) {
        res.status(400).json({ error: 'CAPTCHA verification failed' });
        return;
      }
    }

    const pool = poolForEmail(data.email);

    if (pool === 'staff') {
      const r = await adminAuth.login(data.email, data.password);
      if (r.kind === 'tokens') {
        await seedSession(r.tokens.accessToken);
        res.json({ pool, tokens: r.tokens });
        return;
      }
      if (r.kind === 'challenge') {
        res.json({ pool, challenge: r.challenge });
        return;
      }
      res.status(401).json({ pool, error: r.error, code: r.code });
      return;
    }

    // customer pool
    const r = await customerAuth.login(data.email, data.password);
    if (r.kind === 'tokens') {
      await seedSession(r.tokens.accessToken);
      res.json({ pool, tokens: r.tokens });
      return;
    }
    if (r.kind === 'challenge') {
      res.json({ pool, challenge: r.challenge });
      return;
    }
    res.status(401).json({ pool, error: r.error, code: r.code });
  } catch (err) {
    handleError(res, err, 'login');
  }
});

router.post('/mfa/challenge', authRateLimit, async (req, res: Response) => {
  try {
    const data = mfaSchema.parse(req.body);
    if (data.pool === 'staff') {
      const r = await adminAuth.respondTotp(data.email, data.code, data.session);
      if (r.kind === 'tokens') {
        await seedSession(r.tokens.accessToken);
        res.json({ pool: data.pool, tokens: r.tokens });
        return;
      }
      res.status(401).json({ pool: data.pool, error: r.kind === 'error' ? r.error : 'MFA failed' });
      return;
    }
    const r = await customerAuth.respondToTotpChallenge(data.email, data.code, data.session);
    if (r.kind === 'tokens') {
      await seedSession(r.tokens.accessToken);
      res.json({ pool: data.pool, tokens: r.tokens });
      return;
    }
    res.status(401).json({ pool: data.pool, error: r.kind === 'error' ? r.error : 'MFA failed' });
  } catch (err) {
    handleError(res, err, 'mfa-challenge');
  }
});

// Customer self-signup. Staff users are invited only — staff signup is 403.
router.post('/signup', authRateLimit, async (req, res: Response) => {
  try {
    const data = signupSchema.parse(req.body);
    const pool = poolForEmail(data.email);
    if (pool !== 'customer') {
      res.status(403).json({ error: 'Staff users must be invited; self-signup is disabled.' });
      return;
    }
    if (!customerAuth.isEnabled()) {
      res.status(404).json({ error: 'Customer signup is disabled' });
      return;
    }
    const out = await customerAuth.signUp({
      email: data.email,
      password: data.password,
      name: data.name,
    });
    res.status(201).json({
      pool,
      userSub: out.userSub,
      userConfirmed: out.userConfirmed,
      message: out.userConfirmed
        ? 'Account created'
        : 'Confirmation code sent. Check your email.',
    });
  } catch (err) {
    handleError(res, err, 'signup');
  }
});

router.post('/confirm', authRateLimit, async (req, res: Response) => {
  try {
    const data = confirmSchema.parse(req.body);
    if (poolForEmail(data.email) !== 'customer') {
      res.status(403).json({ error: 'Confirmation only applies to customer accounts.' });
      return;
    }
    await customerAuth.confirmSignUp(data.email, data.code);
    await customerAuth.adminAddToGroup(data.email, 'customer').catch((e) => {
      logger.warn('Failed to add user to customer group', { email: data.email, error: e });
    });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'confirm');
  }
});

router.post('/forgot-password', authRateLimit, async (req, res: Response) => {
  try {
    const data = forgotSchema.parse(req.body);
    const pool = poolForEmail(data.email);
    if (pool === 'staff') {
      // Staff password resets go through Cognito's admin flow (operator-initiated).
      res.json({
        success: true,
        message:
          'Staff password resets are administered by IT. Contact an administrator.',
      });
      return;
    }
    if (!customerAuth.isEnabled()) {
      res.json({ success: true });
      return;
    }
    await customerAuth.forgotPassword(data.email).catch(() => {
      // Always succeed to prevent enumeration.
    });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'forgot-password');
  }
});

router.post('/reset-password', authRateLimit, async (req, res: Response) => {
  try {
    const data = resetSchema.parse(req.body);
    if (poolForEmail(data.email) !== 'customer') {
      res.status(403).json({ error: 'Use the staff portal to reset administrator passwords.' });
      return;
    }
    await customerAuth.confirmForgotPassword(data.email, data.code, data.password);
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'reset-password');
  }
});

router.post('/logout', async (req, res: Response) => {
  try {
    tokenOnly.parse(req.body);
    const auth = req.headers.authorization;
    const access =
      auth && auth.startsWith('Bearer ') ? auth.slice(7) : (req.body.accessToken as string | undefined);
    // GlobalSignOut is pool-agnostic — the SDK derives the user from the
    // access token, so it works for both staff and customer pools.
    if (access) {
      await customerAuth.globalSignOut(access).catch(() => undefined);
      try {
        const decoded = jwt.decode(access) as { jti?: string } | null;
        if (decoded?.jti) await clearSession(decoded.jti);
      } catch { /* ignore */ }
    }
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'logout');
  }
});

function handleError(res: Response, err: unknown, op: string) {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: 'Validation error', details: err.errors });
    return;
  }
  const e = err as { name?: string; message?: string };
  switch (e.name) {
    case 'UsernameExistsException':
      res.status(409).json({ error: 'An account with this email already exists' });
      return;
    case 'InvalidPasswordException':
      res.status(400).json({ error: 'Password does not meet policy', code: e.name });
      return;
    case 'CodeMismatchException':
    case 'ExpiredCodeException':
      res.status(400).json({ error: 'Invalid or expired confirmation code', code: e.name });
      return;
    case 'NotAuthorizedException':
      res.status(401).json({ error: 'Invalid credentials', code: e.name });
      return;
    case 'UserNotFoundException':
      res.status(401).json({ error: 'Invalid credentials', code: e.name });
      return;
    case 'UserNotConfirmedException':
      res.status(403).json({ error: 'Email not yet confirmed', code: e.name });
      return;
    case 'TooManyRequestsException':
    case 'LimitExceededException':
      res.status(429).json({ error: 'Too many requests, try again shortly', code: e.name });
      return;
    default:
      logger.error(`auth ${op} error`, err);
      res.status(500).json({ error: 'Request failed' });
  }
}

export default router;
