/**
 * JWT Authentication Provider
 *
 * Local JWT-based authentication using jsonwebtoken library.
 * Supports both httpOnly cookies and Authorization header.
 */

import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/index.js';
import { isTokenBlacklisted, blacklistToken } from '../config/redis.js';
import { logger } from '../services/logger.service.js';
import type { AuthenticatedRequest } from '../types/index.js';
import type { AuthProviderInterface, AuthUser } from './index.js';

// Cookie configuration
export const AUTH_COOKIE_NAME = 'auth_token';
export const REFRESH_COOKIE_NAME = 'refresh_token';

export const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
};

export const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/api/portal/auth/refresh', // Only sent to refresh endpoint
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in milliseconds
};

// Refresh token expiry (30 days)
const REFRESH_TOKEN_EXPIRY = '30d';

interface JwtPayload {
  id: string;
  email: string;
  isAdmin: boolean;
  jti?: string; // JWT ID for blacklisting
  iat?: number;
  exp?: number;
  type?: 'access' | 'refresh'; // Token type
}

export class JWTAuthProvider implements AuthProviderInterface {
  private initialized = false;

  /**
   * Extract token from request (cookie first, then header)
   */
  private extractToken(req: AuthenticatedRequest): string | null {
    // First try cookie
    const cookieToken = req.cookies?.[AUTH_COOKIE_NAME];
    if (cookieToken) {
      return cookieToken;
    }

    // Fall back to Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const [bearer, token] = authHeader.split(' ');
      if (bearer === 'Bearer' && token) {
        return token;
      }
    }

    return null;
  }

  async authenticate(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const token = this.extractToken(req);

    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const result = await this.verifyTokenWithBlacklist(token);
    if (!result.user) {
      res.status(401).json({ error: result.error || 'Invalid or expired token' });
      return;
    }

    req.user = result.user;
    req.token = token;
    req.tokenPayload = result.payload;
    next();
  }

  async optionalAuth(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const token = this.extractToken(req);

    if (!token) {
      next();
      return;
    }

    const result = await this.verifyTokenWithBlacklist(token);
    if (result.user) {
      req.user = result.user;
      req.token = token;
      req.tokenPayload = result.payload;
    }

    next();
  }

  /**
   * Verify token and check blacklist
   */
  private async verifyTokenWithBlacklist(
    token: string
  ): Promise<{ user: AuthUser | null; payload?: JwtPayload; error?: string }> {
    try {
      const decoded = jwt.verify(token, config.JWT_SECRET) as JwtPayload;

      // Check if token is blacklisted
      const jti = decoded.jti || token.slice(-32); // Use last 32 chars as ID if no jti
      const isBlacklisted = await isTokenBlacklisted(jti);

      if (isBlacklisted) {
        logger.debug('Token is blacklisted', { jti });
        return { user: null, error: 'Token has been revoked' };
      }

      return {
        user: {
          id: decoded.id,
          email: decoded.email,
          isAdmin: decoded.isAdmin,
        },
        payload: decoded,
      };
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        return { user: null, error: 'Token has expired' };
      }
      if (error instanceof jwt.JsonWebTokenError) {
        return { user: null, error: 'Invalid token' };
      }
      logger.error('Token verification error', error);
      return { user: null, error: 'Token verification failed' };
    }
  }

  async verifyToken(token: string): Promise<AuthUser | null> {
    const result = await this.verifyTokenWithBlacklist(token);
    return result.user;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Verify JWT_SECRET is configured
    if (!config.JWT_SECRET || config.JWT_SECRET.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters');
    }

    logger.info('JWT auth provider initialized');
    this.initialized = true;
  }

  /**
   * Generate a JWT token for a user
   */
  generateToken(user: { id: string; email: string; isAdmin: boolean }): {
    token: string;
    jti: string;
    expiresAt: number;
  } {
    const jti = uuidv4();
    const expiresIn = config.JWT_EXPIRES_IN || '7d';

    // Calculate expiration timestamp
    let expiresAt: number;
    if (typeof expiresIn === 'string') {
      const match = expiresIn.match(/^(\d+)([smhd])$/);
      if (match) {
        const value = parseInt(match[1], 10);
        const unit = match[2];
        const multipliers: Record<string, number> = {
          s: 1000,
          m: 60 * 1000,
          h: 60 * 60 * 1000,
          d: 24 * 60 * 60 * 1000,
        };
        expiresAt = Date.now() + value * (multipliers[unit] || 1000);
      } else {
        expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // Default 7 days
      }
    } else {
      expiresAt = Date.now() + expiresIn * 1000;
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, isAdmin: user.isAdmin, jti },
      config.JWT_SECRET,
      { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] }
    );

    return { token, jti, expiresAt };
  }

  /**
   * Set auth cookie on response
   */
  setAuthCookie(res: Response, token: string): void {
    res.cookie(AUTH_COOKIE_NAME, token, COOKIE_OPTIONS);
  }

  /**
   * Clear auth cookie
   */
  clearAuthCookie(res: Response): void {
    res.clearCookie(AUTH_COOKIE_NAME, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
    });
  }

  /**
   * Logout: blacklist token and clear cookie
   */
  async logout(req: AuthenticatedRequest, res: Response): Promise<void> {
    const token = this.extractToken(req);

    if (token) {
      try {
        const decoded = jwt.decode(token) as JwtPayload | null;
        if (decoded?.exp) {
          const jti = decoded.jti || token.slice(-32);
          const expiresAt = decoded.exp * 1000; // Convert to milliseconds
          await blacklistToken(jti, expiresAt);
          logger.audit('logout', {
            userId: decoded.id,
            success: true,
          });
        }
      } catch (error) {
        logger.error('Error blacklisting token during logout', error);
      }
    }

    // Also blacklist refresh token if present
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
    if (refreshToken) {
      try {
        const decoded = jwt.decode(refreshToken) as JwtPayload | null;
        if (decoded?.exp) {
          const jti = decoded.jti || refreshToken.slice(-32);
          const expiresAt = decoded.exp * 1000;
          await blacklistToken(jti, expiresAt);
        }
      } catch {
        // Ignore refresh token blacklist errors
      }
    }

    this.clearAuthCookie(res);
    this.clearRefreshCookie(res);
  }

  /**
   * Generate a refresh token for a user
   */
  generateRefreshToken(user: { id: string; email: string; isAdmin: boolean }): {
    token: string;
    jti: string;
    expiresAt: number;
  } {
    const jti = uuidv4();
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days

    const token = jwt.sign(
      { id: user.id, email: user.email, isAdmin: user.isAdmin, jti, type: 'refresh' },
      config.JWT_SECRET,
      { expiresIn: REFRESH_TOKEN_EXPIRY as jwt.SignOptions['expiresIn'] }
    );

    return { token, jti, expiresAt };
  }

  /**
   * Verify a refresh token and return user info
   */
  async verifyRefreshToken(refreshToken: string): Promise<{
    user: AuthUser | null;
    error?: string;
  }> {
    try {
      const decoded = jwt.verify(refreshToken, config.JWT_SECRET) as JwtPayload;

      // Verify this is a refresh token
      if (decoded.type !== 'refresh') {
        return { user: null, error: 'Invalid token type' };
      }

      // Check blacklist
      const jti = decoded.jti || refreshToken.slice(-32);
      const isBlacklisted = await isTokenBlacklisted(jti);
      if (isBlacklisted) {
        return { user: null, error: 'Token has been revoked' };
      }

      return {
        user: {
          id: decoded.id,
          email: decoded.email,
          isAdmin: decoded.isAdmin,
        },
      };
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        return { user: null, error: 'Refresh token has expired' };
      }
      return { user: null, error: 'Invalid refresh token' };
    }
  }

  /**
   * Rotate tokens: generate new access and refresh tokens, blacklist old refresh
   */
  async rotateTokens(
    oldRefreshToken: string,
    res: Response
  ): Promise<{ success: boolean; error?: string; user?: AuthUser }> {
    const result = await this.verifyRefreshToken(oldRefreshToken);

    if (!result.user) {
      return { success: false, error: result.error };
    }

    // Blacklist old refresh token
    try {
      const decoded = jwt.decode(oldRefreshToken) as JwtPayload | null;
      if (decoded?.exp) {
        const jti = decoded.jti || oldRefreshToken.slice(-32);
        const expiresAt = decoded.exp * 1000;
        await blacklistToken(jti, expiresAt);
      }
    } catch {
      // Continue even if blacklisting fails
    }

    // Generate new tokens
    const accessToken = this.generateToken(result.user);
    const refreshToken = this.generateRefreshToken(result.user);

    // Set cookies
    this.setAuthCookie(res, accessToken.token);
    this.setRefreshCookie(res, refreshToken.token);

    logger.audit('token_refresh', {
      userId: result.user.id,
      success: true,
    });

    return { success: true, user: result.user };
  }

  /**
   * Set refresh cookie on response
   */
  setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE_NAME, token, REFRESH_COOKIE_OPTIONS);
  }

  /**
   * Clear refresh cookie
   */
  clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE_NAME, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/portal/auth/refresh',
    });
  }
}
