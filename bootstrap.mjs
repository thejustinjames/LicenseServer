/**
 * Bootstrap script for AWS Secrets Manager integration
 *
 * This script loads secrets from AWS Secrets Manager before starting the application.
 * It's designed to work with EKS and IRSA (IAM Roles for Service Accounts).
 *
 * Usage: node bootstrap.mjs && node dist/index.js
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadSecrets() {
  const useSecretsManager = process.env.USE_AWS_SECRETS_MANAGER === 'true';
  const secretName = process.env.AWS_SECRET_NAME;
  const region = process.env.AWS_SECRET_REGION || process.env.AWS_REGION || 'ap-southeast-1';

  if (!useSecretsManager) {
    console.log('AWS Secrets Manager disabled, using environment variables');
    return;
  }

  if (!secretName) {
    console.error('AWS_SECRET_NAME not set, cannot load secrets');
    process.exit(1);
  }

  console.log(`Loading secrets from AWS Secrets Manager: ${secretName} (${region})`);

  try {
    // IRSA automatically provides credentials via the pod's service account
    const client = new SecretsManagerClient({ region });

    const command = new GetSecretValueCommand({ SecretId: secretName });
    const response = await client.send(command);

    let secrets;
    if (response.SecretString) {
      secrets = JSON.parse(response.SecretString);
    } else {
      throw new Error('Secret does not contain a string value');
    }

    // Set environment variables from secrets
    const secretKeys = [
      'DATABASE_URL',
      'JWT_SECRET',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'COGNITO_USER_POOL_ID',
      'COGNITO_CLIENT_ID',
      'COGNITO_CLIENT_SECRET',
      'COGNITO_ADMIN_CLIENT_ID',
      'COGNITO_ADMIN_GROUP',
      'ADMIN_GROUP_NAME',
      'ADMIN_REQUIRE_MFA',
      'CUSTOMER_AUTH_ENABLED',
      'CUSTOMER_COGNITO_USER_POOL_ID',
      'CUSTOMER_COGNITO_CLIENT_ID',
      'CUSTOMER_COGNITO_SERVER_CLIENT_ID',
      'CUSTOMER_COGNITO_SERVER_CLIENT_SECRET',
      'CUSTOMER_COGNITO_REGION',
      'REDIS_HOST',
      'REDIS_URL',
      'HCAPTCHA_SITE_KEY',
      'HCAPTCHA_SECRET_KEY',
      'AZURE_TENANT_ID',
      'AZURE_CLIENT_ID',
      'AZURE_CLIENT_SECRET',
      'EMAIL_SENDER',
    ];

    let loadedCount = 0;
    for (const key of secretKeys) {
      if (secrets[key]) {
        process.env[key] = secrets[key];
        loadedCount++;
      }
    }

    // Handle RSA keys - write to files
    const keysDir = join(__dirname, 'keys');
    if (!existsSync(keysDir)) {
      mkdirSync(keysDir, { recursive: true });
    }

    if (secrets.RSA_PRIVATE_KEY) {
      writeFileSync(join(keysDir, 'private.pem'), secrets.RSA_PRIVATE_KEY, { mode: 0o600 });
      console.log('RSA private key written to keys/private.pem');
    }

    if (secrets.RSA_PUBLIC_KEY) {
      writeFileSync(join(keysDir, 'public.pem'), secrets.RSA_PUBLIC_KEY, { mode: 0o644 });
      console.log('RSA public key written to keys/public.pem');
    }

    console.log(`Successfully loaded ${loadedCount} secrets from AWS Secrets Manager`);

  } catch (error) {
    console.error('Failed to load secrets from AWS Secrets Manager:', error.message);

    // In production, fail hard if secrets can't be loaded
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }

    console.warn('Continuing with environment variables (development mode)');
  }
}

// Run bootstrap
loadSecrets()
  .then(() => {
    console.log('Bootstrap complete, starting application...');
  })
  .catch((error) => {
    console.error('Bootstrap failed:', error);
    process.exit(1);
  });
