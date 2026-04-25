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
  amr?: string[];
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
  amr?: string[];
}

type CognitoTokenPayload = CognitoAccessTokenPayload | CognitoIdTokenPayload;

type Verifier = ReturnType<typeof CognitoJwtVerifier.create>;

export class CognitoAuthProvider implements AuthProviderInterface {
  private staffVerifier: Verifier | null = null;
  private customerVerifier: Verifier | null = null;
  private userPoolId: string;
  private clientId: string;
  private customerPoolId: string;
  private customerClientId: string;
  private region: string;
  private adminGroupName: string;
  private initialized = false;

  private extraStaffClientIds: string[];
  private extraCustomerClientIds: string[];

  constructor() {
    this.userPoolId = process.env.COGNITO_USER_POOL_ID || '';
    this.clientId = process.env.COGNITO_CLIENT_ID || '';
    this.customerPoolId = process.env.CUSTOMER_COGNITO_USER_POOL_ID || '';
    this.customerClientId = process.env.CUSTOMER_COGNITO_CLIENT_ID || '';
    this.region = process.env.COGNITO_REGION || process.env.AWS_REGION || 'us-east-1';
    // The license-server admin group on the staff pool. Admin status is
    // granted only when the token comes from the staff pool AND the user is
    // in this group AND (when enforcement is on) the token's amr proves MFA.
    this.adminGroupName = process.env.COGNITO_ADMIN_GROUP || 'license-admins';
    // Additional client IDs whose tokens should be accepted on the same pool.
    // These are server-driven flows (e.g. license-server-admin client).
    this.extraStaffClientIds = (process.env.COGNITO_ADMIN_CLIENT_ID || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    this.extraCustomerClientIds = (process.env.CUSTOMER_COGNITO_SERVER_CLIENT_ID || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
  }

  private async verifyWithEither(token: string): Promise<{ payload: CognitoTokenPayload; pool: 'staff' | 'customer' } | null> {
    if (this.staffVerifier) {
      try {
        const payload = (await this.staffVerifier.verify(token)) as unknown as CognitoTokenPayload;
        return { payload, pool: 'staff' };
      } catch {
        // fall through to customer pool
      }
    }
    if (this.customerVerifier) {
      try {
        const payload = (await this.customerVerifier.verify(token)) as unknown as CognitoTokenPayload;
        return { payload, pool: 'customer' };
      } catch {
        // fall through
      }
    }
    return null;
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

    const verified = await this.verifyAndExtract(token);
    if (!verified) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    req.user = verified.user;
    req.token = token;
    req.tokenPayload = verified.tokenPayload;
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

    const verified = await this.verifyAndExtract(token);
    if (verified) {
      req.user = verified.user;
      req.token = token;
      req.tokenPayload = verified.tokenPayload;
    }

    next();
  }

  private async verifyAndExtract(token: string): Promise<{
    user: AuthUser;
    tokenPayload: { id: string; email: string; isAdmin: boolean; jti?: string; iat?: number; exp?: number };
  } | null> {
    try {
      const verified = await this.verifyWithEither(token);
      if (!verified) return null;
      const user = await this.userFromPayload(verified);
      return {
        user,
        tokenPayload: {
          id: user.id,
          email: user.email,
          isAdmin: user.isAdmin,
          jti: verified.payload.jti,
          iat: verified.payload.iat,
          exp: verified.payload.exp,
        },
      };
    } catch (error) {
      logger.debug('Cognito token verification failed', { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  private async userFromPayload(verified: { payload: CognitoTokenPayload; pool: 'staff' | 'customer' }): Promise<AuthUser> {
    const { payload, pool } = verified;
    const isIdToken = payload.token_use === 'id';
    const idPayload = payload as CognitoIdTokenPayload;
    const accessPayload = payload as CognitoAccessTokenPayload;

    const email = isIdToken ? idPayload.email : accessPayload.username;
    const groups = payload['cognito:groups'] || [];
    const isAdmin =
      pool === 'staff' &&
      (groups.includes(this.adminGroupName) ||
        (isIdToken && idPayload['custom:isAdmin'] === 'true'));

    const amr = (payload as { amr?: string[] }).amr || [];
    const mfaAuthenticated = amr.includes('mfa') || amr.includes('totp_mfa');

    return {
      id: payload.sub,
      email,
      isAdmin,
      cognitoSub: payload.sub,
      groups,
      pool,
      amr,
      mfaAuthenticated,
    };
  }

  async verifyToken(token: string): Promise<AuthUser | null> {
    try {
      const verified = await this.verifyWithEither(token);
      if (!verified) return null;
      // Only the staff pool's admin group grants admin. Customer pool tokens
      // never grant admin even if a group with the same name exists.
      return await this.userFromPayload(verified);
    } catch (error) {
      logger.debug('Cognito token verification failed', { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.userPoolId && !this.customerPoolId) {
      throw new Error(
        'At least one of COGNITO_USER_POOL_ID or CUSTOMER_COGNITO_USER_POOL_ID is required for Cognito auth',
      );
    }

    if (this.userPoolId) {
      if (!this.clientId) {
        throw new Error('COGNITO_CLIENT_ID is required when COGNITO_USER_POOL_ID is set');
      }
      const staffClientIds = [this.clientId, ...this.extraStaffClientIds];
      this.staffVerifier = CognitoJwtVerifier.create({
        userPoolId: this.userPoolId,
        tokenUse: null as unknown as 'access',
        clientId: staffClientIds.length === 1 ? staffClientIds[0] : staffClientIds,
      } as never);
      await this.staffVerifier.hydrate();
      logger.info(
        `Cognito staff verifier initialized for pool ${this.userPoolId} (${staffClientIds.length} clients)`,
      );
    }

    if (this.customerPoolId) {
      if (!this.customerClientId) {
        throw new Error(
          'CUSTOMER_COGNITO_CLIENT_ID is required when CUSTOMER_COGNITO_USER_POOL_ID is set',
        );
      }
      const customerClientIds = [this.customerClientId, ...this.extraCustomerClientIds];
      this.customerVerifier = CognitoJwtVerifier.create({
        userPoolId: this.customerPoolId,
        tokenUse: null as unknown as 'access',
        clientId: customerClientIds.length === 1 ? customerClientIds[0] : customerClientIds,
      } as never);
      await this.customerVerifier.hydrate();
      logger.info(
        `Cognito customer verifier initialized for pool ${this.customerPoolId} (${customerClientIds.length} clients)`,
      );
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
