/**
 * Environment Variables Configuration Provider
 *
 * The default provider that reads configuration from environment variables.
 * This is the current behavior of the application.
 */

import type { ConfigProviderInterface } from './index.js';

export class EnvConfigProvider implements ConfigProviderInterface {
  private initialized = false;

  async get(key: string): Promise<string | undefined> {
    return process.env[key];
  }

  async getRequired(key: string): Promise<string> {
    const value = process.env[key];
    if (value === undefined || value === '') {
      throw new Error(`Required configuration key "${key}" not found in environment variables`);
    }
    return value;
  }

  async refresh(): Promise<void> {
    // Environment variables don't need refresh
    // They are always read directly from process.env
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    // No async initialization needed for env vars
    this.initialized = true;
  }
}
