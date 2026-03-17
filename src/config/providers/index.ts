/**
 * Configuration Provider Factory
 *
 * Supports multiple configuration sources:
 * - env: Environment variables (default)
 * - secrets-manager: AWS Secrets Manager
 * - kubernetes: Kubernetes ConfigMaps/Secrets
 */

import { EnvConfigProvider } from './env.provider.js';
import { SecretsManagerConfigProvider } from './secrets-manager.provider.js';
import { KubernetesConfigProvider } from './kubernetes.provider.js';

export type ConfigProviderType = 'env' | 'secrets-manager' | 'kubernetes';

export interface ConfigProviderInterface {
  /**
   * Get a configuration value by key
   */
  get(key: string): Promise<string | undefined>;

  /**
   * Get a required configuration value, throws if not found
   */
  getRequired(key: string): Promise<string>;

  /**
   * Refresh cached configuration values
   */
  refresh(): Promise<void>;

  /**
   * Initialize the provider (load initial values)
   */
  initialize(): Promise<void>;
}

// Singleton instance
let configProvider: ConfigProviderInterface | null = null;

/**
 * Get the configuration provider based on CONFIG_PROVIDER env var
 */
export function getConfigProvider(): ConfigProviderInterface {
  if (configProvider) {
    return configProvider;
  }

  const providerType = (process.env.CONFIG_PROVIDER || 'env') as ConfigProviderType;

  switch (providerType) {
    case 'secrets-manager':
      configProvider = new SecretsManagerConfigProvider();
      break;
    case 'kubernetes':
      configProvider = new KubernetesConfigProvider();
      break;
    case 'env':
    default:
      configProvider = new EnvConfigProvider();
      break;
  }

  return configProvider;
}

/**
 * Initialize the config provider (async operation)
 */
export async function initializeConfigProvider(): Promise<void> {
  const provider = getConfigProvider();
  await provider.initialize();
}

/**
 * Reset the config provider (for testing)
 */
export function resetConfigProvider(): void {
  configProvider = null;
}

export { EnvConfigProvider, SecretsManagerConfigProvider, KubernetesConfigProvider };
