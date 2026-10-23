/**
 * Enrolling a deployment with a licence key.
 *
 * `POST /api/deployments/register` needs the admin key, which a customer must never hold. A
 * product that installs itself (the Agencie Lab's AOS on a Docker host, a models host on a DGX
 * Spark) enrols instead: it presents its licence key and a machine fingerprint, the licence is
 * validated and activated for that machine (the activation ceiling is the licence's
 * `maxActivations`, one per machine for the Lab products), and a deployment is created, bound
 * to the licence, its customer and its product, with a freshly minted secret. The secret is
 * returned once. The same machine enrolling again (a rebuilt host, a lost data volume) gets a
 * new secret and the old one is dead; a different machine presenting an id that is taken is
 * refused.
 */
import crypto from 'crypto';
import { prisma } from '../config/database.js';
import { logger } from './logger.service.js';
import * as licenseService from './license.service.js';
import { effectiveFeatures } from './addon.service.js';

export interface EnrolInput {
  licenseKey: string;
  deploymentId: string;
  machineHash: string;
  machineName?: string;
  version?: string;
  environment?: string;
  /** The component this deployment is (`aos`, `models-host`); checked against the licence. */
  component?: string;
  ipAddress?: string;
}

export type EnrolResult =
  | { ok: true; deployment: { id: string; secret: string }; product: string; slug: string | null; tier: string; components: string[]; features: string[]; expiresAt: string | null; graceDays: number; checkInDays: number; customer: string | null }
  | { ok: false; status: number; error: string };

const DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,99}$/;

export async function enrolDeployment(input: EnrolInput): Promise<EnrolResult> {
  if (!input.licenseKey || typeof input.licenseKey !== 'string') return { ok: false, status: 400, error: 'licenseKey is required' };
  if (!DEPLOYMENT_ID.test(input.deploymentId ?? '')) return { ok: false, status: 400, error: 'deploymentId must be 3 to 100 letters, digits, dots, hyphens or underscores' };
  if (!input.machineHash || typeof input.machineHash !== 'string' || input.machineHash.length < 16 || input.machineHash.length > 128) return { ok: false, status: 400, error: 'machineHash is required (16 to 128 characters)' };
  const environment = input.environment && /^[a-z]{3,20}$/.test(input.environment) ? input.environment : 'production';

  const validation = await licenseService.validateLicense(input.licenseKey, input.machineHash, input.component);
  if (!validation.valid) return { ok: false, status: 403, error: validation.error ?? 'Licence not valid' };

  const activation = await licenseService.activateLicense(input.licenseKey, input.machineHash, input.machineName, input.ipAddress);
  if (!activation.success) return { ok: false, status: 403, error: activation.error ?? 'Licence could not be activated' };

  const license = await prisma.license.findUnique({
    where: { key: input.licenseKey },
    include: { product: true, customer: { select: { id: true, email: true, name: true } } },
  });
  if (!license) return { ok: false, status: 403, error: 'Invalid license key' };

  const existing = await prisma.deployment.findUnique({ where: { id: input.deploymentId } });
  if (existing && (existing.licenseId !== license.id || (existing.machineHash && existing.machineHash !== input.machineHash))) {
    return { ok: false, status: 409, error: `Deployment id "${input.deploymentId}" belongs to another licence or machine` };
  }
  if (existing && (existing.status === 'REVOKED' || existing.status === 'KILL')) {
    return { ok: false, status: 403, error: `Deployment "${input.deploymentId}" is ${existing.status.toLowerCase()}` };
  }

  const secret = crypto.randomBytes(32).toString('hex');
  const metadata = {
    ...((existing?.metadata as object) ?? {}),
    component: input.component ?? null,
    enrolledAt: new Date().toISOString(),
    enrolledBy: 'licence-key',
    machineName: input.machineName ?? null,
    ip: input.ipAddress ?? null,
    ...(existing ? { reEnrolledAt: new Date().toISOString() } : {}),
  };
  await prisma.deployment.upsert({
    where: { id: input.deploymentId },
    create: {
      id: input.deploymentId,
      productId: license.productId,
      customerId: license.customerId,
      licenseId: license.id,
      environment,
      machineHash: input.machineHash,
      version: input.version ?? null,
      status: 'ACTIVE',
      secret,
      lastSeenAt: new Date(),
      metadata,
    },
    update: {
      secret,
      machineHash: input.machineHash,
      version: input.version ?? existing?.version ?? null,
      environment,
      status: 'ACTIVE',
      lastSeenAt: new Date(),
      metadata,
    },
  });
  logger.info(existing ? 'Deployment re-enrolled with a licence key' : 'Deployment enrolled with a licence key', { deploymentId: input.deploymentId, licenseId: license.id, component: input.component });

  const components = licenseService.effectiveComponentsFor(license);
  const features = await effectiveFeatures(license);
  return {
    ok: true,
    deployment: { id: input.deploymentId, secret },
    product: license.product.name,
    slug: license.product.slug ?? null,
    tier: license.licenseType,
    components,
    features,
    expiresAt: license.expiresAt ? license.expiresAt.toISOString() : null,
    graceDays: licenseService.offlineGraceDaysFor(license.product),
    checkInDays: license.product.checkInIntervalDays,
    customer: license.customer?.name ?? license.customer?.email ?? null,
  };
}

/** The entitlement a validated deployment carries: components and features of its licence now. */
export async function entitlementOf(deployment: { licenseId: string | null }): Promise<{ components: string[]; features: string[] } | null> {
  if (!deployment.licenseId) return null;
  const license = await prisma.license.findUnique({ where: { id: deployment.licenseId }, include: { product: { select: { id: true, name: true, features: true, components: true } } } });
  if (!license) return null;
  return { components: licenseService.effectiveComponentsFor(license), features: await effectiveFeatures(license) };
}
