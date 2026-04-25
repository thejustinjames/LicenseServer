import Redis from 'ioredis';
import { logger } from '../services/logger.service.js';

// ioredis default export is the Redis class
const IORedis = Redis.default || Redis;
type RedisClient = InstanceType<typeof IORedis>;

let redisClient: RedisClient | null = null;
let isConnected = false;

/**
 * Get Redis client instance
 * Returns null if Redis is not configured or unavailable
 */
export function getRedisClient(): RedisClient | null {
  return isConnected ? redisClient : null;
}

/**
 * Check if Redis is available
 */
export function isRedisAvailable(): boolean {
  return isConnected;
}

/**
 * Initialize Redis connection
 */
export async function initializeRedis(): Promise<boolean> {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    logger.info('Redis URL not configured, using in-memory fallback');
    return false;
  }

  try {
    redisClient = new IORedis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times: number) {
        if (times > 3) {
          logger.warn('Redis connection failed after 3 retries, using in-memory fallback');
          return null; // Stop retrying
        }
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });

    // Event handlers
    redisClient.on('connect', () => {
      logger.info('Redis connected');
      isConnected = true;
    });

    redisClient.on('error', (err: Error) => {
      logger.error('Redis error', err);
      isConnected = false;
    });

    redisClient.on('close', () => {
      logger.warn('Redis connection closed');
      isConnected = false;
    });

    // Try to connect
    await redisClient.connect();

    // Test connection
    await redisClient.ping();
    isConnected = true;
    logger.info('Redis initialized successfully');
    return true;
  } catch (error) {
    logger.warn('Failed to initialize Redis, using in-memory fallback', { error: String(error) });
    isConnected = false;
    return false;
  }
}

/**
 * Close Redis connection
 */
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    isConnected = false;
  }
}

// ============================================================================
// TOKEN BLACKLIST
// ============================================================================

const TOKEN_BLACKLIST_PREFIX = 'token:blacklist:';
const IN_MEMORY_BLACKLIST = new Map<string, number>();

// Cleanup in-memory blacklist periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of IN_MEMORY_BLACKLIST.entries()) {
    if (expiry < now) {
      IN_MEMORY_BLACKLIST.delete(token);
    }
  }
}, 60000); // Every minute

/**
 * Add a token to the blacklist
 * @param jti Token identifier (or full token if no jti)
 * @param expiresAt Token expiration timestamp (ms)
 */
export async function blacklistToken(jti: string, expiresAt: number): Promise<void> {
  const ttlMs = expiresAt - Date.now();
  if (ttlMs <= 0) {
    return; // Token already expired
  }

  const ttlSeconds = Math.ceil(ttlMs / 1000);

  if (isConnected && redisClient) {
    await redisClient.setex(`${TOKEN_BLACKLIST_PREFIX}${jti}`, ttlSeconds, '1');
  } else {
    IN_MEMORY_BLACKLIST.set(jti, expiresAt);
  }

  logger.debug('Token blacklisted', { jti, ttlSeconds });
}

/**
 * Check if a token is blacklisted
 * @param jti Token identifier (or full token if no jti)
 */
export async function isTokenBlacklisted(jti: string): Promise<boolean> {
  if (isConnected && redisClient) {
    const result = await redisClient.get(`${TOKEN_BLACKLIST_PREFIX}${jti}`);
    return result !== null;
  } else {
    const expiry = IN_MEMORY_BLACKLIST.get(jti);
    if (!expiry) return false;
    if (expiry < Date.now()) {
      IN_MEMORY_BLACKLIST.delete(jti);
      return false;
    }
    return true;
  }
}

// ============================================================================
// RATE LIMITING
// ============================================================================

const RATE_LIMIT_PREFIX = 'ratelimit:';
const IN_MEMORY_RATE_LIMITS = new Map<string, { count: number; resetAt: number }>();

// Cleanup in-memory rate limits periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of IN_MEMORY_RATE_LIMITS.entries()) {
    if (entry.resetAt < now) {
      IN_MEMORY_RATE_LIMITS.delete(key);
    }
  }
}, 60000);

/**
 * Increment rate limit counter and check if limit exceeded
 * @returns Object with current count and whether limit was exceeded
 */
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): Promise<{ count: number; exceeded: boolean; resetAt: number }> {
  const now = Date.now();
  const resetAt = now + windowMs;

  if (isConnected && redisClient) {
    const redisKey = `${RATE_LIMIT_PREFIX}${key}`;
    const ttlSeconds = Math.ceil(windowMs / 1000);

    // Use Redis transaction for atomic increment
    const pipeline = redisClient.pipeline();
    pipeline.incr(redisKey);
    pipeline.pttl(redisKey);
    const results = await pipeline.exec();

    if (!results) {
      // Redis error, fall back to allowing request
      return { count: 1, exceeded: false, resetAt };
    }

    const count = results[0]?.[1] as number;
    let ttl = results[1]?.[1] as number;

    // Set TTL if this is a new key
    if (ttl === -1) {
      await redisClient.pexpire(redisKey, windowMs);
      ttl = windowMs;
    }

    const actualResetAt = now + (ttl > 0 ? ttl : windowMs);

    return {
      count,
      exceeded: count > maxRequests,
      resetAt: actualResetAt,
    };
  } else {
    // In-memory fallback
    let entry = IN_MEMORY_RATE_LIMITS.get(key);

    if (!entry || entry.resetAt < now) {
      entry = { count: 1, resetAt };
      IN_MEMORY_RATE_LIMITS.set(key, entry);
      return { count: 1, exceeded: false, resetAt };
    }

    entry.count++;

    return {
      count: entry.count,
      exceeded: entry.count > maxRequests,
      resetAt: entry.resetAt,
    };
  }
}

// ============================================================================
// SESSION IDLE TRACKING
// ============================================================================

const SESSION_IDLE_PREFIX = 'session:idle:';
const IN_MEMORY_SESSIONS = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [jti, expiresAt] of IN_MEMORY_SESSIONS.entries()) {
    if (expiresAt < now) {
      IN_MEMORY_SESSIONS.delete(jti);
    }
  }
}, 60000);

/**
 * Refresh last-activity for a session keyed by jti. The entry expires after
 * `idleTtlMs` of inactivity, so a stale entry == idle timeout.
 *
 * Returns true if the entry existed before this call, false if it was newly
 * created (i.e. first request after login). Callers can use this distinction
 * but the idle middleware does not need to.
 */
export async function touchSession(jti: string, idleTtlMs: number): Promise<boolean> {
  const ttlSeconds = Math.ceil(idleTtlMs / 1000);
  const expiresAt = Date.now() + idleTtlMs;

  if (isConnected && redisClient) {
    const key = `${SESSION_IDLE_PREFIX}${jti}`;
    const existed = (await redisClient.exists(key)) === 1;
    await redisClient.setex(key, ttlSeconds, String(expiresAt));
    return existed;
  }
  const existed = IN_MEMORY_SESSIONS.has(jti);
  IN_MEMORY_SESSIONS.set(jti, expiresAt);
  return existed;
}

/**
 * Returns true if the session entry is present (i.e. not idle-expired).
 */
export async function isSessionActive(jti: string): Promise<boolean> {
  if (isConnected && redisClient) {
    return (await redisClient.exists(`${SESSION_IDLE_PREFIX}${jti}`)) === 1;
  }
  const expiresAt = IN_MEMORY_SESSIONS.get(jti);
  if (!expiresAt) return false;
  if (expiresAt < Date.now()) {
    IN_MEMORY_SESSIONS.delete(jti);
    return false;
  }
  return true;
}

/**
 * Drop the idle entry on logout so the same jti cannot be reused.
 */
export async function clearSession(jti: string): Promise<void> {
  if (isConnected && redisClient) {
    await redisClient.del(`${SESSION_IDLE_PREFIX}${jti}`);
  } else {
    IN_MEMORY_SESSIONS.delete(jti);
  }
}
