import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { config } from '../config/index.js';
import { logger } from '../services/logger.service.js';

/**
 * Constant-time comparison of a presented API key against the configured
 * ADMIN_API_KEY. Returns false when no key is configured: an unset key must
 * never mean "anyone may pass".
 */
export function isValidAdminApiKey(presented: unknown): boolean {
  const expected = config.ADMIN_API_KEY;
  if (!expected || typeof presented !== 'string' || presented.length === 0) {
    return false;
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Express middleware: require a valid `x-api-key` header.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!isValidAdminApiKey(req.headers['x-api-key'])) {
    logger.warn('Rejected request with missing or invalid API key', {
      path: req.originalUrl,
      ip: req.ip,
      hasKey: !!req.headers['x-api-key'],
      configured: !!config.ADMIN_API_KEY,
    });
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
