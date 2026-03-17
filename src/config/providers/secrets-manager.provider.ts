/**
 * AWS Secrets Manager Configuration Provider
 *
 * Retrieves configuration from AWS Secrets Manager with caching.
 * Falls back to environment variables if a secret is not found.
 *
 * Configuration:
 * - AWS_SECRETS_PREFIX: Prefix for secret names (default: 'license-server/')
 * - AWS_SECRETS_CACHE_TTL: Cache TTL in seconds (default: 300)
 * - AWS_REGION: AWS region for Secrets Manager
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
  ResourceNotFoundException
} from '@aws-sdk/client-secrets-manager';
import { getAWSCredentials } from '../aws.js';
import type { ConfigProviderInterface } from './index.js';

interface CachedSecret {
  value: string;
  expiresAt: number;
}

export class SecretsManagerConfigProvider implements ConfigProviderInterface {
  private client: SecretsManagerClient | null = null;
  private cache: Map<string, CachedSecret> = new Map();
  private prefix: string;
  private cacheTtl: number;
  private initialized = false;

  constructor() {
    this.prefix = process.env.AWS_SECRETS_PREFIX || 'license-server/';
    this.cacheTtl = parseInt(process.env.AWS_SECRETS_CACHE_TTL || '300', 10) * 1000; // Convert to ms
  }

  private getClient(): SecretsManagerClient {
    if (!this.client) {
      const region = process.env.AWS_REGION || 'us-east-1';
      this.client = new SecretsManagerClient({
        region,
        credentials: getAWSCredentials(),
      });
    }
    return this.client;
  }

  async get(key: string): Promise<string | undefined> {
    // Check cache first
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    // Try to get from Secrets Manager
    try {
      const secretName = `${this.prefix}${key.toLowerCase().replace(/_/g, '-')}`;
      const command = new GetSecretValueCommand({ SecretId: secretName });
      const response = await this.getClient().send(command);

      let value: string | undefined;

      if (response.SecretString) {
        // Check if it's JSON (for secrets with multiple key-value pairs)
        try {
          const parsed = JSON.parse(response.SecretString);
          // If it's an object, try to get the specific key
          if (typeof parsed === 'object' && parsed !== null) {
            value = parsed[key] || parsed[key.toLowerCase()] || response.SecretString;
          } else {
            value = response.SecretString;
          }
        } catch {
          // Not JSON, use as-is
          value = response.SecretString;
        }
      }

      if (value) {
        this.cache.set(key, {
          value,
          expiresAt: Date.now() + this.cacheTtl,
        });
        return value;
      }
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        // Secret not found, fall back to environment variable
        console.debug(`Secret ${key} not found in Secrets Manager, using env var`);
      } else {
        console.warn(`Error fetching secret ${key}:`, error instanceof Error ? error.message : error);
      }
    }

    // Fall back to environment variable
    return process.env[key];
  }

  async getRequired(key: string): Promise<string> {
    const value = await this.get(key);
    if (value === undefined || value === '') {
      throw new Error(`Required configuration key "${key}" not found in Secrets Manager or environment`);
    }
    return value;
  }

  async refresh(): Promise<void> {
    // Clear the cache to force re-fetching
    this.cache.clear();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Verify we can connect to Secrets Manager
    try {
      // Just create the client to verify credentials
      this.getClient();
      console.log('Secrets Manager provider initialized');
    } catch (error) {
      console.error('Failed to initialize Secrets Manager provider:', error);
      throw error;
    }

    this.initialized = true;
  }

  /**
   * Preload a batch of secrets for better performance
   */
  async preload(keys: string[]): Promise<void> {
    await Promise.all(keys.map(key => this.get(key)));
  }
}
