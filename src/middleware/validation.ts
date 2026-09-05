import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

// UUID v4 regex pattern
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate that a string is a valid UUID v4
 */
export function isValidUUID(value: string): boolean {
  return UUID_REGEX.test(value);
}

/**
 * Zod schema for UUID validation
 */
export const uuidSchema = z.string().regex(UUID_REGEX, 'Invalid UUID format');

// Primary keys default to UUIDs, but seeded / externally-provisioned rows
// (products such as "prod_agencio_predict_lab", deployments) use opaque
// string ids. Accept either: a UUID or a short, URL-safe identifier.
const RESOURCE_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * True for a UUID v4 or an opaque URL-safe identifier (letters, digits,
 * `.`, `_`, `:`, `-`; 1-128 chars). Rejects path separators, whitespace and
 * anything that could be mistaken for an injected fragment.
 */
export function isValidResourceId(value: string): boolean {
  return isValidUUID(value) || RESOURCE_ID_REGEX.test(value);
}

/**
 * Zod schema for a resource id (UUID or opaque identifier)
 */
export const resourceIdSchema = z.string().regex(RESOURCE_ID_REGEX, 'Invalid ID format');

/**
 * Middleware to validate :id parameter is a well-formed resource id
 * Returns 400 Bad Request otherwise
 */
export function validateIdParam(req: Request, res: Response, next: NextFunction): void {
  const id = req.params.id;

  if (!id) {
    res.status(400).json({ error: 'ID parameter is required' });
    return;
  }

  if (!isValidResourceId(id)) {
    res.status(400).json({ error: 'Invalid ID format.' });
    return;
  }

  next();
}

/**
 * Middleware factory to validate a specific parameter is a well-formed
 * resource id (UUID or opaque identifier)
 */
export function validateUUIDParam(paramName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const value = req.params[paramName];

    if (!value) {
      res.status(400).json({ error: `${paramName} parameter is required` });
      return;
    }

    if (!isValidResourceId(value)) {
      res.status(400).json({ error: `Invalid ${paramName} format.` });
      return;
    }

    next();
  };
}

/**
 * Validate and parse query parameter as positive integer with bounds
 */
export function parsePositiveInt(value: string | undefined, defaultValue: number, max: number = 1000): number {
  if (!value) return defaultValue;

  const parsed = parseInt(value, 10);

  if (isNaN(parsed) || parsed < 1) {
    return defaultValue;
  }

  return Math.min(parsed, max);
}

/**
 * Validate and parse query parameter as non-negative integer with bounds
 */
export function parseNonNegativeInt(value: string | undefined, defaultValue: number, max: number = 1000): number {
  if (!value) return defaultValue;

  const parsed = parseInt(value, 10);

  if (isNaN(parsed) || parsed < 0) {
    return defaultValue;
  }

  return Math.min(parsed, max);
}

/**
 * Sanitize string input - remove potentially dangerous characters
 */
export function sanitizeString(value: string | undefined, maxLength: number = 255): string {
  if (!value) return '';

  return value
    .slice(0, maxLength)
    .replace(/[<>]/g, '') // Remove angle brackets (XSS prevention)
    .trim();
}
