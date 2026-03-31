/**
 * Standardized API Error Response Utilities
 *
 * Provides consistent error formatting across all API endpoints.
 */

import { Response } from 'express';

/**
 * Standard error codes for machine-readable error handling
 */
export const ErrorCodes = {
  // Authentication (1xxx)
  UNAUTHORIZED: 'AUTH_001',
  INVALID_TOKEN: 'AUTH_002',
  TOKEN_EXPIRED: 'AUTH_003',
  ACCOUNT_LOCKED: 'AUTH_004',
  INVALID_CREDENTIALS: 'AUTH_005',
  CAPTCHA_FAILED: 'AUTH_006',

  // Validation (2xxx)
  VALIDATION_ERROR: 'VAL_001',
  INVALID_UUID: 'VAL_002',
  INVALID_LICENSE_KEY: 'VAL_003',
  MISSING_REQUIRED_FIELD: 'VAL_004',

  // Resource (3xxx)
  NOT_FOUND: 'RES_001',
  ALREADY_EXISTS: 'RES_002',
  CONFLICT: 'RES_003',

  // License (4xxx)
  LICENSE_EXPIRED: 'LIC_001',
  LICENSE_REVOKED: 'LIC_002',
  LICENSE_SUSPENDED: 'LIC_003',
  ACTIVATION_LIMIT_REACHED: 'LIC_004',
  MACHINE_NOT_ACTIVATED: 'LIC_005',
  NO_SEATS_AVAILABLE: 'LIC_006',

  // Payment (5xxx)
  PAYMENT_FAILED: 'PAY_001',
  SUBSCRIPTION_NOT_FOUND: 'PAY_002',
  INVALID_PROMO_CODE: 'PAY_003',

  // Rate Limiting (6xxx)
  RATE_LIMIT_EXCEEDED: 'RATE_001',
  SERVICE_UNAVAILABLE: 'RATE_002',

  // Server (9xxx)
  INTERNAL_ERROR: 'SRV_001',
  DATABASE_ERROR: 'SRV_002',
  EXTERNAL_SERVICE_ERROR: 'SRV_003',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

/**
 * Standard API error response structure
 */
export interface ApiErrorResponse {
  error: string;
  code: ErrorCode;
  details?: unknown;
  requestId?: string;
}

/**
 * Send a standardized error response
 */
export function sendError(
  res: Response,
  status: number,
  message: string,
  code: ErrorCode,
  details?: unknown
): void {
  const requestId = res.req?.headers['x-request-id'] as string | undefined;

  const response: ApiErrorResponse = {
    error: message,
    code,
  };

  if (details !== undefined) {
    response.details = details;
  }
  if (requestId) {
    response.requestId = requestId;
  }

  res.status(status).json(response);
}

/**
 * Common error response helpers
 */
export const errors = {
  unauthorized: (res: Response, message = 'Not authenticated') =>
    sendError(res, 401, message, ErrorCodes.UNAUTHORIZED),

  forbidden: (res: Response, message = 'Access denied') =>
    sendError(res, 403, message, ErrorCodes.UNAUTHORIZED),

  notFound: (res: Response, resource = 'Resource') =>
    sendError(res, 404, `${resource} not found`, ErrorCodes.NOT_FOUND),

  badRequest: (res: Response, message: string, details?: unknown) =>
    sendError(res, 400, message, ErrorCodes.VALIDATION_ERROR, details),

  validationError: (res: Response, details: unknown) =>
    sendError(res, 400, 'Validation error', ErrorCodes.VALIDATION_ERROR, details),

  conflict: (res: Response, message: string) =>
    sendError(res, 409, message, ErrorCodes.ALREADY_EXISTS),

  rateLimited: (res: Response, retryAfter: number) => {
    res.setHeader('Retry-After', retryAfter.toString());
    sendError(res, 429, 'Too many requests', ErrorCodes.RATE_LIMIT_EXCEEDED);
  },

  serviceUnavailable: (res: Response, message = 'Service temporarily unavailable') =>
    sendError(res, 503, message, ErrorCodes.SERVICE_UNAVAILABLE),

  internal: (res: Response, message = 'Internal server error') =>
    sendError(res, 500, message, ErrorCodes.INTERNAL_ERROR),
};
