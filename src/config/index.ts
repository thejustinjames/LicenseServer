import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string(),
  PORT: z.string().default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),

  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),

  STRIPE_SECRET_KEY: z.string(),
  STRIPE_WEBHOOK_SECRET: z.string(),
  STRIPE_SUCCESS_URL: z.string().url(),
  STRIPE_CANCEL_URL: z.string().url(),

  // Stripe Tax Configuration
  STRIPE_TAX_ENABLED: z.string().default('false'),
  STRIPE_TAX_BEHAVIOR: z.enum(['exclusive', 'inclusive']).default('exclusive'),

  // Stripe Billing Configuration
  STRIPE_BILLING_ADDRESS_COLLECTION: z.enum(['auto', 'required']).default('auto'),
  STRIPE_TRIAL_PERIOD_DAYS: z.string().optional(),
  STRIPE_TRIAL_END_REMINDER_DAYS: z.string().default('3'),

  // AWS / S3 Configuration
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_ROLE_ARN: z.string().optional(),
  S3_BUCKET_NAME: z.string().optional(),
  S3_ENDPOINT: z.string().optional(), // For MinIO: http://minio:9000
  S3_FORCE_PATH_STYLE: z.string().default('false'), // Required for MinIO
  S3_DOWNLOAD_EXPIRY_HOURS: z.string().default('4'), // Download link expiry

  // Config Provider
  CONFIG_PROVIDER: z.enum(['env', 'secrets-manager', 'kubernetes']).default('env'),
  AWS_SECRETS_PREFIX: z.string().default('license-server/'),
  AWS_SECRETS_CACHE_TTL: z.string().default('300'),
  K8S_NAMESPACE: z.string().default('default'),
  K8S_CONFIG_PATH: z.string().default('/etc/config'),
  K8S_SECRETS_PATH: z.string().default('/etc/secrets'),

  // Auth Provider
  AUTH_PROVIDER: z.enum(['jwt', 'cognito']).default('jwt'),
  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_CLIENT_ID: z.string().optional(),
  COGNITO_REGION: z.string().optional(),
  COGNITO_ADMIN_GROUP: z.string().default('Admins'),

  // CORS Configuration
  CORS_ENABLED: z.string().default('true'),
  CORS_ORIGINS: z.string().default('*'),
  CORS_METHODS: z.string().default('GET,POST,PUT,DELETE,OPTIONS'),
  CORS_ALLOWED_HEADERS: z.string().default('Content-Type,Authorization,X-License-Key'),
  CORS_CREDENTIALS: z.string().default('true'),
  CORS_MAX_AGE: z.string().default('86400'),

  // Offline License Signing
  LICENSE_PRIVATE_KEY_PATH: z.string().optional(),
  LICENSE_PUBLIC_KEY_PATH: z.string().optional(),

  // Email Service (Microsoft Graph / Office 365)
  AZURE_TENANT_ID: z.string().optional(),
  AZURE_CLIENT_ID: z.string().optional(),
  AZURE_CLIENT_SECRET: z.string().optional(),
  EMAIL_SENDER: z.string().email().optional(),
  APP_NAME: z.string().default('License Server'),
  SUPPORT_EMAIL: z.string().email().optional(),

  // Application URL (for email links, password reset, etc.)
  APP_URL: z.string().url().optional(),

  // Redis Configuration
  REDIS_URL: z.string().optional(),

  // hCaptcha Configuration
  HCAPTCHA_SITE_KEY: z.string().optional(),
  HCAPTCHA_SECRET_KEY: z.string().optional(),
  CAPTCHA_FAIL_OPEN: z.string().default('false'),

  // Account Lockout Configuration
  ACCOUNT_LOCKOUT_ATTEMPTS: z.string().default('5'),
  ACCOUNT_LOCKOUT_DURATION_MINUTES: z.string().default('15'),

  // License Configuration
  OFFLINE_GRACE_DAYS: z.string().default('7'),
  CHECK_IN_INTERVAL_DAYS: z.string().default('7'),

  // Request Configuration
  REQUEST_TIMEOUT_MS: z.string().default('30000'),
  REQUEST_BODY_LIMIT: z.string().default('10mb'),

  // Session idle timeout (warns at SESSION_IDLE_WARN_MS, signs out at
  // SESSION_IDLE_TIMEOUT_MS). Frontend reads SESSION_IDLE_* via /api/auth/idle-config.
  SESSION_IDLE_TIMEOUT_MS: z.string().default('900000'),
  SESSION_IDLE_WARN_MS: z.string().default('840000'),

  // mTLS Agent CA (P1.1 — bootstrap; P1.2 — enroll endpoint)
  // Off by default; customers opt-in per their deployment.
  MTLS_AGENT_CA_ENABLED: z.string().default('false'),
  MTLS_CA_SECRET_NAME: z.string().default('preprod/silo-license-ca'),
  MTLS_CA_REGION: z.string().optional(),
  MTLS_CA_COMMON_NAME: z.string().default('SILO License CA'),
  MTLS_CA_ORG: z.string().default('SILO'),
  MTLS_CA_VALIDITY_YEARS: z.string().default('10'),
  MTLS_AGENT_CERT_VALIDITY_DAYS: z.string().default('30'),
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();

export const isProduction = config.NODE_ENV === 'production';
export const isDevelopment = config.NODE_ENV === 'development';
