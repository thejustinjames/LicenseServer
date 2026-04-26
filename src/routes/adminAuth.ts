/**
 * Admin authentication routes (staff Cognito pool, MFA required).
 *
 * Mounted at /api/admin/auth. Endpoints:
 *
 *   POST /invite               (existing-admin) Create a new admin user.
 *                              Cognito emails them a temporary password.
 *   POST /login                Username + password against the staff pool.
 *                              On first login returns NEW_PASSWORD_REQUIRED;
 *                              once the password is set and TOTP is enrolled,
 *                              returns SOFTWARE_TOKEN_MFA challenge; on
 *                              second login (no MFA yet) returns MFA_SETUP.
 *   POST /password/new         Respond to NEW_PASSWORD_REQUIRED.
 *   POST /mfa/setup/start      Start MFA enrolment from MFA_SETUP challenge.
 *                              Returns the TOTP secretCode.
 *   POST /mfa/setup/verify     Verify the TOTP code; if SUCCESS, completes
 *                              the MFA_SETUP challenge and returns tokens.
 *   POST /mfa/challenge        Respond to a SOFTWARE_TOKEN_MFA challenge on
 *                              subsequent logins.
 *   POST /disable              (existing-admin) Disable an admin user.
 *   POST /reset-password       (existing-admin) Force password reset for a user.
 *
 * `existing-admin` endpoints are protected by `authenticate` + `requireAdmin`
 * which itself enforces staff-pool + MFA-authenticated tokens.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { idleTimeout, seedSession } from '../middleware/idleTimeout.js';
import { authRateLimit } from '../middleware/rateLimit.js';
import { passwordSchema } from '../utils/password.js';
import * as admin from '../services/adminCognito.service.js';
import { logger } from '../services/logger.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const router = Router();

// Gate: this surface only makes sense when running on Cognito.
router.use((_req, res, next) => {
  if (!admin.isEnabled()) {
    res.status(404).json({ error: 'Admin Cognito auth not configured' });
    return;
  }
  if ((process.env.AUTH_PROVIDER || 'jwt') !== 'cognito') {
    res
      .status(503)
      .json({ error: 'Admin auth requires AUTH_PROVIDER=cognito on the server' });
    return;
  }
  next();
});

// --- Schemas ---------------------------------------------------------------
const inviteSchema = z.object({
  email: z.string().email(),
  name: z.string().max(100).optional(),
});
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
const newPasswordSchema = z.object({
  email: z.string().email(),
  newPassword: passwordSchema,
  session: z.string().min(1),
});
const setupStartSchema = z.object({
  email: z.string().email(),
  session: z.string().min(1),
});
const setupVerifySchema = z.object({
  email: z.string().email(),
  code: z.string().min(6).max(8),
  session: z.string().min(1),
});
const mfaChallengeSchema = z.object({
  email: z.string().email(),
  code: z.string().min(6).max(8),
  session: z.string().min(1),
});
const emailOnly = z.object({ email: z.string().email() });

// --- Existing-admin invite/disable/reset ----------------------------------
router.post('/invite', authenticate, idleTimeout, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = inviteSchema.parse(req.body);
    const out = await admin.inviteAdmin(data);
    res.status(201).json(out);
  } catch (err) {
    handleError(res, err, 'invite');
  }
});

router.post('/disable', authenticate, idleTimeout, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = emailOnly.parse(req.body);
    if (req.user?.email && req.user.email.toLowerCase() === data.email.toLowerCase()) {
      res.status(400).json({ error: 'Cannot disable your own account' });
      return;
    }
    await admin.disableAdmin(data.email);
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'disable');
  }
});

router.post('/reset-password', authenticate, idleTimeout, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = emailOnly.parse(req.body);
    await admin.resetAdminPassword(data.email);
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'reset-password');
  }
});

router.post('/remove-role', authenticate, idleTimeout, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = emailOnly.parse(req.body);
    if (req.user?.email && req.user.email.toLowerCase() === data.email.toLowerCase()) {
      res.status(400).json({ error: 'Cannot remove your own admin role' });
      return;
    }
    await admin.removeAdminRole(data.email);
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'remove-role');
  }
});

// --- Self-service login + MFA flow ----------------------------------------
router.post('/login', authRateLimit, async (req, res: Response) => {
  try {
    const data = loginSchema.parse(req.body);
    const result = await admin.login(data.email, data.password);
    respondWithResult(res, result);
  } catch (err) {
    handleError(res, err, 'login');
  }
});

router.post('/password/new', authRateLimit, async (req, res: Response) => {
  try {
    const data = newPasswordSchema.parse(req.body);
    const result = await admin.respondNewPassword(data.email, data.newPassword, data.session);
    respondWithResult(res, result);
  } catch (err) {
    handleError(res, err, 'password-new');
  }
});

router.post('/mfa/setup/start', authRateLimit, async (req, res: Response) => {
  try {
    const data = setupStartSchema.parse(req.body);
    const out = await admin.respondMfaSetup(data.email, data.session);
    const issuer = encodeURIComponent('Agencio License Server');
    const account = encodeURIComponent(data.email);
    const otpauthUri = `otpauth://totp/${issuer}:${account}?secret=${out.secretCode}&issuer=${issuer}`;
    res.json({ secretCode: out.secretCode, session: out.session, otpauthUri });
  } catch (err) {
    handleError(res, err, 'mfa-setup-start');
  }
});

router.post('/mfa/setup/verify', authRateLimit, async (req, res: Response) => {
  try {
    const data = setupVerifySchema.parse(req.body);
    const verified = await admin.verifyMfaSetup(data.email, data.code, data.session);
    if (verified.status !== 'SUCCESS' || !verified.session) {
      res.status(400).json({ error: 'TOTP verification failed', status: verified.status });
      return;
    }
    const completed = await admin.completeMfaSetup(data.email, verified.session);
    if (completed.kind === 'tokens') {
      // Persist preference so MFA is required on every future login.
      await admin.enforceMfaPreference(data.email).catch((e) => {
        logger.warn('Failed to enforce MFA preference', { email: data.email, error: e });
      });
      await seedSession(completed.tokens.accessToken);
      res.json({ tokens: completed.tokens });
      return;
    }
    if (completed.kind === 'challenge') {
      res.json({ challenge: completed.challenge });
      return;
    }
    res.status(400).json({ error: completed.error });
  } catch (err) {
    handleError(res, err, 'mfa-setup-verify');
  }
});

router.post('/mfa/challenge', authRateLimit, async (req, res: Response) => {
  try {
    const data = mfaChallengeSchema.parse(req.body);
    const result = await admin.respondTotp(data.email, data.code, data.session);
    respondWithResult(res, result);
  } catch (err) {
    handleError(res, err, 'mfa-challenge');
  }
});

// --- helpers ---------------------------------------------------------------
async function respondWithResult(res: Response, r: admin.AdminAuthResult): Promise<void> {
  if (r.kind === 'tokens') {
    await seedSession(r.tokens.accessToken);
    res.json({ tokens: r.tokens });
    return;
  }
  if (r.kind === 'challenge') {
    res.json({ challenge: r.challenge });
    return;
  }
  res.status(401).json({ error: r.error, code: r.code });
}

function handleError(res: Response, err: unknown, op: string) {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: 'Validation error', details: err.errors });
    return;
  }
  const e = err as { name?: string; message?: string };
  switch (e.name) {
    case 'UsernameExistsException':
      res.status(409).json({ error: 'An admin with this email already exists' });
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
      res.status(404).json({ error: 'User not found', code: e.name });
      return;
    case 'TooManyRequestsException':
    case 'LimitExceededException':
      res.status(429).json({ error: 'Too many requests, try again shortly', code: e.name });
      return;
    default:
      logger.error(`admin-auth ${op} error`, err);
      res.status(500).json({ error: 'Request failed' });
  }
}

export default router;
