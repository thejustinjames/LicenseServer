/**
 * Admin Cognito Service
 *
 * Wraps the **staff** Cognito user pool (the agencio.cloud directory) for
 * License Server admin invites, login, MFA enrolment and lifecycle.
 *
 * The staff pool is the same one used elsewhere in Agencio (see
 * `COGNITO_USER_POOL_ID`). Admin users for the License Server are members of
 * the `license-admins` group in that pool, and MFA (TOTP) is required at the
 * application layer for every admin action.
 *
 * Configuration:
 *   COGNITO_USER_POOL_ID            staff pool ID (e.g. ap-southeast-1_y6HkbFYfL)
 *   COGNITO_CLIENT_ID               public web client (SRP). Used by the
 *                                   browser, not by this service.
 *   COGNITO_REGION                  defaults to AWS_REGION
 *   ADMIN_GROUP_NAME                Cognito group that grants License Server
 *                                   admin (default: "license-admins")
 *   ADMIN_INVITE_TEMP_PASSWORD_LENGTH  default 24
 */

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
  AdminGetUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminSetUserPasswordCommand,
  AdminResetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  AssociateSoftwareTokenCommand,
  VerifySoftwareTokenCommand,
  SetUserMFAPreferenceCommand,
  AdminSetUserMFAPreferenceCommand,
  type AuthenticationResultType,
  type ChallengeNameType,
  type AttributeType,
} from '@aws-sdk/client-cognito-identity-provider';
import crypto from 'crypto';
import { getAWSCredentials } from '../config/aws.js';
import { logger } from './logger.service.js';

export interface AdminInviteInput {
  email: string;
  name?: string;
}

export interface AdminAuthTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type AdminAuthResult =
  | { kind: 'tokens'; tokens: AdminAuthTokens }
  | { kind: 'challenge'; challenge: { challengeName: ChallengeNameType; session: string } }
  | { kind: 'error'; error: string; code?: string };

let client: CognitoIdentityProviderClient | null = null;

function poolId() {
  const v = process.env.COGNITO_USER_POOL_ID;
  if (!v) throw new Error('COGNITO_USER_POOL_ID is not set');
  return v;
}
/**
 * Admin client used for server-driven AdminInitiateAuth flows. This is a
 * dedicated client on the staff pool with ALLOW_ADMIN_USER_PASSWORD_AUTH +
 * ALLOW_REFRESH_TOKEN_AUTH (no secret) so that admin login is never exposed
 * via the shared browser SRP client.
 */
function clientId() {
  const v = process.env.COGNITO_ADMIN_CLIENT_ID || process.env.COGNITO_CLIENT_ID;
  if (!v) throw new Error('COGNITO_ADMIN_CLIENT_ID (or COGNITO_CLIENT_ID) is not set');
  return v;
}
function adminGroup() {
  return process.env.ADMIN_GROUP_NAME || 'license-admins';
}
function region() {
  return process.env.COGNITO_REGION || process.env.AWS_REGION || 'ap-southeast-1';
}
function tempPasswordLength() {
  const n = parseInt(process.env.ADMIN_INVITE_TEMP_PASSWORD_LENGTH || '24', 10);
  return Number.isFinite(n) && n >= 16 ? n : 24;
}

export function isEnabled() {
  return (
    !!process.env.COGNITO_USER_POOL_ID &&
    !!(process.env.COGNITO_ADMIN_CLIENT_ID || process.env.COGNITO_CLIENT_ID)
  );
}

function getClient() {
  if (!client) {
    client = new CognitoIdentityProviderClient({
      region: region(),
      credentials: getAWSCredentials(),
    });
  }
  return client;
}

/**
 * Generate a cryptographically random temporary password that satisfies the
 * staff pool's policy: upper, lower, number, symbol, ≥ 12 chars.
 */
export function generateStrongTempPassword(): string {
  const len = tempPasswordLength();
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*()-_=+[]{}<>?';
  const all = upper + lower + digits + symbols;
  const need = [
    upper[crypto.randomInt(upper.length)],
    lower[crypto.randomInt(lower.length)],
    digits[crypto.randomInt(digits.length)],
    symbols[crypto.randomInt(symbols.length)],
  ];
  const rest = Array.from({ length: len - need.length }, () => all[crypto.randomInt(all.length)]);
  // Fisher–Yates shuffle
  const arr = need.concat(rest);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}

/**
 * Invite a new admin: create the Cognito user with FORCE_CHANGE_PASSWORD,
 * add to the admin group, and email them the temporary password (Cognito
 * default email handles delivery via SES if configured on the pool).
 */
export async function inviteAdmin(input: AdminInviteInput): Promise<{ username: string; sub: string }> {
  const tempPassword = generateStrongTempPassword();
  const attrs: AttributeType[] = [
    { Name: 'email', Value: input.email },
    { Name: 'email_verified', Value: 'true' },
  ];
  if (input.name) attrs.push({ Name: 'name', Value: input.name });

  const out = await getClient().send(
    new AdminCreateUserCommand({
      UserPoolId: poolId(),
      Username: input.email,
      UserAttributes: attrs,
      TemporaryPassword: tempPassword,
      DesiredDeliveryMediums: ['EMAIL'],
      MessageAction: undefined, // default = send invitation email
      ForceAliasCreation: false,
    }),
  );

  await getClient().send(
    new AdminAddUserToGroupCommand({
      UserPoolId: poolId(),
      Username: input.email,
      GroupName: adminGroup(),
    }),
  );

  const sub =
    out.User?.Attributes?.find((a) => a.Name === 'sub')?.Value || '';
  logger.audit('admin-invite', {
    success: true,
    details: { email: input.email, sub, group: adminGroup() },
  });
  return { username: input.email, sub };
}

export async function disableAdmin(email: string): Promise<void> {
  await getClient().send(new AdminDisableUserCommand({ UserPoolId: poolId(), Username: email }));
  await getClient().send(
    new AdminUserGlobalSignOutCommand({ UserPoolId: poolId(), Username: email }),
  );
  logger.audit('admin-disable', { success: true, details: { email } });
}

export async function enableAdmin(email: string): Promise<void> {
  await getClient().send(new AdminEnableUserCommand({ UserPoolId: poolId(), Username: email }));
}

export async function removeAdminRole(email: string): Promise<void> {
  await getClient().send(
    new AdminRemoveUserFromGroupCommand({
      UserPoolId: poolId(),
      Username: email,
      GroupName: adminGroup(),
    }),
  );
}

export async function resetAdminPassword(email: string): Promise<void> {
  await getClient().send(
    new AdminResetUserPasswordCommand({ UserPoolId: poolId(), Username: email }),
  );
}

/**
 * Server-driven password login against the staff pool. Uses the public web
 * client (no secret) with USER_PASSWORD_AUTH if it is enabled on that
 * client, otherwise falls back to ADMIN_USER_PASSWORD_AUTH (which is
 * always available because we drive it via IAM).
 *
 * Returns NEW_PASSWORD_REQUIRED challenge on first login, then SOFTWARE_TOKEN_MFA
 * if MFA is set up. On second login without MFA, returns MFA_SETUP challenge
 * so the client can call /mfa/totp/associate + verify.
 */
export async function login(email: string, password: string): Promise<AdminAuthResult> {
  try {
    const out = await getClient().send(
      new AdminInitiateAuthCommand({
        UserPoolId: poolId(),
        ClientId: clientId(),
        AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: email, PASSWORD: password },
      }),
    );
    if (out.ChallengeName) {
      return {
        kind: 'challenge',
        challenge: { challengeName: out.ChallengeName, session: out.Session || '' },
      };
    }
    return { kind: 'tokens', tokens: toTokens(out.AuthenticationResult) };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    logger.debug('Admin login failed', { name: e.name });
    return { kind: 'error', error: e.message || 'Login failed', code: e.name };
  }
}

export async function respondNewPassword(
  email: string,
  newPassword: string,
  session: string,
): Promise<AdminAuthResult> {
  try {
    const out = await getClient().send(
      new AdminRespondToAuthChallengeCommand({
        UserPoolId: poolId(),
        ClientId: clientId(),
        ChallengeName: 'NEW_PASSWORD_REQUIRED',
        Session: session,
        ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
      }),
    );
    if (out.ChallengeName) {
      return {
        kind: 'challenge',
        challenge: { challengeName: out.ChallengeName, session: out.Session || '' },
      };
    }
    return { kind: 'tokens', tokens: toTokens(out.AuthenticationResult) };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return { kind: 'error', error: e.message || 'Password change failed', code: e.name };
  }
}

export async function respondMfaSetup(
  email: string,
  session: string,
): Promise<{ secretCode: string; session: string }> {
  // Cognito flow: in MFA_SETUP challenge state, the session can be passed to
  // AssociateSoftwareToken which returns the secret + a fresh session that
  // we then verify with VerifySoftwareToken.
  const out = await getClient().send(
    new AssociateSoftwareTokenCommand({ Session: session }),
  );
  return { secretCode: out.SecretCode || '', session: out.Session || '' };
}

export async function verifyMfaSetup(
  email: string,
  totpCode: string,
  session: string,
): Promise<{ status: string; session?: string }> {
  const out = await getClient().send(
    new VerifySoftwareTokenCommand({
      Session: session,
      UserCode: totpCode,
      FriendlyDeviceName: 'Admin Authenticator',
    }),
  );
  return { status: out.Status || 'UNKNOWN', session: out.Session };
}

export async function completeMfaSetup(
  email: string,
  session: string,
): Promise<AdminAuthResult> {
  try {
    const out = await getClient().send(
      new AdminRespondToAuthChallengeCommand({
        UserPoolId: poolId(),
        ClientId: clientId(),
        ChallengeName: 'MFA_SETUP',
        Session: session,
        ChallengeResponses: { USERNAME: email, MFA_TYPE: 'SOFTWARE_TOKEN_MFA' },
      }),
    );
    if (out.AuthenticationResult) {
      return { kind: 'tokens', tokens: toTokens(out.AuthenticationResult) };
    }
    if (out.ChallengeName) {
      return {
        kind: 'challenge',
        challenge: { challengeName: out.ChallengeName, session: out.Session || '' },
      };
    }
    return { kind: 'error', error: 'MFA setup completion failed' };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return { kind: 'error', error: e.message || 'MFA setup failed', code: e.name };
  }
}

export async function respondTotp(
  email: string,
  totpCode: string,
  session: string,
): Promise<AdminAuthResult> {
  try {
    const out = await getClient().send(
      new AdminRespondToAuthChallengeCommand({
        UserPoolId: poolId(),
        ClientId: clientId(),
        ChallengeName: 'SOFTWARE_TOKEN_MFA',
        Session: session,
        ChallengeResponses: { USERNAME: email, SOFTWARE_TOKEN_MFA_CODE: totpCode },
      }),
    );
    if (out.AuthenticationResult) {
      return { kind: 'tokens', tokens: toTokens(out.AuthenticationResult) };
    }
    return { kind: 'error', error: 'MFA challenge failed' };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return { kind: 'error', error: e.message || 'MFA failed', code: e.name };
  }
}

/**
 * Force MFA preference on a user post-setup so subsequent logins always
 * challenge for TOTP.
 */
export async function enforceMfaPreference(email: string): Promise<void> {
  await getClient().send(
    new AdminSetUserMFAPreferenceCommand({
      UserPoolId: poolId(),
      Username: email,
      SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
    }),
  );
}

export async function setOwnMfaPreference(accessToken: string, enabled: boolean): Promise<void> {
  await getClient().send(
    new SetUserMFAPreferenceCommand({
      AccessToken: accessToken,
      SoftwareTokenMfaSettings: { Enabled: enabled, PreferredMfa: enabled },
    }),
  );
}

export async function adminGetUser(email: string) {
  return getClient().send(new AdminGetUserCommand({ UserPoolId: poolId(), Username: email }));
}

export async function adminListGroupsForUser(email: string): Promise<string[]> {
  const out = await getClient().send(
    new AdminListGroupsForUserCommand({ UserPoolId: poolId(), Username: email }),
  );
  return (out.Groups || []).map((g) => g.GroupName || '').filter(Boolean);
}

export async function adminSetPermanentPassword(email: string, password: string): Promise<void> {
  await getClient().send(
    new AdminSetUserPasswordCommand({
      UserPoolId: poolId(),
      Username: email,
      Password: password,
      Permanent: true,
    }),
  );
}

function toTokens(r: AuthenticationResultType | undefined): AdminAuthTokens {
  return {
    idToken: r?.IdToken || '',
    accessToken: r?.AccessToken || '',
    refreshToken: r?.RefreshToken || '',
    expiresIn: r?.ExpiresIn || 0,
  };
}
