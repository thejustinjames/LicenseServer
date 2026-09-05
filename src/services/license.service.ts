import { prisma } from '../config/database.js';
import { License, LicenseStatus, LicenseActivation, Prisma } from '@prisma/client';
import { generateLicenseKey, validateLicenseKeyFormat } from '../utils/license-key.js';
import { generateOfflineLicenseToken } from '../utils/crypto.js';
import { config } from '../config/index.js';
import * as emailService from './email.service.js';
import { logger } from './logger.service.js';
import type { LicenseValidationResponse, OfflineLicensePayload } from '../types/index.js';

export interface CreateLicenseInput {
  customerId: string;
  productId: string;
  expiresAt?: Date;
  maxActivations?: number;
  /** Total seats for team/enterprise licences. Defaults to product.defaultSeatCount when omitted. */
  seatCount?: number;
  /** Per-license component override. Empty/omitted means inherit from product.components. */
  enabledComponents?: string[];
  /** Local Subscription.id that paid for this license (subscription checkouts only). */
  subscriptionId?: string;
  metadata?: Prisma.InputJsonValue;
}

export interface UpdateLicenseInput {
  status?: LicenseStatus;
  /** `null` clears the expiry (perpetual); `undefined` leaves it unchanged. */
  expiresAt?: Date | null;
  maxActivations?: number;
  metadata?: Prisma.InputJsonValue;
}

export interface LicenseWithRelations extends License {
  customer: { id: string; email: string; name: string | null };
  product: { id: string; name: string; features: string[] };
  activations: LicenseActivation[];
}

type Db = Prisma.TransactionClient | typeof prisma;

export async function createLicense(input: CreateLicenseInput, db: Db = prisma): Promise<License> {
  const key = generateLicenseKey();

  // If the caller didn't specify seat count, pull the product's default so
  // team/enterprise SKUs (e.g. Cortex Business=5, Enterprise=10) issue with
  // their advertised capacity.
  let seatCount = input.seatCount;
  if (seatCount === undefined) {
    const product = await db.product.findUnique({
      where: { id: input.productId },
      select: { defaultSeatCount: true },
    });
    seatCount = product?.defaultSeatCount ?? 1;
  }

  return db.license.create({
    data: {
      key,
      customerId: input.customerId,
      productId: input.productId,
      subscriptionId: input.subscriptionId,
      expiresAt: input.expiresAt,
      maxActivations: input.maxActivations || 1,
      seatCount,
      enabledComponents: input.enabledComponents ?? [],
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

/**
 * Resolve the effective component list for a license: the per-license
 * `enabledComponents` override if non-empty, otherwise the product's
 * `components`. This is the source of truth for "what is this license
 * authorised to deploy".
 */
export function effectiveComponentsFor(license: {
  enabledComponents: string[];
  product: { components: string[] };
}): string[] {
  if (Array.isArray(license.enabledComponents) && license.enabledComponents.length > 0) {
    return license.enabledComponents;
  }
  return license.product.components || [];
}

export async function validateLicense(
  licenseKey: string,
  machineFingerprint?: string,
  component?: string,
): Promise<LicenseValidationResponse> {
  const license = await prisma.license.findUnique({
    where: { key: licenseKey },
    include: {
      customer: { select: { id: true, email: true, name: true } },
      product: { select: { id: true, name: true, features: true, components: true } },
      activations: true,
    },
  });

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
      (a) => a.machineFingerprint === machineFingerprint,
    );

    if (!activation) {
      if (license.activations.length >= license.maxActivations) {
        return { valid: false, error: 'Maximum activations reached' };
      }
    }
  }

  const components = effectiveComponentsFor(license);

  if (component && !components.includes(component)) {
    return {
      valid: false,
      error: `Component '${component}' is not enabled for this license`,
      components,
    };
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
    components,
  };
}

/**
 * Take a row-level lock on a license for the duration of the enclosing
 * interactive transaction. Used to make "count activations, then insert"
 * atomic so two concurrent activations cannot both slip under
 * `maxActivations`.
 */
export async function lockLicenseRow(tx: Prisma.TransactionClient, licenseId: string): Promise<void> {
  await tx.$executeRaw`SELECT id FROM "licenses" WHERE id = ${licenseId} FOR UPDATE`;
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

  // Seat-limit check and insert must be atomic: lock the license row, then
  // re-count inside the transaction.
  const result = await prisma.$transaction(async (tx) => {
    await lockLicenseRow(tx, license.id);

    const existing = await tx.licenseActivation.findUnique({
      where: { licenseId_machineFingerprint: { licenseId: license.id, machineFingerprint } },
    });
    if (existing) {
      const updated = await tx.licenseActivation.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date(), ipAddress },
      });
      return { success: true as const, activation: updated, created: false };
    }

    const count = await tx.licenseActivation.count({ where: { licenseId: license.id } });
    if (count >= license.maxActivations) {
      return { success: false as const, error: 'Maximum activations reached' };
    }

    const activation = await tx.licenseActivation.create({
      data: {
        licenseId: license.id,
        machineFingerprint,
        machineName,
        ipAddress,
      },
    });
    return { success: true as const, activation, created: true };
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  if (result.created) {
    // Send license activated email (fire and forget)
    emailService.sendLicenseActivatedEmail(
      license.customer.email,
      license.customer.name || undefined,
      license.product.name,
      licenseKey,
      machineName,
      license.expiresAt?.toLocaleDateString()
    ).catch((err) => {
      logger.error('Failed to send license activated email:', err);
    });
  }

  return { success: true, activation: result.activation };
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

/**
 * Offline grace period for a product: the product's own setting, falling
 * back to OFFLINE_GRACE_DAYS from config.
 */
export function offlineGraceDaysFor(product?: { offlineGraceDays?: number | null } | null): number {
  const fromProduct = product?.offlineGraceDays;
  if (typeof fromProduct === 'number' && fromProduct > 0) return fromProduct;
  const fromConfig = parseInt(config.OFFLINE_GRACE_DAYS, 10);
  return Number.isFinite(fromConfig) && fromConfig > 0 ? fromConfig : 7;
}

export async function generateOfflineLicense(licenseId: string): Promise<string | null> {
  const license = await prisma.license.findUnique({
    where: { id: licenseId },
    include: {
      customer: { select: { id: true } },
      product: { select: { id: true, features: true, offlineGraceDays: true } },
    },
  });

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
    gracePeriodDays: offlineGraceDaysFor(license.product),
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

/**
 * Build the `where` clause for the licenses affected by a subscription
 * lifecycle event. Licenses that record their issuing subscription are
 * targeted precisely; if a subscription has no linked licenses at all
 * (rows created before the link existed) we fall back to the customer's
 * subscription-term licenses so legacy data keeps behaving as before.
 */
async function licensesForSubscription(
  subscription: { id: string; customerId: string },
  fromStatus: LicenseStatus,
): Promise<Prisma.LicenseWhereInput> {
  const linked = await prisma.license.count({ where: { subscriptionId: subscription.id } });
  if (linked > 0) {
    return { subscriptionId: subscription.id, status: fromStatus };
  }
  return {
    customerId: subscription.customerId,
    subscriptionId: null,
    licenseTerm: 'SUBSCRIPTION',
    status: fromStatus,
  };
}

async function transitionLicensesForSubscription(
  stripeSubscriptionId: string,
  fromStatus: LicenseStatus,
  toStatus: LicenseStatus,
): Promise<number> {
  const subscription = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId },
    select: { id: true, customerId: true },
  });

  if (!subscription) {
    return 0;
  }

  const where = await licensesForSubscription(subscription, fromStatus);
  const result = await prisma.license.updateMany({ where, data: { status: toStatus } });
  return result.count;
}

export async function expireLicensesForSubscription(stripeSubscriptionId: string): Promise<void> {
  await transitionLicensesForSubscription(stripeSubscriptionId, 'ACTIVE', 'EXPIRED');
}

export async function suspendLicensesForSubscription(stripeSubscriptionId: string): Promise<void> {
  await transitionLicensesForSubscription(stripeSubscriptionId, 'ACTIVE', 'SUSPENDED');
}

export async function reactivateLicensesForSubscription(stripeSubscriptionId: string): Promise<void> {
  await transitionLicensesForSubscription(stripeSubscriptionId, 'SUSPENDED', 'ACTIVE');
}

/**
 * Revoke the licenses paid for by a given subscription (or, for one-time
 * purchases, the licenses matching a product) after a full refund. Returns
 * the number of licenses revoked. When neither a subscription nor a product
 * can be resolved the caller decides whether to fall back to customer-wide.
 */
export async function revokeLicensesForRefund(input: {
  customerId: string;
  stripeSubscriptionId?: string | null;
  productId?: string | null;
}): Promise<number> {
  if (input.stripeSubscriptionId) {
    const subscription = await prisma.subscription.findUnique({
      where: { stripeSubscriptionId: input.stripeSubscriptionId },
      select: { id: true, customerId: true },
    });
    if (subscription) {
      const where = await licensesForSubscription(subscription, 'ACTIVE');
      const result = await prisma.license.updateMany({ where, data: { status: 'REVOKED' } });
      return result.count;
    }
  }

  if (input.productId) {
    const result = await prisma.license.updateMany({
      where: { customerId: input.customerId, productId: input.productId, status: 'ACTIVE' },
      data: { status: 'REVOKED' },
    });
    return result.count;
  }

  const result = await prisma.license.updateMany({
    where: { customerId: input.customerId, status: 'ACTIVE' },
    data: { status: 'REVOKED' },
  });
  return result.count;
}
