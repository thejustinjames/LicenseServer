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

/**
 * Middleware to validate :id parameter is a valid UUID
 * Returns 400 Bad Request if the ID is not a valid UUID
 */
export function validateIdParam(req: Request, res: Response, next: NextFunction): void {
  const id = req.params.id;

  if (!id) {
    res.status(400).json({ error: 'ID parameter is required' });
    return;
  }

  if (!isValidUUID(id)) {
    res.status(400).json({ error: 'Invalid ID format. Expected UUID.' });
    return;
  }

  next();
}

/**
 * Middleware factory to validate a specific parameter is a valid UUID
 */
export function validateUUIDParam(paramName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const value = req.params[paramName];

    if (!value) {
      res.status(400).json({ error: `${paramName} parameter is required` });
      return;
    }

    if (!isValidUUID(value)) {
      res.status(400).json({ error: `Invalid ${paramName} format. Expected UUID.` });
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
