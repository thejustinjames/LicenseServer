// Licence add-ons.
//
// An add-on is a feature code bought on top of a licence rather than a
// product of its own. The only one is SILO's causal trust add-on, and the
// rules for it are the product decision written here:
//
// - Cortex only. A standalone (`scope-agent`, or a product with no scope)
//   never carries it.
// - Enterprise only. "Enterprise" is read from the `enterprise-plugins`
//   feature code, which Cortex Enterprise carries and Business does not,
//   never from the product name, which is text an operator can change.
// - Granted to the parent Cortex. A child Cortex licence (`scope-child-cortex`)
//   is covered by its parent's add-on through `parentLicenseId`, and an
//   add-on cannot be granted to it directly.

import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import { logger } from './logger.service.js';

/** Add-on codes this server can grant. Mirrors the CHECK in SQL. */
export const ADD_ON_CODES = ['causal_trust'] as const;
export type AddOnCode = typeof ADD_ON_CODES[number];

export const SCOPE_CORTEX = 'scope-cortex';
export const SCOPE_CHILD_CORTEX = 'scope-child-cortex';
export const ENTERPRISE_MARKER = 'enterprise-plugins';

export interface GrantAddOnInput {
  licenseId: string;
  code: string;
  grantedBy?: string;
  purchaseOrderRef?: string;
  expiresAt?: Date;
  notes?: string;
}

/** Why a product may not carry an add-on, or null when it may. */
export function addOnRefusal(features: string[] | null | undefined, code: string): string | null {
  if (!(ADD_ON_CODES as readonly string[]).includes(code)) {
    return `unknown add-on '${code}'`;
  }
  const f = features ?? [];
  if (f.includes(SCOPE_CHILD_CORTEX)) {
    return 'a child Cortex is covered by its parent’s add-on; grant it to the parent licence and link the child';
  }
  if (!f.includes(SCOPE_CORTEX)) {
    return 'the add-on is Cortex-only; this product licenses no Cortex';
  }
  if (!f.includes(ENTERPRISE_MARKER)) {
    return 'the add-on is offered on Enterprise only';
  }
  return null;
}

type AddOnRow = { code: string; revokedAt: Date | null; expiresAt: Date | null };

/** Codes of the rows that are in force at `now`. */
export function activeCodes(rows: AddOnRow[] | null | undefined, now: Date = new Date()): string[] {
  const codes = (rows ?? [])
    .filter((r) => r.revokedAt === null && (r.expiresAt === null || r.expiresAt > now))
    .map((r) => r.code);
  return Array.from(new Set(codes));
}

type LicenceForFeatures = {
  id: string;
  parentLicenseId?: string | null;
  product: { features: string[] };
};

/**
 * The feature codes a licence carries: its product's, its own active
 * add-ons, and for a child Cortex its parent's active add-ons while the
 * parent licence is itself active and in date.
 */
export async function effectiveFeatures(
  license: LicenceForFeatures,
  db: Prisma.TransactionClient | typeof prisma = prisma,
  now: Date = new Date(),
): Promise<string[]> {
  const base = license.product.features ?? [];
  const own = activeCodes(await db.licenseAddOn.findMany({ where: { licenseId: license.id } }), now);

  let inherited: string[] = [];
  if (base.includes(SCOPE_CHILD_CORTEX) && license.parentLicenseId) {
    const parent = await db.license.findUnique({
      where: { id: license.parentLicenseId },
      include: { addOns: true },
    });
    const parentInForce =
      parent &&
      parent.status === 'ACTIVE' &&
      (!parent.expiresAt || parent.expiresAt > now);
    if (parentInForce) {
      inherited = activeCodes(parent.addOns, now);
    }
  }

  return Array.from(new Set([...base, ...own, ...inherited]));
}

/** Grant an add-on, refusing a product that may not carry it. */
export async function grantAddOn(input: GrantAddOnInput) {
  const license = await prisma.license.findUnique({
    where: { id: input.licenseId },
    include: { product: { select: { features: true } }, addOns: true },
  });
  if (!license) {
    throw new Error(`license not found: ${input.licenseId}`);
  }
  const refusal = addOnRefusal(license.product.features, input.code);
  if (refusal) {
    throw new Error(refusal);
  }
  if (activeCodes(license.addOns).includes(input.code)) {
    throw new Error(`the licence already carries an active ${input.code} add-on`);
  }
  const row = await prisma.licenseAddOn.create({
    data: {
      licenseId: input.licenseId,
      code: input.code,
      grantedBy: input.grantedBy ?? null,
      purchaseOrderRef: input.purchaseOrderRef ?? null,
      expiresAt: input.expiresAt ?? null,
      notes: input.notes ?? null,
    },
  });
  logger.info('granted licence add-on', { licenseId: input.licenseId, code: input.code, grantedBy: input.grantedBy });
  return row;
}

/** Revoke an add-on. The row is kept as history. */
export async function revokeAddOn(addOnId: string, reason?: string) {
  const row = await prisma.licenseAddOn.findUnique({ where: { id: addOnId } });
  if (!row) {
    throw new Error(`add-on not found: ${addOnId}`);
  }
  if (row.revokedAt) {
    return row;
  }
  const updated = await prisma.licenseAddOn.update({
    where: { id: addOnId },
    data: { revokedAt: new Date(), revokedReason: reason ?? null },
  });
  logger.info('revoked licence add-on', { licenseId: row.licenseId, code: row.code, reason });
  return updated;
}

/**
 * Link a child Cortex licence to its parent, or unlink it with `null`.
 * The child must be child-scoped, the parent Cortex-scoped, and both held
 * by the same customer.
 */
export async function setParent(childId: string, parentId: string | null) {
  const child = await prisma.license.findUnique({
    where: { id: childId },
    include: { product: { select: { features: true } } },
  });
  if (!child) {
    throw new Error(`license not found: ${childId}`);
  }
  if (!child.product.features.includes(SCOPE_CHILD_CORTEX)) {
    throw new Error('only a child Cortex licence can be linked to a parent');
  }
  if (parentId !== null) {
    const parent = await prisma.license.findUnique({
      where: { id: parentId },
      include: { product: { select: { features: true } } },
    });
    if (!parent) {
      throw new Error(`parent license not found: ${parentId}`);
    }
    if (!parent.product.features.includes(SCOPE_CORTEX)) {
      throw new Error('the parent must be a Cortex licence (scope-cortex)');
    }
    if (parent.customerId !== child.customerId) {
      throw new Error('the parent and child licences belong to different customers');
    }
  }
  return prisma.license.update({ where: { id: childId }, data: { parentLicenseId: parentId } });
}
