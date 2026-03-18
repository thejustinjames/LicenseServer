import * as crypto from 'crypto';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

export interface LicenseClientConfig {
  serverUrl: string;
  productId?: string;
  cacheDir?: string;
  cacheTTL?: number; // seconds
  offlineGracePeriod?: number; // days
  publicKey?: string; // For offline validation
}

export interface ValidationResult {
  valid: boolean;
  product?: string;
  expiresAt?: string;
  features?: string[];
  error?: string;
  cached?: boolean;
}

export interface ActivationResult {
  success: boolean;
  error?: string;
  activation?: {
    machineFingerprint: string;
    activatedAt: string;
  };
}

export interface LicenseInfo {
  licenseKey: string;
  product: string;
  features: string[];
  expiresAt: string | null;
  validatedAt: string;
  machineFingerprint: string;
}

export class LicenseClient {
  private config: Required<LicenseClientConfig>;
  private machineFingerprint: string;
  private fetch: typeof globalThis.fetch;

  constructor(config: LicenseClientConfig) {
    this.config = {
      serverUrl: config.serverUrl.replace(/\/$/, ''),
      productId: config.productId || '',
      cacheDir: config.cacheDir || path.join(os.homedir(), '.license-cache'),
      cacheTTL: config.cacheTTL || 3600,
      offlineGracePeriod: config.offlineGracePeriod || 7,
      publicKey: config.publicKey || '',
    };

    this.machineFingerprint = this.generateMachineFingerprint();
    this.fetch = globalThis.fetch;

    // Ensure cache directory exists
    if (!fs.existsSync(this.config.cacheDir)) {
      fs.mkdirSync(this.config.cacheDir, { recursive: true });
    }
  }

  /**
   * Generate a unique machine fingerprint based on hardware identifiers
   */
  private generateMachineFingerprint(): string {
    const components = [
      os.hostname(),
      os.platform(),
      os.arch(),
      os.cpus()[0]?.model || 'unknown',
      os.totalmem().toString(),
    ];

    // Try to get MAC address
    const networkInterfaces = os.networkInterfaces();
    for (const [, interfaces] of Object.entries(networkInterfaces)) {
      if (interfaces) {
        for (const iface of interfaces) {
          if (!iface.internal && iface.mac !== '00:00:00:00:00:00') {
            components.push(iface.mac);
            break;
          }
        }
      }
    }

    return crypto
      .createHash('sha256')
      .update(components.join('|'))
      .digest('hex')
      .slice(0, 32);
  }

  /**
   * Get the machine fingerprint
   */
  getMachineFingerprint(): string {
    return this.machineFingerprint;
  }

  /**
   * Validate a license key against the server
   */
  async validate(licenseKey: string): Promise<ValidationResult> {
    // Try cache first
    const cached = this.getCachedValidation(licenseKey);
    if (cached) {
      return { ...cached, cached: true };
    }

    try {
      const response = await this.fetch(`${this.config.serverUrl}/api/v1/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          licenseKey,
          machineFingerprint: this.machineFingerprint,
          productId: this.config.productId || undefined,
        }),
      });

      const result = (await response.json()) as ValidationResult;

      if (result.valid) {
        this.cacheValidation(licenseKey, result);
      }

      return result;
    } catch (error) {
      // Network error - try offline validation
      const offlineResult = this.validateOffline(licenseKey);
      if (offlineResult) {
        return { ...offlineResult, cached: true };
      }

      return {
        valid: false,
        error: `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Activate the license on this machine
   */
  async activate(licenseKey: string, machineName?: string): Promise<ActivationResult> {
    try {
      const response = await this.fetch(`${this.config.serverUrl}/api/v1/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          licenseKey,
          machineFingerprint: this.machineFingerprint,
          machineName: machineName || os.hostname(),
        }),
      });

      const result = (await response.json()) as ActivationResult;

      if (result.success) {
        // Validate and cache after activation
        await this.validate(licenseKey);
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Deactivate the license from this machine
   */
  async deactivate(licenseKey: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.fetch(`${this.config.serverUrl}/api/v1/deactivate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          licenseKey,
          machineFingerprint: this.machineFingerprint,
        }),
      });

      const result = (await response.json()) as { success: boolean; error?: string };

      if (result.success) {
        this.clearCache(licenseKey);
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Check if a license is valid (uses cache if available)
   */
  async isValid(licenseKey: string): Promise<boolean> {
    const result = await this.validate(licenseKey);
    return result.valid;
  }

  /**
   * Check if a specific feature is enabled
   */
  async hasFeature(licenseKey: string, feature: string): Promise<boolean> {
    const result = await this.validate(licenseKey);
    return result.valid && (result.features?.includes(feature) || false);
  }

  /**
   * Get cached license info
   */
  getCachedLicense(licenseKey: string): LicenseInfo | null {
    const cachePath = this.getCachePath(licenseKey);
    if (!fs.existsSync(cachePath)) {
      return null;
    }

    try {
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      return data.license || null;
    } catch {
      return null;
    }
  }

  // Private helper methods

  private getCachePath(licenseKey: string): string {
    const hash = crypto.createHash('sha256').update(licenseKey).digest('hex').slice(0, 16);
    return path.join(this.config.cacheDir, `${hash}.json`);
  }

  private getCachedValidation(licenseKey: string): ValidationResult | null {
    const cachePath = this.getCachePath(licenseKey);
    if (!fs.existsSync(cachePath)) {
      return null;
    }

    try {
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      const cacheAge = (Date.now() - data.timestamp) / 1000;

      // Check if cache is still valid
      if (cacheAge < this.config.cacheTTL) {
        return data.result;
      }

      // Check offline grace period
      const gracePeriodSeconds = this.config.offlineGracePeriod * 24 * 3600;
      if (cacheAge < gracePeriodSeconds && data.result.valid) {
        return data.result;
      }

      return null;
    } catch {
      return null;
    }
  }

  private cacheValidation(licenseKey: string, result: ValidationResult): void {
    const cachePath = this.getCachePath(licenseKey);
    const data = {
      timestamp: Date.now(),
      result,
      license: {
        licenseKey,
        product: result.product,
        features: result.features || [],
        expiresAt: result.expiresAt || null,
        validatedAt: new Date().toISOString(),
        machineFingerprint: this.machineFingerprint,
      },
    };

    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
  }

  private clearCache(licenseKey: string): void {
    const cachePath = this.getCachePath(licenseKey);
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
    }
  }

  private validateOffline(licenseKey: string): ValidationResult | null {
    // Try to use cached validation within grace period
    const cachePath = this.getCachePath(licenseKey);
    if (!fs.existsSync(cachePath)) {
      return null;
    }

    try {
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      const cacheAge = (Date.now() - data.timestamp) / 1000;
      const gracePeriodSeconds = this.config.offlineGracePeriod * 24 * 3600;

      if (cacheAge < gracePeriodSeconds && data.result.valid) {
        return data.result;
      }

      return null;
    } catch {
      return null;
    }
  }
}

/**
 * Express/Connect middleware for license validation
 */
export function licenseMiddleware(
  client: LicenseClient,
  options: {
    licenseHeader?: string;
    requiredFeatures?: string[];
    onInvalid?: (req: unknown, res: unknown, result: ValidationResult) => void;
  } = {}
) {
  const {
    licenseHeader = 'X-License-Key',
    requiredFeatures = [],
    onInvalid,
  } = options;

  return async (req: any, res: any, next: () => void) => {
    const licenseKey = req.headers[licenseHeader.toLowerCase()];

    if (!licenseKey) {
      const result = { valid: false, error: 'License key required' };
      if (onInvalid) {
        onInvalid(req, res, result);
      } else {
        res.status(401).json(result);
      }
      return;
    }

    const result = await client.validate(licenseKey);

    if (!result.valid) {
      if (onInvalid) {
        onInvalid(req, res, result);
      } else {
        res.status(403).json(result);
      }
      return;
    }

    // Check required features
    for (const feature of requiredFeatures) {
      if (!result.features?.includes(feature)) {
        const featureResult = {
          valid: false,
          error: `Required feature not available: ${feature}`,
        };
        if (onInvalid) {
          onInvalid(req, res, featureResult);
        } else {
          res.status(403).json(featureResult);
        }
        return;
      }
    }

    // Attach license info to request
    (req as any).license = result;
    next();
  };
}

/**
 * Vite plugin for license validation during build
 */
export function viteLicensePlugin(
  licenseKey: string,
  client: LicenseClient,
  options: { requiredFeatures?: string[] } = {}
) {
  return {
    name: 'vite-license-plugin',
    async buildStart() {
      const result = await client.validate(licenseKey);

      if (!result.valid) {
        throw new Error(`License validation failed: ${result.error}`);
      }

      for (const feature of options.requiredFeatures || []) {
        if (!result.features?.includes(feature)) {
          throw new Error(`Required feature not available: ${feature}`);
        }
      }

      console.log(`License validated: ${result.product}`);
    },
  };
}

export default LicenseClient;
