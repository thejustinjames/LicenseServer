/**
 * AWS Client Factory with IAM Role / Service Account Support
 *
 * Provides a unified way to create AWS SDK clients with automatic
 * credential resolution. Supports:
 *
 * 1. IRSA (EKS Service Account) - fromTokenFile()
 * 2. ECS Task Role - fromContainerMetadata()
 * 3. EC2 Instance Profile - fromContainerMetadata()
 * 4. Environment variables - fromEnv()
 * 5. AWS config file - fromIni()
 *
 * No hardcoded credentials needed when running in AWS!
 */

import {
  fromEnv,
  fromIni,
  fromContainerMetadata,
  fromTokenFile,
} from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';
import { S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * Detect the runtime environment
 */
export type RuntimeEnvironment = 'eks' | 'ecs' | 'ec2' | 'lambda' | 'local';

export function detectRuntimeEnvironment(): RuntimeEnvironment {
  // EKS with IRSA
  if (process.env.AWS_WEB_IDENTITY_TOKEN_FILE) {
    return 'eks';
  }

  // ECS Task
  if (process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI) {
    return 'ecs';
  }

  // Lambda
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return 'lambda';
  }

  // EC2 (check for instance metadata)
  // Note: This is a heuristic, actual check requires HTTP request
  if (process.env.AWS_REGION && !process.env.AWS_ACCESS_KEY_ID) {
    return 'ec2';
  }

  return 'local';
}

/**
 * Get AWS credentials using the appropriate provider chain
 */
export function getAWSCredentials(): AwsCredentialIdentityProvider | undefined {
  const env = detectRuntimeEnvironment();

  // If explicit credentials are provided, use them
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    console.debug('Using explicit AWS credentials from environment');
    return fromEnv();
  }

  switch (env) {
    case 'eks':
      // EKS with IRSA - use web identity token
      console.debug('Using EKS IRSA credentials');
      return fromTokenFile({
        roleArn: process.env.AWS_ROLE_ARN,
        webIdentityTokenFile: process.env.AWS_WEB_IDENTITY_TOKEN_FILE,
      });

    case 'ecs':
      // ECS Task Role or EC2 Instance Profile
      console.debug('Using ECS/EC2 container credentials');
      return fromContainerMetadata();

    case 'ec2':
      // EC2 Instance Profile (via IMDS)
      console.debug('Using EC2 instance profile credentials');
      return fromContainerMetadata({
        timeout: 1000,
        maxRetries: 1,
      });

    case 'lambda':
      // Lambda uses environment credentials automatically
      console.debug('Using Lambda execution role credentials');
      return undefined; // SDK handles this automatically

    case 'local':
    default:
      // Local development - try AWS CLI config
      if (process.env.AWS_PROFILE) {
        console.debug(`Using AWS profile: ${process.env.AWS_PROFILE}`);
        return fromIni({ profile: process.env.AWS_PROFILE });
      }
      // Return undefined to let SDK use default credential chain
      console.debug('Using default AWS credential chain');
      return undefined;
  }
}

/**
 * Get the AWS region from environment or default
 */
export function getAWSRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
}

/**
 * Create an S3 client with automatic credential resolution
 * Supports MinIO and other S3-compatible storage via S3_ENDPOINT
 */
export function createS3Client(): S3Client {
  const endpoint = process.env.S3_ENDPOINT;
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';

  const config: ConstructorParameters<typeof S3Client>[0] = {
    region: getAWSRegion(),
    credentials: getAWSCredentials(),
  };

  // For MinIO or other S3-compatible storage
  if (endpoint) {
    console.debug(`Using custom S3 endpoint: ${endpoint}`);
    config.endpoint = endpoint;
    config.forcePathStyle = forcePathStyle;
  }

  return new S3Client(config);
}

/**
 * Create a Secrets Manager client with automatic credential resolution
 */
export function createSecretsManagerClient(): SecretsManagerClient {
  return new SecretsManagerClient({
    region: getAWSRegion(),
    credentials: getAWSCredentials(),
  });
}

/**
 * AWS client configuration options
 */
export interface AWSClientConfig {
  region?: string;
  credentials?: AwsCredentialIdentityProvider;
}

/**
 * Get common AWS client configuration
 */
export function getAWSClientConfig(): AWSClientConfig {
  return {
    region: getAWSRegion(),
    credentials: getAWSCredentials(),
  };
}

/**
 * Assume a role for cross-account access
 */
export async function assumeRoleCredentials(
  roleArn: string,
  sessionName = 'license-server-session'
): Promise<AwsCredentialIdentityProvider> {
  const { fromTemporaryCredentials } = await import('@aws-sdk/credential-providers');

  return fromTemporaryCredentials({
    params: {
      RoleArn: roleArn,
      RoleSessionName: sessionName,
      DurationSeconds: 3600, // 1 hour
    },
    masterCredentials: getAWSCredentials(),
  });
}
