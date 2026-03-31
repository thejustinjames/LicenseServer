/**
 * Configurable CORS Configuration
 *
 * Provides flexible CORS settings via environment variables.
 *
 * Configuration:
 * - CORS_ENABLED: Enable/disable CORS (default: true)
 * - CORS_ORIGINS: Comma-separated origins or * (default: *)
 * - CORS_METHODS: Allowed HTTP methods (default: GET,POST,PUT,DELETE,OPTIONS)
 * - CORS_ALLOWED_HEADERS: Allowed headers (default: Content-Type,Authorization,X-License-Key)
 * - CORS_CREDENTIALS: Allow credentials (default: true)
 * - CORS_MAX_AGE: Preflight cache duration in seconds (default: 86400)
 */

import type { CorsOptions } from 'cors';

/**
 * Check if CORS is enabled
 */
export function isCorsEnabled(): boolean {
  return process.env.CORS_ENABLED !== 'false';
}

/**
 * Parse CORS origins from environment variable
 */
function parseOrigins(originsStr: string): CorsOptions['origin'] {
  if (originsStr === '*') {
    return '*';
  }

  const origins = originsStr.split(',').map(o => o.trim()).filter(Boolean);

  if (origins.length === 0) {
    return '*';
  }

  if (origins.length === 1) {
    // Single origin - can be string or regex
    const origin = origins[0];
    if (origin.startsWith('/') && origin.endsWith('/')) {
      // Regex pattern
      return new RegExp(origin.slice(1, -1));
    }
    return origin;
  }

  // Multiple origins - return array or function
  return (requestOrigin, callback) => {
    if (!requestOrigin) {
      // Allow requests with no origin (like mobile apps or curl)
      callback(null, true);
      return;
    }

    const allowed = origins.some(origin => {
      if (origin.startsWith('/') && origin.endsWith('/')) {
        // Regex pattern
        const regex = new RegExp(origin.slice(1, -1));
        return regex.test(requestOrigin);
      }
      return origin === requestOrigin;
    });

    if (allowed) {
      callback(null, true);
    } else {
      callback(new Error('CORS not allowed'), false);
    }
  };
}

/**
 * Get CORS configuration from environment variables
 * In production, requires explicit CORS_ORIGINS configuration for security
 */
export function getCorsConfig(): CorsOptions {
  const isProduction = process.env.NODE_ENV === 'production';
  const originsStr = process.env.CORS_ORIGINS;
  const methodsStr = process.env.CORS_METHODS || 'GET,POST,PUT,DELETE,OPTIONS';
  const headersStr = process.env.CORS_ALLOWED_HEADERS || 'Content-Type,Authorization,X-License-Key';
  const credentials = process.env.CORS_CREDENTIALS !== 'false';
  const maxAge = parseInt(process.env.CORS_MAX_AGE || '86400', 10);

  // In production, require explicit origins - no wildcards allowed
  let origin: CorsOptions['origin'];
  if (isProduction) {
    if (!originsStr || originsStr === '*') {
      // Default to APP_URL in production if no explicit origins set
      const appUrl = process.env.APP_URL;
      if (appUrl) {
        origin = parseOrigins(appUrl);
      } else {
        // Fail-safe: reject all cross-origin requests if not configured
        origin = false;
        console.warn('SECURITY WARNING: CORS_ORIGINS not configured in production. Cross-origin requests will be rejected.');
      }
    } else {
      origin = parseOrigins(originsStr);
    }
  } else {
    // Development: allow wildcard if not specified
    origin = parseOrigins(originsStr || '*');
  }

  return {
    origin,
    methods: methodsStr.split(',').map(m => m.trim()),
    allowedHeaders: headersStr.split(',').map(h => h.trim()),
    credentials,
    maxAge,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  };
}

/**
 * Get CORS configuration for development (permissive)
 */
export function getDevCorsConfig(): CorsOptions {
  return {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-License-Key', 'X-Request-ID'],
    credentials: true,
    maxAge: 86400,
  };
}

/**
 * Get CORS configuration for production (restrictive)
 */
export function getProdCorsConfig(allowedOrigins: string[]): CorsOptions {
  return {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-License-Key'],
    credentials: true,
    maxAge: 86400,
  };
}
