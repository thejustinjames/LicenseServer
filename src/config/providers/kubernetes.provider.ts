/**
 * Kubernetes Configuration Provider
 *
 * Reads configuration from Kubernetes ConfigMaps and Secrets via:
 * 1. Environment variables (populated by envFrom in Pod spec)
 * 2. Mounted files (for volume-mounted secrets)
 *
 * Configuration:
 * - K8S_NAMESPACE: Kubernetes namespace (default: 'default')
 * - K8S_CONFIG_PATH: Path to mounted config files (default: '/etc/config')
 * - K8S_SECRETS_PATH: Path to mounted secrets (default: '/etc/secrets')
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ConfigProviderInterface } from './index.js';

export class KubernetesConfigProvider implements ConfigProviderInterface {
  private configPath: string;
  private secretsPath: string;
  private fileCache: Map<string, string> = new Map();
  private initialized = false;

  constructor() {
    this.configPath = process.env.K8S_CONFIG_PATH || '/etc/config';
    this.secretsPath = process.env.K8S_SECRETS_PATH || '/etc/secrets';
  }

  async get(key: string): Promise<string | undefined> {
    // Priority 1: Environment variables (from envFrom in Pod spec)
    const envValue = process.env[key];
    if (envValue !== undefined) {
      return envValue;
    }

    // Priority 2: Mounted secrets (volume mounts)
    const secretValue = this.readMountedFile(this.secretsPath, key);
    if (secretValue !== undefined) {
      return secretValue;
    }

    // Priority 3: Mounted config files
    const configValue = this.readMountedFile(this.configPath, key);
    if (configValue !== undefined) {
      return configValue;
    }

    return undefined;
  }

  async getRequired(key: string): Promise<string> {
    const value = await this.get(key);
    if (value === undefined || value === '') {
      throw new Error(
        `Required configuration key "${key}" not found in environment, ` +
        `secrets mount (${this.secretsPath}), or config mount (${this.configPath})`
      );
    }
    return value;
  }

  async refresh(): Promise<void> {
    // Clear file cache to force re-reading
    this.fileCache.clear();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Check if we're running in Kubernetes
    const inK8s = fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token');

    if (inK8s) {
      console.log('Running in Kubernetes environment');
      console.log(`Config path: ${this.configPath}`);
      console.log(`Secrets path: ${this.secretsPath}`);
    } else {
      console.log('Kubernetes provider initialized (not running in K8s, using env vars only)');
    }

    this.initialized = true;
  }

  /**
   * Read a value from a mounted file
   * Kubernetes mounts each key as a separate file
   */
  private readMountedFile(basePath: string, key: string): string | undefined {
    // Check cache first
    const cacheKey = `${basePath}/${key}`;
    if (this.fileCache.has(cacheKey)) {
      return this.fileCache.get(cacheKey);
    }

    // Try different file name formats
    const fileNames = [
      key,                                    // Exact match
      key.toLowerCase(),                      // Lowercase
      key.toLowerCase().replace(/_/g, '-'),   // Kebab-case
      key.toUpperCase(),                      // Uppercase
    ];

    for (const fileName of fileNames) {
      const filePath = path.join(basePath, fileName);
      try {
        if (fs.existsSync(filePath)) {
          const value = fs.readFileSync(filePath, 'utf-8').trim();
          this.fileCache.set(cacheKey, value);
          return value;
        }
      } catch (error) {
        // File doesn't exist or can't be read, continue to next option
      }
    }

    return undefined;
  }

  /**
   * List all available configuration keys from mounted volumes
   */
  listMountedKeys(): string[] {
    const keys: Set<string> = new Set();

    for (const basePath of [this.configPath, this.secretsPath]) {
      try {
        if (fs.existsSync(basePath)) {
          const files = fs.readdirSync(basePath);
          files.forEach(file => {
            // Skip hidden files and symlinks to ..data
            if (!file.startsWith('.') && !file.startsWith('..')) {
              keys.add(file);
            }
          });
        }
      } catch (error) {
        // Directory doesn't exist or can't be read
      }
    }

    return Array.from(keys);
  }
}
