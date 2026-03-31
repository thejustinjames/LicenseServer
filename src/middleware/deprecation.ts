/**
 * API Deprecation Middleware
 *
 * Adds deprecation headers to responses for deprecated endpoints.
 * Useful for communicating API changes to clients.
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../services/logger.service.js';

export interface DeprecationOptions {
  /** When the endpoint was deprecated (ISO date string) */
  deprecatedAt: string;
  /** When the endpoint will be removed (ISO date string) */
  sunsetAt?: string;
  /** Suggested replacement endpoint */
  replacement?: string;
  /** Additional message */
  message?: string;
  /** Log deprecation usage */
  logUsage?: boolean;
}

/**
 * Create a deprecation middleware that adds RFC 8594 Deprecation headers
 *
 * @example
 * router.get('/v1/old-endpoint', deprecated({
 *   deprecatedAt: '2024-01-01',
 *   sunsetAt: '2024-06-01',
 *   replacement: '/v2/new-endpoint',
 * }), handler);
 */
export function deprecated(options: DeprecationOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Set Deprecation header (RFC 8594)
    res.setHeader('Deprecation', `date="${options.deprecatedAt}"`);

    // Set Sunset header if provided (RFC 8594)
    if (options.sunsetAt) {
      const sunsetDate = new Date(options.sunsetAt);
      res.setHeader('Sunset', sunsetDate.toUTCString());
    }

    // Set Link header to replacement if provided
    if (options.replacement) {
      const link = `<${options.replacement}>; rel="successor-version"`;
      const existing = res.getHeader('Link');
      if (existing) {
        res.setHeader('Link', `${existing}, ${link}`);
      } else {
        res.setHeader('Link', link);
      }
    }

    // Add X-Deprecation-Notice header with message
    const notice = options.message ||
      `This endpoint is deprecated${options.replacement ? `. Please migrate to ${options.replacement}` : ''}.`;
    res.setHeader('X-Deprecation-Notice', notice);

    // Log usage if enabled
    if (options.logUsage !== false) {
      logger.warn('Deprecated endpoint accessed', {
        path: req.path,
        method: req.method,
        ip: req.ip,
        deprecatedAt: options.deprecatedAt,
        replacement: options.replacement,
      });
    }

    next();
  };
}

/**
 * Middleware to add API version header for all responses
 */
export function apiVersion(version: string) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-API-Version', version);
    next();
  };
}

/**
 * Middleware to warn about upcoming breaking changes
 */
export function upcomingChange(message: string, effectiveDate: string) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Upcoming-Change', message);
    res.setHeader('X-Change-Effective', effectiveDate);
    next();
  };
}
