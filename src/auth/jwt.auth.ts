/**
 * JWT Authentication Provider
 *
 * Local JWT-based authentication using jsonwebtoken library.
 * This is the default authentication method.
 */

import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import type { AuthenticatedRequest } from '../types/index.js';
import type { AuthProviderInterface, AuthUser } from './index.js';

interface JwtPayload {
  id: string;
  email: string;
  isAdmin: boolean;
  iat?: number;
  exp?: number;
}

export class JWTAuthProvider implements AuthProviderInterface {
  private initialized = false;

  async authenticate(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.status(401).json({ error: 'Authorization header required' });
      return;
    }

    const [bearer, token] = authHeader.split(' ');

    if (bearer !== 'Bearer' || !token) {
      res.status(401).json({ error: 'Invalid authorization format' });
      return;
    }

    const user = await this.verifyToken(token);
    if (!user) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    req.user = user;
    next();
  }

  async optionalAuth(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      next();
      return;
    }

    const [bearer, token] = authHeader.split(' ');

    if (bearer !== 'Bearer' || !token) {
      next();
      return;
    }

    const user = await this.verifyToken(token);
    if (user) {
      req.user = user;
    }

    next();
  }

  async verifyToken(token: string): Promise<AuthUser | null> {
    try {
      const decoded = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
      return {
        id: decoded.id,
        email: decoded.email,
        isAdmin: decoded.isAdmin,
      };
    } catch (error) {
      return null;
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Verify JWT_SECRET is configured
    if (!config.JWT_SECRET || config.JWT_SECRET.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters');
    }

    console.log('JWT auth provider initialized');
    this.initialized = true;
  }

  /**
   * Generate a JWT token for a user
   */
  generateToken(user: { id: string; email: string; isAdmin: boolean }): string {
    return jwt.sign(
      { id: user.id, email: user.email, isAdmin: user.isAdmin },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
    );
  }
}
