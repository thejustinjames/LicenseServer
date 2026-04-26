/**
 * Idle session timeout.
 *
 * Enforces a 15-minute (configurable) inactivity window on authenticated
 * requests by tracking a per-jti TTL key in Redis (or the in-memory
 * fallback). When a request lands more than IDLE_TIMEOUT_MS after the
 * previous one for the same jti the key has expired and we reject with a
 * 401 carrying the machine-readable code `idle_timeout` so the frontend
 * can surface "you've been signed out for inactivity".
 *
 * Lifecycle:
 *   - Login routes call `seedSession(accessToken)` once the user has
 *     authenticated (post-MFA when MFA is required) so the first request
 *     can find an entry.
 *   - The middleware refreshes the entry on every authenticated request.
 *   - Logout calls `clearSession(jti)` to invalidate immediately.
 *
 * Mount *after* `authenticate` so req.tokenPayload is populated. If
 * tokenPayload is missing the middleware is a no-op — that lets us drop
 * it onto routers that mix public + authenticated routes.
 */

import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { isSessionActive, touchSession } from '../config/redis.js';
import { logger } from '../services/logger.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const DEFAULT_IDLE_MS = 15 * 60 * 1000;

export function idleTtlMs(): number {
  const raw = process.env.SESSION_IDLE_TIMEOUT_MS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_MS;
}

export const IDLE_TIMEOUT_RESPONSE = {
  error: 'Session timed out due to inactivity',
  code: 'idle_timeout',
};

export async function idleTimeout(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const jti = req.tokenPayload?.jti;
  if (!jti) {
    next();
    return;
  }

  try {
    const alive = await isSessionActive(jti);
    if (!alive) {
      logger.audit('session_idle_timeout', {
        userId: req.tokenPayload?.id,
        success: true,
        details: { jti },
      });
      res.status(401).json(IDLE_TIMEOUT_RESPONSE);
      return;
    }
    await touchSession(jti, idleTtlMs());
    next();
  } catch (err) {
    logger.error('idleTimeout: tracking failed', err);
    // Fail open: a Redis blip should not lock everyone out. The frontend
    // timer is the second line of defense.
    next();
  }
}

/**
 * Decode an access token and seed the idle-tracking entry. Called from
 * login flows after successful authentication. Decoding only — the token
 * has already been verified by the issuer (Cognito or our JWT signer).
 */
export async function seedSession(accessToken: string | undefined | null): Promise<void> {
  if (!accessToken) return;
  try {
    const decoded = jwt.decode(accessToken) as { jti?: string } | null;
    const jti = decoded?.jti;
    if (!jti) return;
    await touchSession(jti, idleTtlMs());
  } catch (err) {
    logger.warn('seedSession: failed to decode access token', { err: String(err) });
  }
}
