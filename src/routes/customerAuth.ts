/**
 * Customer authentication routes (Cognito-backed).
 *
 * Mounted at /api/customer/auth. Public sign-up and self-service flows for
 * external License Server customers. The provider is the dedicated
 * `ag-license-customers` Cognito pool — separate from the staff/admin pool.
 *
 * If CUSTOMER_AUTH_ENABLED is not "true", every route returns 404 so the
 * surface is invisible until the operator opts in.
 */

import crypto from 'crypto';
import { Router, Response } from 'express';
import { z } from 'zod';
import { authRateLimit } from '../middleware/rateLimit.js';
import { authenticate } from '../middleware/auth.js';
import { idleTimeout, seedSession } from '../middleware/idleTimeout.js';
import { clearSession } from '../config/redis.js';
import { passwordSchema } from '../utils/password.js';
import * as captchaService from '../services/captcha.service.js';
import * as cognito from '../services/customerCognito.service.js';
import * as customerService from '../services/customer.service.js';
import { prisma } from '../config/database.js';
import { logger } from '../services/logger.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const router = Router();

// Gate the whole router behind the feature flag AND the global auth provider:
// authenticated MFA endpoints rely on the Cognito JWT verifier, so customer
// auth requires AUTH_PROVIDER=cognito.
router.use((_req, res, next) => {
  if (!cognito.isEnabled()) {
    res.status(404).json({ error: 'Customer auth not enabled' });
    return;
  }
  if ((process.env.AUTH_PROVIDER || 'jwt') !== 'cognito') {
    res
      .status(503)
      .json({ error: 'Customer auth requires AUTH_PROVIDER=cognito on the server' });
    return;
  }
  next();
});

// --- Schemas ----------------------------------------------------------------
const signupSchema = z.object({
  email: z.string().email(),
  password: passwordSchema,
  name: z.string().max(100).optional(),
  captchaToken: z.string().optional(),
});
const confirmSchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(10),
});
const resendSchema = z.object({ email: z.string().email() });
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  captchaToken: z.string().optional(),
});
const mfaChallengeSchema = z.object({
  email: z.string().email(),
  code: z.string().min(6).max(8),
  session: z.string().min(1),
});
const forgotSchema = z.object({ email: z.string().email() });
const resetSchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(10),
  password: passwordSchema,
});
const totpVerifySchema = z.object({ code: z.string().min(6).max(8) });
const mfaPrefSchema = z.object({ enabled: z.boolean() });

async function checkCaptcha(token: string | undefined): Promise<boolean> {
  if (!captchaService.isCaptchaEnabled()) return true;
  return captchaService.verifyCaptcha(token);
}

// --- Sign-up flow -----------------------------------------------------------
router.post('/signup', authRateLimit, async (req, res: Response) => {
  try {
    const data = signupSchema.parse(req.body);
    if (!(await checkCaptcha(data.captchaToken))) {
      res.status(400).json({ error: 'CAPTCHA verification failed' });
      return;
    }

    // Reserve a local Customer row so license/Stripe linkage works even
    // before email is confirmed. Email is the join key.
    let local = await customerService.getCustomerByEmail(data.email);
    if (!local) {
      local = (await customerService.createCustomer({
        email: data.email,
        // Cognito owns the password. Set the local password_hash to a value
        // that bcrypt.compare can never match (random 64 bytes hex). The
        // legacy /api/portal/auth/login path therefore can never authenticate
        // a Cognito-managed customer.
        password: 'cognito:' + crypto.randomBytes(32).toString('hex'),
        name: data.name,
      })) as never;
    }

    const out = await cognito.signUp({
      email: data.email,
      password: data.password,
      name: data.name,
      licenseCustomerId: (local as { id: string }).id,
    });

    // Persist the Cognito sub on the local customer record.
    await prisma.customer.update({
      where: { email: data.email },
      data: {
        cognitoSub: out.userSub,
        cognitoPool: 'customer',
      },
    });

    logger.audit('customer-signup', {
      success: true,
      details: { email: data.email, sub: out.userSub },
    });
    res.status(201).json({
      userSub: out.userSub,
      userConfirmed: out.userConfirmed,
      message: out.userConfirmed
        ? 'Account created'
        : 'Confirmation code sent. Verify your email to finish sign-up.',
    });
  } catch (err) {
    handleError(res, err, 'signup');
  }
});

router.post('/confirm', authRateLimit, async (req, res: Response) => {
  try {
    const data = confirmSchema.parse(req.body);
    await cognito.confirmSignUp(data.email, data.code);
    await cognito.adminAddToGroup(data.email, 'customer').catch((e) => {
      logger.warn('Failed to add user to customer group', { email: data.email, error: e });
    });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'confirm');
  }
});

router.post('/resend', authRateLimit, async (req, res: Response) => {
  try {
    const data = resendSchema.parse(req.body);
    await cognito.resendConfirmation(data.email);
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'resend');
  }
});

// --- Login / MFA challenge --------------------------------------------------
router.post('/login', authRateLimit, async (req, res: Response) => {
  try {
    const data = loginSchema.parse(req.body);
    if (!(await checkCaptcha(data.captchaToken))) {
      res.status(400).json({ error: 'CAPTCHA verification failed' });
      return;
    }
    const result = await cognito.login(data.email, data.password);
    if (result.kind === 'tokens') {
      await seedSession(result.tokens.accessToken);
      res.json({ tokens: result.tokens });
      return;
    }
    if (result.kind === 'challenge') {
      res.status(200).json({ challenge: result.challenge });
      return;
    }
    res.status(401).json({ error: result.error });
  } catch (err) {
    handleError(res, err, 'login');
  }
});

router.post('/mfa/challenge', authRateLimit, async (req, res: Response) => {
  try {
    const data = mfaChallengeSchema.parse(req.body);
    const result = await cognito.respondToTotpChallenge(data.email, data.code, data.session);
    if (result.kind === 'tokens') {
      await seedSession(result.tokens.accessToken);
      res.json({ tokens: result.tokens });
      return;
    }
    res.status(401).json({ error: result.kind === 'error' ? result.error : 'MFA failed' });
  } catch (err) {
    handleError(res, err, 'mfa-challenge');
  }
});

// --- Password reset ---------------------------------------------------------
router.post('/forgot-password', authRateLimit, async (req, res: Response) => {
  try {
    const data = forgotSchema.parse(req.body);
    await cognito.forgotPassword(data.email).catch(() => {
      // Always succeed to prevent email enumeration.
    });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'forgot-password');
  }
});

router.post('/reset-password', authRateLimit, async (req, res: Response) => {
  try {
    const data = resetSchema.parse(req.body);
    await cognito.confirmForgotPassword(data.email, data.code, data.password);
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'reset-password');
  }
});

// --- MFA self-service (requires authenticated session) ---------------------
function getBearer(req: AuthenticatedRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const [scheme, token] = h.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

router.post('/mfa/totp/associate', authenticate, idleTimeout, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const access = getBearer(req);
    if (!access) {
      res.status(401).json({ error: 'Bearer token required' });
      return;
    }
    const out = await cognito.associateTotp(access);
    res.json(out);
  } catch (err) {
    handleError(res, err, 'totp-associate');
  }
});

router.post('/mfa/totp/verify', authenticate, idleTimeout, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const access = getBearer(req);
    if (!access) {
      res.status(401).json({ error: 'Bearer token required' });
      return;
    }
    const data = totpVerifySchema.parse(req.body);
    const out = await cognito.verifyTotp(access, data.code);
    if (out.status === 'SUCCESS') {
      await cognito.setMfaPreference(access, true);
      if (req.user?.email) {
        await prisma.customer.update({
          where: { email: req.user.email },
          data: { mfaEnabledAt: new Date() },
        }).catch(() => {});
      }
    }
    res.json(out);
  } catch (err) {
    handleError(res, err, 'totp-verify');
  }
});

router.post('/mfa/preference', authenticate, idleTimeout, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const access = getBearer(req);
    if (!access) {
      res.status(401).json({ error: 'Bearer token required' });
      return;
    }
    const data = mfaPrefSchema.parse(req.body);
    await cognito.setMfaPreference(access, data.enabled);
    if (req.user?.email) {
      await prisma.customer.update({
        where: { email: req.user.email },
        data: { mfaEnabledAt: data.enabled ? new Date() : null },
      }).catch(() => {});
    }
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'mfa-preference');
  }
});

router.post('/logout', authenticate, idleTimeout, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const access = getBearer(req);
    if (access) await cognito.globalSignOut(access).catch(() => {});
    if (req.tokenPayload?.jti) await clearSession(req.tokenPayload.jti);
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'logout');
  }
});

// --- helpers ---------------------------------------------------------------
function handleError(res: Response, err: unknown, op: string) {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: 'Validation error', details: err.errors });
    return;
  }
  const e = err as { name?: string; message?: string };
  // Map common Cognito exceptions to HTTP statuses.
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
    case 'UserNotConfirmedException':
      res.status(403).json({ error: 'Email not yet confirmed', code: e.name });
      return;
    case 'TooManyRequestsException':
    case 'LimitExceededException':
      res.status(429).json({ error: 'Too many requests, try again shortly', code: e.name });
      return;
    default:
      logger.error(`customer-auth ${op} error`, err);
      res.status(500).json({ error: 'Request failed' });
  }
}

export default router;
