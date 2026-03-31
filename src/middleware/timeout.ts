/**
 * Request Timeout Middleware
 *
 * Ensures requests don't hang indefinitely.
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../services/logger.service.js';

/**
 * Create a request timeout middleware
 *
 * @param timeoutMs - Timeout in milliseconds (default: 30000)
 */
export function requestTimeout(timeoutMs: number = 30000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Set request timeout
    req.setTimeout(timeoutMs, () => {
      if (!res.headersSent) {
        logger.warn('Request timeout', {
          path: req.path,
          method: req.method,
          ip: req.ip,
          timeoutMs,
        });

        res.status(408).json({
          error: 'Request timeout',
          code: 'TIMEOUT_001',
        });
      }
    });

    // Set response timeout
    res.setTimeout(timeoutMs, () => {
      if (!res.headersSent) {
        logger.warn('Response timeout', {
          path: req.path,
          method: req.method,
          ip: req.ip,
          timeoutMs,
        });

        res.status(408).json({
          error: 'Request timeout',
          code: 'TIMEOUT_001',
        });
      }
    });

    next();
  };
}

/**
 * Middleware to add standard response headers
 */
export function responseHeaders() {
  return (_req: Request, res: Response, next: NextFunction): void => {
    // API version header for client version detection
    res.setHeader('X-API-Version', '1.0.0');

    // Security headers not covered by helmet
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

    // Cache control for API responses (no caching by default)
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    next();
  };
}
