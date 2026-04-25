/**
 * Authentication Provider Factory
 *
 * Supports multiple authentication providers:
 * - jwt: Local JWT authentication (default)
 * - cognito: AWS Cognito authentication
 */

import { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import { JWTAuthProvider } from './jwt.auth.js';
import { CognitoAuthProvider } from './cognito.auth.js';

export type AuthProviderType = 'jwt' | 'cognito';

export interface AuthUser {
  id: string;
  email: string;
  isAdmin: boolean;
  cognitoSub?: string;
  groups?: string[];
  /** Which Cognito pool issued the token (when AUTH_PROVIDER=cognito). */
  pool?: 'staff' | 'customer';
  /** Authentication methods reference (RFC 8176-style). Cognito populates
   *  this on tokens that completed MFA: e.g. ["mfa", "totp_mfa"]. */
  amr?: string[];
  /** Convenience flag: true iff the token's amr proves MFA was used. */
  mfaAuthenticated?: boolean;
}

export interface AuthProviderInterface {
  /**
   * Authenticate a request and populate req.user
   */
  authenticate(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void>;

  /**
   * Optional authentication - doesn't fail if no token
   */
  optionalAuth(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void>;

  /**
   * Verify a token and return the user info
   */
  verifyToken(token: string): Promise<AuthUser | null>;

  /**
   * Initialize the provider (e.g., fetch JWKS)
   */
  initialize(): Promise<void>;
}

// Singleton instance
let authProvider: AuthProviderInterface | null = null;

/**
 * Get the authentication provider based on AUTH_PROVIDER env var
 */
export function getAuthProvider(): AuthProviderInterface {
  if (authProvider) {
    return authProvider;
  }

  const providerType = (process.env.AUTH_PROVIDER || 'jwt') as AuthProviderType;

  switch (providerType) {
    case 'cognito':
      authProvider = new CognitoAuthProvider();
      break;
    case 'jwt':
    default:
      authProvider = new JWTAuthProvider();
      break;
  }

  return authProvider;
}

/**
 * Initialize the auth provider (async operation)
 */
export async function initializeAuthProvider(): Promise<void> {
  const provider = getAuthProvider();
  await provider.initialize();
}

/**
 * Reset the auth provider (for testing)
 */
export function resetAuthProvider(): void {
  authProvider = null;
}

/**
 * Middleware: Authenticate request (required)
 */
export function authenticate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const provider = getAuthProvider();
  provider.authenticate(req, res, next).catch(next);
}

/**
 * Middleware: Optional authentication
 */
export function optionalAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const provider = getAuthProvider();
  provider.optionalAuth(req, res, next).catch(next);
}

export { JWTAuthProvider, CognitoAuthProvider };
