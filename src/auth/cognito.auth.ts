/**
 * AWS Cognito Authentication Provider
 *
 * Validates Cognito JWT tokens and maps Cognito claims to app user.
 *
 * Configuration:
 * - COGNITO_USER_POOL_ID: Cognito User Pool ID
 * - COGNITO_CLIENT_ID: Cognito App Client ID
 * - COGNITO_REGION: AWS region for Cognito (default: AWS_REGION)
 */

import { Response, NextFunction } from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { AuthenticatedRequest } from '../types/index.js';
import type { AuthProviderInterface, AuthUser } from './index.js';
import { logger } from '../services/logger.service.js';

interface CognitoAccessTokenPayload {
  sub: string;
  'cognito:groups'?: string[];
  token_use: 'access';
  scope?: string;
  auth_time: number;
  iss: string;
  exp: number;
  iat: number;
  jti: string;
  client_id: string;
  username: string;
}

interface CognitoIdTokenPayload {
  sub: string;
  'cognito:groups'?: string[];
  email_verified: boolean;
  iss: string;
  'cognito:username': string;
  origin_jti: string;
  aud: string;
  event_id: string;
  token_use: 'id';
  auth_time: number;
  exp: number;
  iat: number;
  jti: string;
  email: string;
  'custom:isAdmin'?: string;
}

type CognitoTokenPayload = CognitoAccessTokenPayload | CognitoIdTokenPayload;

export class CognitoAuthProvider implements AuthProviderInterface {
  private verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;
  private userPoolId: string;
  private clientId: string;
  private region: string;
  private adminGroupName: string;
  private initialized = false;

  constructor() {
    this.userPoolId = process.env.COGNITO_USER_POOL_ID || '';
    this.clientId = process.env.COGNITO_CLIENT_ID || '';
    this.region = process.env.COGNITO_REGION || process.env.AWS_REGION || 'us-east-1';
    this.adminGroupName = process.env.COGNITO_ADMIN_GROUP || 'Admins';
  }

  private getVerifier() {
    if (!this.verifier) {
      throw new Error('Cognito auth provider not initialized');
    }
    return this.verifier;
  }

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
      const payload = await this.getVerifier().verify(token) as unknown as CognitoTokenPayload;

      // Extract user info based on token type
      const isIdToken = payload.token_use === 'id';
      const idPayload = payload as CognitoIdTokenPayload;
      const accessPayload = payload as CognitoAccessTokenPayload;

      const email = isIdToken ? idPayload.email : accessPayload.username;
      const groups = payload['cognito:groups'] || [];
      const isAdmin = groups.includes(this.adminGroupName) ||
                      (isIdToken && idPayload['custom:isAdmin'] === 'true');

      // Use Cognito sub as the user ID
      // You may want to look up the local user by cognitoSub
      return {
        id: payload.sub, // Cognito sub as ID
        email,
        isAdmin,
        cognitoSub: payload.sub,
        groups,
      };
    } catch (error) {
      logger.debug('Cognito token verification failed', { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.userPoolId) {
      throw new Error('COGNITO_USER_POOL_ID is required for Cognito auth');
    }

    if (!this.clientId) {
      throw new Error('COGNITO_CLIENT_ID is required for Cognito auth');
    }

    // Create verifier that accepts both access and ID tokens
    this.verifier = CognitoJwtVerifier.create({
      userPoolId: this.userPoolId,
      tokenUse: null as unknown as 'access', // Accept both access and id tokens
      clientId: this.clientId,
    });

    // Hydrate the JWKS cache
    try {
      await this.verifier.hydrate();
      logger.info(`Cognito auth provider initialized for pool ${this.userPoolId}`);
    } catch (error) {
      logger.error('Failed to hydrate Cognito JWKS:', error);
      throw error;
    }

    this.initialized = true;
  }

  /**
   * Get user info from Cognito (requires admin access)
   */
  async getUserFromCognito(username: string): Promise<Record<string, string> | null> {
    try {
      const { CognitoIdentityProviderClient, AdminGetUserCommand } = await import('@aws-sdk/client-cognito-identity-provider');
      const { getAWSCredentials } = await import('../config/aws.js');

      const client = new CognitoIdentityProviderClient({
        region: this.region,
        credentials: getAWSCredentials(),
      });

      const response = await client.send(new AdminGetUserCommand({
        UserPoolId: this.userPoolId,
        Username: username,
      }));

      const attributes: Record<string, string> = {};
      response.UserAttributes?.forEach(attr => {
        if (attr.Name && attr.Value) {
          attributes[attr.Name] = attr.Value;
        }
      });

      return attributes;
    } catch (error) {
      logger.error('Failed to get Cognito user:', error);
      return null;
    }
  }

  /**
   * List groups for a user
   */
  async getUserGroups(username: string): Promise<string[]> {
    try {
      const { CognitoIdentityProviderClient, AdminListGroupsForUserCommand } = await import('@aws-sdk/client-cognito-identity-provider');
      const { getAWSCredentials } = await import('../config/aws.js');

      const client = new CognitoIdentityProviderClient({
        region: this.region,
        credentials: getAWSCredentials(),
      });

      const response = await client.send(new AdminListGroupsForUserCommand({
        UserPoolId: this.userPoolId,
        Username: username,
      }));

      return response.Groups?.map(g => g.GroupName || '').filter(Boolean) || [];
    } catch (error) {
      logger.error('Failed to list user groups:', error);
      return [];
    }
  }
}
