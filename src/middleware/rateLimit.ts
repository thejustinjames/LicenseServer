import { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

const CLEANUP_INTERVAL = 60000; // 1 minute

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) {
      store.delete(key);
    }
  }
}, CLEANUP_INTERVAL);

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (req: Request) => string;
  message?: string;
}

export function rateLimit(options: RateLimitOptions) {
  const {
    windowMs,
    maxRequests,
    keyGenerator = (req) => req.ip || 'unknown',
    message = 'Too many requests, please try again later',
  } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyGenerator(req);
    const now = Date.now();

    let entry = store.get(key);

    if (!entry || entry.resetAt < now) {
      entry = {
        count: 1,
        resetAt: now + windowMs,
      };
      store.set(key, entry);
      next();
      return;
    }

    entry.count++;

    if (entry.count > maxRequests) {
      res.status(429).json({
        error: message,
        retryAfter: Math.ceil((entry.resetAt - now) / 1000),
      });
      return;
    }

    next();
  };
}

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
