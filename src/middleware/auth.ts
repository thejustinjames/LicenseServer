import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import type { AuthenticatedRequest } from '../types/index.js';

interface JwtPayload {
  id: string;
  email: string;
  isAdmin: boolean;
}

export function authenticate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
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

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
    req.user = {
      id: decoded.id,
      email: decoded.email,
      isAdmin: decoded.isAdmin,
    };
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function optionalAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
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

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
    req.user = {
      id: decoded.id,
      email: decoded.email,
      isAdmin: decoded.isAdmin,
    };
  } catch (error) {
    // Token invalid, but that's okay for optional auth
  }

  next();
}
