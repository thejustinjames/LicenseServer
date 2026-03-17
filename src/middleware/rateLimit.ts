import { Request, Response, NextFunction } from 'express';
import { checkRateLimit } from '../config/redis.js';
import { logger } from '../services/logger.service.js';

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (req: Request) => string;
  message?: string;
  skipFailedRequests?: boolean;
  skipSuccessfulRequests?: boolean;
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
          retryAfter,
        });
        return;
      }

      next();
    } catch (error) {
      // On error, allow the request through (fail open)
      logger.error('Rate limit check failed', error);
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
