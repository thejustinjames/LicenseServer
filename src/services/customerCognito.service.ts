/**
 * Customer Cognito Service
 *
 * Wraps the AWS Cognito user pool used for **external paying customers** of
 * the License Server (separate from the staff/admin pool). All public
 * sign-up, login, MFA enrolment and self-service password flows go through
 * this service.
 *
 * Configuration (from Secrets Manager / env):
 *   CUSTOMER_AUTH_ENABLED            "true" to enable customer Cognito flow
 *   CUSTOMER_COGNITO_USER_POOL_ID    e.g. ap-southeast-1_7KTxiTaT8
 *   CUSTOMER_COGNITO_CLIENT_ID       SPA/web client (no secret)
 *   CUSTOMER_COGNITO_SERVER_CLIENT_ID      server-side client (with secret)
 *   CUSTOMER_COGNITO_SERVER_CLIENT_SECRET  paired with above
 *   CUSTOMER_COGNITO_REGION          defaults to AWS_REGION
 */

import crypto from 'crypto';
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  ResendConfirmationCodeCommand,
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  AssociateSoftwareTokenCommand,
  VerifySoftwareTokenCommand,
  SetUserMFAPreferenceCommand,
  GlobalSignOutCommand,
  AdminGetUserCommand,
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
  type AuthenticationResultType,
  type ChallengeNameType,
  type AttributeType,
} from '@aws-sdk/client-cognito-identity-provider';
import { getAWSCredentials } from '../config/aws.js';
import { logger } from './logger.service.js';

export interface CustomerSignupInput {
  email: string;
  password: string;
  name?: string;
  licenseCustomerId?: string;
}

export interface CustomerAuthTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface CustomerAuthChallenge {
  challengeName: ChallengeNameType;
  session: string;
}

export type CustomerAuthResult =
  | { kind: 'tokens'; tokens: CustomerAuthTokens }
  | { kind: 'challenge'; challenge: CustomerAuthChallenge }
  | { kind: 'error'; error: string; code?: string };

let client: CognitoIdentityProviderClient | null = null;

function poolId() {
  const v = process.env.CUSTOMER_COGNITO_USER_POOL_ID;
  if (!v) throw new Error('CUSTOMER_COGNITO_USER_POOL_ID is not set');
  return v;
}
function webClientId() {
  const v = process.env.CUSTOMER_COGNITO_CLIENT_ID;
  if (!v) throw new Error('CUSTOMER_COGNITO_CLIENT_ID is not set');
  return v;
}
function serverClientId() {
  const v = process.env.CUSTOMER_COGNITO_SERVER_CLIENT_ID;
  if (!v) throw new Error('CUSTOMER_COGNITO_SERVER_CLIENT_ID is not set');
  return v;
}
function serverClientSecret() {
  const v = process.env.CUSTOMER_COGNITO_SERVER_CLIENT_SECRET;
  if (!v) throw new Error('CUSTOMER_COGNITO_SERVER_CLIENT_SECRET is not set');
  return v;
}
function region() {
  return (
    process.env.CUSTOMER_COGNITO_REGION ||
    process.env.AWS_REGION ||
    'ap-southeast-1'
  );
}

/** SECRET_HASH = base64(HMAC-SHA256(secret, username + clientId)) */
function secretHash(username: string): string {
  return crypto
    .createHmac('sha256', serverClientSecret())
    .update(username + serverClientId())
    .digest('base64');
}

export function isEnabled() {
  return (
    process.env.CUSTOMER_AUTH_ENABLED === 'true' &&
    !!process.env.CUSTOMER_COGNITO_USER_POOL_ID &&
    !!process.env.CUSTOMER_COGNITO_CLIENT_ID
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

export async function signUp(input: CustomerSignupInput): Promise<{ userSub: string; userConfirmed: boolean }> {
  const attrs: AttributeType[] = [{ Name: 'email', Value: input.email }];
  if (input.name) attrs.push({ Name: 'name', Value: input.name });
  if (input.licenseCustomerId) {
    attrs.push({ Name: 'custom:license_customer_id', Value: input.licenseCustomerId });
  }
  const out = await getClient().send(
    new SignUpCommand({
      ClientId: webClientId(),
      Username: input.email,
      Password: input.password,
      UserAttributes: attrs,
    }),
  );
  return { userSub: out.UserSub || '', userConfirmed: !!out.UserConfirmed };
}

export async function confirmSignUp(email: string, code: string): Promise<void> {
  await getClient().send(
    new ConfirmSignUpCommand({
      ClientId: webClientId(),
      Username: email,
      ConfirmationCode: code,
    }),
  );
}

export async function resendConfirmation(email: string): Promise<void> {
  await getClient().send(
    new ResendConfirmationCodeCommand({
      ClientId: webClientId(),
      Username: email,
    }),
  );
}

export async function login(email: string, password: string): Promise<CustomerAuthResult> {
  try {
    // Use AdminInitiateAuth via the server-side client (with secret + IAM).
    // The web client is intentionally configured for SRP only; passwords
    // submitted to this server are forwarded via the IAM-protected admin
    // flow rather than exposed via a public client password flow.
    const out = await getClient().send(
      new AdminInitiateAuthCommand({
        UserPoolId: poolId(),
        ClientId: serverClientId(),
        AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
          SECRET_HASH: secretHash(email),
        },
      }),
    );
    if (out.ChallengeName) {
      return {
        kind: 'challenge',
        challenge: {
          challengeName: out.ChallengeName,
          session: out.Session || '',
        },
      };
    }
    return { kind: 'tokens', tokens: toTokens(out.AuthenticationResult) };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    logger.debug('Customer login failed', { name: e.name });
    return { kind: 'error', error: e.message || 'Login failed', code: e.name };
  }
}

export async function respondToTotpChallenge(
  email: string,
  totpCode: string,
  session: string,
): Promise<CustomerAuthResult> {
  try {
    const out = await getClient().send(
      new AdminRespondToAuthChallengeCommand({
        UserPoolId: poolId(),
        ClientId: serverClientId(),
        ChallengeName: 'SOFTWARE_TOKEN_MFA',
        Session: session,
        ChallengeResponses: {
          USERNAME: email,
          SOFTWARE_TOKEN_MFA_CODE: totpCode,
          SECRET_HASH: secretHash(email),
        },
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

export async function forgotPassword(email: string): Promise<void> {
  await getClient().send(
    new ForgotPasswordCommand({ ClientId: webClientId(), Username: email }),
  );
}

export async function confirmForgotPassword(
  email: string,
  code: string,
  newPassword: string,
): Promise<void> {
  await getClient().send(
    new ConfirmForgotPasswordCommand({
      ClientId: webClientId(),
      Username: email,
      ConfirmationCode: code,
      Password: newPassword,
    }),
  );
}

export async function associateTotp(accessToken: string): Promise<{ secretCode: string; otpauthUri: string }> {
  const out = await getClient().send(
    new AssociateSoftwareTokenCommand({ AccessToken: accessToken }),
  );
  const secret = out.SecretCode || '';
  const issuer = encodeURIComponent('Agencio License Server');
  // We don't have the user email from the token here without decoding; caller
  // can pass it back to the client to render with their preferred label.
  const otpauthUri = `otpauth://totp/${issuer}?secret=${secret}&issuer=${issuer}`;
  return { secretCode: secret, otpauthUri };
}

export async function verifyTotp(
  accessToken: string,
  totpCode: string,
  deviceName = 'Authenticator',
): Promise<{ status: string }> {
  const out = await getClient().send(
    new VerifySoftwareTokenCommand({
      AccessToken: accessToken,
      UserCode: totpCode,
      FriendlyDeviceName: deviceName,
    }),
  );
  return { status: out.Status || 'UNKNOWN' };
}

export async function setMfaPreference(
  accessToken: string,
  enabled: boolean,
): Promise<void> {
  await getClient().send(
    new SetUserMFAPreferenceCommand({
      AccessToken: accessToken,
      SoftwareTokenMfaSettings: { Enabled: enabled, PreferredMfa: enabled },
    }),
  );
}

export async function globalSignOut(accessToken: string): Promise<void> {
  await getClient().send(new GlobalSignOutCommand({ AccessToken: accessToken }));
}

export async function adminAddToGroup(email: string, group: string): Promise<void> {
  await getClient().send(
    new AdminAddUserToGroupCommand({
      UserPoolId: poolId(),
      Username: email,
      GroupName: group,
    }),
  );
}

export async function adminGetUser(email: string) {
  return getClient().send(
    new AdminGetUserCommand({ UserPoolId: poolId(), Username: email }),
  );
}

export async function adminListGroupsForUser(email: string): Promise<string[]> {
  const out = await getClient().send(
    new AdminListGroupsForUserCommand({ UserPoolId: poolId(), Username: email }),
  );
  return (out.Groups || []).map((g) => g.GroupName || '').filter(Boolean);
}

function toTokens(r: AuthenticationResultType | undefined): CustomerAuthTokens {
  return {
    idToken: r?.IdToken || '',
    accessToken: r?.AccessToken || '',
    refreshToken: r?.RefreshToken || '',
    expiresIn: r?.ExpiresIn || 0,
  };
}

