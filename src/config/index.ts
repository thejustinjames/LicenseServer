import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string(),
  PORT: z.string().default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),

  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),

  STRIPE_SECRET_KEY: z.string(),
  STRIPE_WEBHOOK_SECRET: z.string(),
  STRIPE_SUCCESS_URL: z.string().url(),
  STRIPE_CANCEL_URL: z.string().url(),

  // AWS Configuration
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_ROLE_ARN: z.string().optional(),
  S3_BUCKET_NAME: z.string().optional(),

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
