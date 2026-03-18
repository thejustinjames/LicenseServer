import { prisma } from '../config/database.js';
import { Platform, LicenseActivation } from '@prisma/client';
import { generateOfflineLicenseToken } from '../utils/crypto.js';
import type { OfflineLicensePayload } from '../types/index.js';
import * as licenseService from './license.service.js';

export interface DesktopValidationInput {
  licenseKey: string;
  machineFingerprint: string;
  platform: 'windows' | 'macos' | 'linux';
  appVersion?: string;
  osVersion?: string;
}

export interface DesktopValidationResult {
  valid: boolean;
  error?: string;
  product?: string;
  features?: string[];
  expiresAt?: string;
  offlineToken?: string;
  checkInDays: number;
  activationId?: string;
}

export interface CheckInInput {
  licenseKey: string;
  machineFingerprint: string;
  appVersion?: string;
  lastUsed?: Date;
}

export interface CheckInResult {
  valid: boolean;
  error?: string;
  renewedToken?: string;
  message?: string;
  nextCheckIn?: Date;
}

/**
 * Map string platform to Prisma Platform enum
 */
function mapPlatform(platform: string): Platform {
  switch (platform.toLowerCase()) {
    case 'windows':
      return 'WINDOWS';
    case 'macos':
    case 'mac':
      return 'MACOS';
    case 'linux':
      return 'LINUX';
    default:
      return 'WEB';
  }
}

/**
 * Validate a desktop license and activate if needed
 */
export async function validateDesktopLicense(
  input: DesktopValidationInput
): Promise<DesktopValidationResult> {
  // First, validate the license
  const validation = await licenseService.validateLicense(
    input.licenseKey,
    input.machineFingerprint
  );

  if (!validation.valid) {
    return {
      valid: false,
      error: validation.error,
      checkInDays: 0,
    };
  }

  // Get the full license with product details
  const license = await licenseService.getLicenseByKey(input.licenseKey);

  if (!license) {
    return {
      valid: false,
      error: 'License not found',
      checkInDays: 0,
    };
  }

  // Get or create activation
  let activation = license.activations.find(
    (a) => a.machineFingerprint === input.machineFingerprint
  );

  const platformEnum = mapPlatform(input.platform);

  if (activation) {
    // Update existing activation
    activation = await prisma.licenseActivation.update({
      where: { id: activation.id },
      data: {
        lastSeenAt: new Date(),
        lastCheckIn: new Date(),
        platform: platformEnum,
        appVersion: input.appVersion,
        osVersion: input.osVersion,
      },
    });
  } else {
    // Check if we can create new activation
    if (license.activations.length >= license.maxActivations) {
      return {
        valid: false,
        error: 'Maximum activations reached',
        checkInDays: 0,
      };
    }

    // Create new activation
    activation = await prisma.licenseActivation.create({
      data: {
        licenseId: license.id,
        machineFingerprint: input.machineFingerprint,
        platform: platformEnum,
        appVersion: input.appVersion,
        osVersion: input.osVersion,
        lastCheckIn: new Date(),
      },
    });
  }

  // Get offline grace days from product or use default
  const product = await prisma.product.findUnique({
    where: { id: license.productId },
  });

  const offlineGraceDays = product?.offlineGraceDays || 7;
  const checkInIntervalDays = product?.checkInIntervalDays || 7;

  // Generate offline token
  const payload: OfflineLicensePayload = {
    licenseId: license.id,
    productId: license.productId,
    customerId: license.customerId,
    features: license.product.features,
    expiresAt: license.expiresAt?.toISOString() || null,
    issuedAt: new Date().toISOString(),
    gracePeriodDays: offlineGraceDays,
  };

  const offlineToken = generateOfflineLicenseToken(payload);

  // Store the offline token in the activation
  if (offlineToken) {
    const tokenExpiry = new Date();
    tokenExpiry.setDate(tokenExpiry.getDate() + offlineGraceDays);

    await prisma.licenseActivation.update({
      where: { id: activation.id },
      data: {
        offlineToken,
        offlineTokenExpiry: tokenExpiry,
      },
    });
  }

  return {
    valid: true,
    product: license.product.name,
    features: license.product.features,
    expiresAt: license.expiresAt?.toISOString(),
    offlineToken: offlineToken || undefined,
    checkInDays: checkInIntervalDays,
    activationId: activation.id,
  };
}

/**
 * Phone-home check-in for desktop apps
 */
export async function checkIn(input: CheckInInput): Promise<CheckInResult> {
  const license = await licenseService.getLicenseByKey(input.licenseKey);

  if (!license) {
    return {
      valid: false,
      error: 'Invalid license key',
    };
  }

  if (license.status !== 'ACTIVE') {
    return {
      valid: false,
      error: `License is ${license.status.toLowerCase()}`,
    };
  }

  if (license.expiresAt && license.expiresAt < new Date()) {
    return {
      valid: false,
      error: 'License has expired',
    };
  }

  // Find the activation
  const activation = license.activations.find(
    (a) => a.machineFingerprint === input.machineFingerprint
  );

  if (!activation) {
    return {
      valid: false,
      error: 'Machine not activated',
    };
  }

  // Get product settings
  const product = await prisma.product.findUnique({
    where: { id: license.productId },
  });

  const offlineGraceDays = product?.offlineGraceDays || 7;
  const checkInIntervalDays = product?.checkInIntervalDays || 7;

  // Generate new offline token
  const payload: OfflineLicensePayload = {
    licenseId: license.id,
    productId: license.productId,
    customerId: license.customerId,
    features: license.product.features,
    expiresAt: license.expiresAt?.toISOString() || null,
    issuedAt: new Date().toISOString(),
    gracePeriodDays: offlineGraceDays,
  };

  const renewedToken = generateOfflineLicenseToken(payload);

  // Calculate next check-in date
  const nextCheckIn = new Date();
  nextCheckIn.setDate(nextCheckIn.getDate() + checkInIntervalDays);

  // Update activation
  const tokenExpiry = new Date();
  tokenExpiry.setDate(tokenExpiry.getDate() + offlineGraceDays);

  await prisma.licenseActivation.update({
    where: { id: activation.id },
    data: {
      lastSeenAt: new Date(),
      lastCheckIn: new Date(),
      appVersion: input.appVersion,
      offlineToken: renewedToken,
      offlineTokenExpiry: tokenExpiry,
    },
  });

  // Update license last validated
  await prisma.license.update({
    where: { id: license.id },
    data: { lastValidatedAt: new Date() },
  });

  return {
    valid: true,
    renewedToken: renewedToken || undefined,
    message: 'Check-in successful',
    nextCheckIn,
  };
}

/**
 * Get activation details for a machine
 */
export async function getActivationDetails(
  licenseKey: string,
  machineFingerprint: string
): Promise<LicenseActivation | null> {
  const license = await licenseService.getLicenseByKey(licenseKey);

  if (!license) {
    return null;
  }

  return license.activations.find(
    (a) => a.machineFingerprint === machineFingerprint
  ) || null;
}

/**
 * List all desktop activations for a license
 */
export async function listDesktopActivations(licenseId: string): Promise<{
  activations: LicenseActivation[];
  platforms: Record<string, number>;
}> {
  const activations = await prisma.licenseActivation.findMany({
    where: { licenseId },
    orderBy: { lastSeenAt: 'desc' },
  });

  // Count by platform
  const platforms: Record<string, number> = {};
  for (const activation of activations) {
    const platform = activation.platform || 'UNKNOWN';
    platforms[platform] = (platforms[platform] || 0) + 1;
  }

  return { activations, platforms };
}

/**
 * Revoke a specific desktop activation
 */
export async function revokeActivation(
  activationId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await prisma.licenseActivation.delete({
      where: { id: activationId },
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: 'Activation not found' };
  }
}
