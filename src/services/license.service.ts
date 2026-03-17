import { prisma } from '../config/database.js';
import { License, LicenseStatus, LicenseActivation, Prisma } from '@prisma/client';
import { generateLicenseKey, validateLicenseKeyFormat } from '../utils/license-key.js';
import { generateOfflineLicenseToken } from '../utils/crypto.js';
import * as emailService from './email.service.js';
import type { LicenseValidationResponse, OfflineLicensePayload } from '../types/index.js';

export interface CreateLicenseInput {
  customerId: string;
  productId: string;
  expiresAt?: Date;
  maxActivations?: number;
  metadata?: Prisma.InputJsonValue;
}

export interface UpdateLicenseInput {
  status?: LicenseStatus;
  expiresAt?: Date;
  maxActivations?: number;
  metadata?: Prisma.InputJsonValue;
}

export interface LicenseWithRelations extends License {
  customer: { id: string; email: string; name: string | null };
  product: { id: string; name: string; features: string[] };
  activations: LicenseActivation[];
}

export async function createLicense(input: CreateLicenseInput): Promise<License> {
  const key = generateLicenseKey();

  return prisma.license.create({
    data: {
      key,
      customerId: input.customerId,
      productId: input.productId,
      expiresAt: input.expiresAt,
      maxActivations: input.maxActivations || 1,
      metadata: input.metadata,
    },
  });
}

export async function getLicenseById(id: string): Promise<LicenseWithRelations | null> {
  return prisma.license.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, email: true, name: true } },
      product: { select: { id: true, name: true, features: true } },
      activations: true,
    },
  });
}

export async function getLicenseByKey(key: string): Promise<LicenseWithRelations | null> {
  if (!validateLicenseKeyFormat(key)) {
    return null;
  }

  return prisma.license.findUnique({
    where: { key },
    include: {
      customer: { select: { id: true, email: true, name: true } },
      product: { select: { id: true, name: true, features: true } },
      activations: true,
    },
  });
}

export async function listLicenses(filters?: {
  customerId?: string;
  productId?: string;
  status?: LicenseStatus;
}): Promise<LicenseWithRelations[]> {
  return prisma.license.findMany({
    where: {
      customerId: filters?.customerId,
      productId: filters?.productId,
      status: filters?.status,
    },
    include: {
      customer: { select: { id: true, email: true, name: true } },
      product: { select: { id: true, name: true, features: true } },
      activations: true,
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function updateLicense(id: string, input: UpdateLicenseInput): Promise<License> {
  return prisma.license.update({
    where: { id },
    data: input,
  });
}

export async function revokeLicense(id: string): Promise<License> {
  return prisma.license.update({
    where: { id },
    data: { status: 'REVOKED' },
  });
}

export async function suspendLicense(id: string): Promise<License> {
  return prisma.license.update({
    where: { id },
    data: { status: 'SUSPENDED' },
  });
}

export async function reactivateLicense(id: string): Promise<License> {
  return prisma.license.update({
    where: { id },
    data: { status: 'ACTIVE' },
  });
}

export async function validateLicense(
  licenseKey: string,
  machineFingerprint?: string
): Promise<LicenseValidationResponse> {
  const license = await getLicenseByKey(licenseKey);

  if (!license) {
    return { valid: false, error: 'Invalid license key' };
  }

  if (license.status === 'REVOKED') {
    return { valid: false, error: 'License has been revoked' };
  }

  if (license.status === 'SUSPENDED') {
    return { valid: false, error: 'License is suspended' };
  }

  if (license.status === 'EXPIRED' || (license.expiresAt && license.expiresAt < new Date())) {
    return { valid: false, error: 'License has expired' };
  }

  if (machineFingerprint) {
    const activation = license.activations.find(
      (a) => a.machineFingerprint === machineFingerprint
    );

    if (!activation) {
      if (license.activations.length >= license.maxActivations) {
        return { valid: false, error: 'Maximum activations reached' };
      }
    }
  }

  await prisma.license.update({
    where: { id: license.id },
    data: { lastValidatedAt: new Date() },
  });

  return {
    valid: true,
    product: license.product.name,
    expiresAt: license.expiresAt?.toISOString(),
    features: license.product.features,
  };
}

export async function activateLicense(
  licenseKey: string,
  machineFingerprint: string,
  machineName?: string,
  ipAddress?: string
): Promise<{ success: boolean; activation?: LicenseActivation; error?: string }> {
  const license = await getLicenseByKey(licenseKey);

  if (!license) {
    return { success: false, error: 'Invalid license key' };
  }

  if (license.status !== 'ACTIVE') {
    return { success: false, error: `License is ${license.status.toLowerCase()}` };
  }

  if (license.expiresAt && license.expiresAt < new Date()) {
    return { success: false, error: 'License has expired' };
  }

  const existingActivation = license.activations.find(
    (a) => a.machineFingerprint === machineFingerprint
  );

  if (existingActivation) {
    const updated = await prisma.licenseActivation.update({
      where: { id: existingActivation.id },
      data: { lastSeenAt: new Date(), ipAddress },
    });
    return { success: true, activation: updated };
  }

  if (license.activations.length >= license.maxActivations) {
    return { success: false, error: 'Maximum activations reached' };
  }

  const activation = await prisma.licenseActivation.create({
    data: {
      licenseId: license.id,
      machineFingerprint,
      machineName,
      ipAddress,
    },
  });

  // Send license activated email (fire and forget)
  emailService.sendLicenseActivatedEmail(
    license.customer.email,
    license.customer.name || undefined,
    license.product.name,
    licenseKey,
    machineName,
    license.expiresAt?.toLocaleDateString()
  ).catch((err) => {
    console.error('Failed to send license activated email:', err);
  });

  return { success: true, activation };
}

export async function deactivateLicense(
  licenseKey: string,
  machineFingerprint: string
): Promise<{ success: boolean; error?: string }> {
  const license = await getLicenseByKey(licenseKey);

  if (!license) {
    return { success: false, error: 'Invalid license key' };
  }

  const activation = license.activations.find(
    (a) => a.machineFingerprint === machineFingerprint
  );

  if (!activation) {
    return { success: false, error: 'Activation not found' };
  }

  await prisma.licenseActivation.delete({
    where: { id: activation.id },
  });

  return { success: true };
}

export async function generateOfflineLicense(licenseId: string): Promise<string | null> {
  const license = await getLicenseById(licenseId);

  if (!license) {
    return null;
  }

  const payload: OfflineLicensePayload = {
    licenseId: license.id,
    productId: license.product.id,
    customerId: license.customer.id,
    features: license.product.features,
    expiresAt: license.expiresAt?.toISOString() || null,
    issuedAt: new Date().toISOString(),
    gracePeriodDays: 7,
  };

  return generateOfflineLicenseToken(payload);
}

export async function getLicensesByCustomerId(customerId: string): Promise<LicenseWithRelations[]> {
  return prisma.license.findMany({
    where: { customerId },
    include: {
      customer: { select: { id: true, email: true, name: true } },
      product: { select: { id: true, name: true, features: true, s3PackageKey: true, version: true } },
      activations: true,
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function expireLicensesForSubscription(stripeSubscriptionId: string): Promise<void> {
  const subscription = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId },
    include: { customer: true },
  });

  if (!subscription) {
    return;
  }

  await prisma.license.updateMany({
    where: {
      customerId: subscription.customerId,
      status: 'ACTIVE',
    },
    data: { status: 'EXPIRED' },
  });
}

export async function suspendLicensesForSubscription(stripeSubscriptionId: string): Promise<void> {
  const subscription = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId },
    include: { customer: true },
  });

  if (!subscription) {
    return;
  }

  await prisma.license.updateMany({
    where: {
      customerId: subscription.customerId,
      status: 'ACTIVE',
    },
    data: { status: 'SUSPENDED' },
  });
}
