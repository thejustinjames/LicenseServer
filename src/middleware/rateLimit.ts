import { Request, Response, NextFunction } from 'express';
import { checkRateLimit } from '../config/redis.js';
import { logger } from '../services/logger.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (req: Request) => string;
  message?: string;
  skipFailedRequests?: boolean;
  skipSuccessfulRequests?: boolean;
  /**
   * If true, rate limit check failures will block requests (fail-closed).
   * If false (default), requests are allowed through on error (fail-open).
   */
  failClosed?: boolean;
}

/**
 * Key generator that uses user ID if authenticated, falls back to IP
 */
export function userOrIpKeyGenerator(req: Request): string {
  const authReq = req as AuthenticatedRequest;
  if (authReq.user?.id) {
    return `user:${authReq.user.id}`;
  }
  return `ip:${req.ip || 'unknown'}`;
}

/**
 * Key generator that combines user ID/IP with the route path
 */
export function userRouteKeyGenerator(req: Request): string {
  const authReq = req as AuthenticatedRequest;
  const base = authReq.user?.id ? `user:${authReq.user.id}` : `ip:${req.ip || 'unknown'}`;
  return `${base}:${req.method}:${req.baseUrl}${req.path}`;
}

/**
 * Create a rate limiter middleware
 * Uses Redis if available, falls back to in-memory
 */
export function rateLimit(options: RateLimitOptions) {
  const {
    windowMs,
    maxRequests,
    keyGenerator = (req) => req.ip || 'unknown',
    message = 'Too many requests, please try again later',
    failClosed = false,
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = keyGenerator(req);
      const result = await checkRateLimit(key, maxRequests, windowMs);

      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', maxRequests.toString());
      res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - result.count).toString());
      res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000).toString());

      if (result.exceeded) {
        const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
        res.setHeader('Retry-After', retryAfter.toString());

        logger.warn('Rate limit exceeded', {
          ip: req.ip,
          path: req.path,
          count: result.count,
          limit: maxRequests,
        });

        res.status(429).json({
          error: message,
          code: 'RATE_001',
          retryAfter,
        });
        return;
      }

      next();
    } catch (error) {
      logger.error('Rate limit check failed', { error: error instanceof Error ? error.message : String(error) });
      if (failClosed) {
        // Block requests when rate limit check fails
        res.status(503).json({
          error: 'Service temporarily unavailable',
          code: 'RATE_002',
          retryAfter: 60,
        });
        return;
      }
      // Default: allow the request through (fail-open)
      next();
    }
  };
}

/**
 * Helper to create a rate limiter with simple parameters
 */
export function createRateLimiter(maxRequests: number, windowMs: number) {
  return rateLimit({ maxRequests, windowMs });
}

// Pre-configured rate limiters
export const validationRateLimit = rateLimit({
  windowMs: 60000, // 1 minute
  maxRequests: 60, // 60 requests per minute per IP
  message: 'Too many validation requests',
});

export const authRateLimit = rateLimit({
  windowMs: 900000, // 15 minutes
  maxRequests: 10, // 10 attempts per 15 minutes
  message: 'Too many authentication attempts',
});

export const webhookRateLimit = rateLimit({
  windowMs: 60000, // 1 minute
  maxRequests: 100, // 100 requests per minute
  message: 'Too many webhook requests',
});

/**
 * Per-user rate limiter for authenticated routes
 * Uses user ID when authenticated, falls back to IP
 */
export const userRateLimit = rateLimit({
  windowMs: 60000, // 1 minute
  maxRequests: 120, // 120 requests per minute per user
  keyGenerator: userOrIpKeyGenerator,
  message: 'Too many requests',
});

/**
 * Strict per-user rate limiter for sensitive operations
 * Uses user ID when authenticated, falls back to IP
 */
export const strictUserRateLimit = rateLimit({
  windowMs: 60000, // 1 minute
  maxRequests: 30, // 30 requests per minute per user
  keyGenerator: userOrIpKeyGenerator,
  message: 'Too many requests for this operation',
});
