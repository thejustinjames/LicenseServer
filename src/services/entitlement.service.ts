// Tenant entitlement service.
//
// A "tenant entitlement" is what we hand to a customer's Cortex deployment
// so it can run its own enrollment / approval flow against a fixed seat
// quota. The quota is composed of seat packs (size 5 or 10) granted to the
// customer's License. We sign the composition into a JWT that Cortex
// fetches daily and verifies against our shared secret (HS256 in preprod;
// asymmetric RS256 is a GA hardening item).

import jwt from 'jsonwebtoken';
import { prisma } from '../config/database.js';
import { logger } from './logger.service.js';

const ALLOWED_PACK_SIZES = [5, 10] as const;
export type PackSize = typeof ALLOWED_PACK_SIZES[number];

export interface EntitlementClaims {
  iss: string;             // 'licensing.agencio.cloud'
  sub: string;             // 'license:<licenseId>'
  iat: number;
  exp: number;             // refresh window (24h); not the entitlement validUntil
  tenant: {
    id: string;            // = License.id
    license_key: string;   // = License.key (for Cortex → LS auth on signing requests)
    customer_id: string;
    seat_quota: number;    // derived: 5*p5 + 10*p10
    packs_of_5: number;
    packs_of_10: number;
    valid_until: string;   // ISO8601; License.expiresAt
    license_type: string;
    license_status: string;
  };
}

export interface GrantPackInput {
  licenseId: string;
  packSize: PackSize;
  grantedBy?: string;
  purchaseOrderRef?: string;
  expiresAt?: Date;
  notes?: string;
}

export interface SeatTotal {
  licenseId: string;
  seatQuota: number;
  packsOf5: number;
  packsOf10: number;
}

/**
 * Grant a single seat pack to a license.
 * Rejects pack sizes other than 5 or 10. Returns the new totals.
 */
export async function grantPack(input: GrantPackInput): Promise<SeatTotal> {
  if (!ALLOWED_PACK_SIZES.includes(input.packSize)) {
    throw new Error(
      `pack_size must be one of ${ALLOWED_PACK_SIZES.join(', ')} (got ${input.packSize})`,
    );
  }

  return prisma.$transaction(async (tx) => {
    const license = await tx.license.findUnique({ where: { id: input.licenseId } });
    if (!license) {
      throw new Error(`license not found: ${input.licenseId}`);
    }

    await tx.licenseSeatPack.create({
      data: {
        licenseId: input.licenseId,
        packSize: input.packSize,
        grantedBy: input.grantedBy ?? null,
        purchaseOrderRef: input.purchaseOrderRef ?? null,
        expiresAt: input.expiresAt ?? null,
        notes: input.notes ?? null,
      },
    });

    const totals = await computeSeatTotalTx(tx, input.licenseId);

    // Keep License.seatCount in sync so downstream code that reads the
    // simple integer (existing seat assignment flow) keeps working.
    await tx.license.update({
      where: { id: input.licenseId },
      data: { seatCount: totals.seatQuota },
    });

    logger.info('granted seat pack', {
      licenseId: input.licenseId,
      packSize: input.packSize,
      seatQuota: totals.seatQuota,
      grantedBy: input.grantedBy,
    });

    return totals;
  });
}

/**
 * Revoke a previously granted pack (e.g. on refund).
 * Decrements License.seatCount.
 */
export async function revokePack(packId: string, reason?: string): Promise<SeatTotal> {
  return prisma.$transaction(async (tx) => {
    const pack = await tx.licenseSeatPack.findUnique({ where: { id: packId } });
    if (!pack) throw new Error(`pack not found: ${packId}`);
    if (pack.revokedAt) {
      // idempotent
      return computeSeatTotalTx(tx, pack.licenseId);
    }
    await tx.licenseSeatPack.update({
      where: { id: packId },
      data: { revokedAt: new Date(), revokedReason: reason ?? null },
    });
    const totals = await computeSeatTotalTx(tx, pack.licenseId);
    await tx.license.update({
      where: { id: pack.licenseId },
      data: { seatCount: totals.seatQuota },
    });
    logger.info('revoked seat pack', { packId, licenseId: pack.licenseId, seatQuota: totals.seatQuota });
    return totals;
  });
}

/**
 * Compute current pack composition for a license. Excludes revoked and
 * expired packs.
 */
export async function computeSeatTotal(licenseId: string): Promise<SeatTotal> {
  return computeSeatTotalTx(prisma, licenseId);
}

async function computeSeatTotalTx(
  tx: typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  licenseId: string,
): Promise<SeatTotal> {
  const now = new Date();
  const packs = await (tx as typeof prisma).licenseSeatPack.findMany({
    where: {
      licenseId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { packSize: true },
  });

  const packsOf5 = packs.filter((p) => p.packSize === 5).length;
  const packsOf10 = packs.filter((p) => p.packSize === 10).length;
  const seatQuota = 5 * packsOf5 + 10 * packsOf10;

  return { licenseId, seatQuota, packsOf5, packsOf10 };
}

/**
 * Mint a signed JWT that the customer's Cortex fetches and verifies daily.
 * Refresh window is 24h (clock skew tolerant); the entitlement's actual
 * validity is `License.expiresAt`, carried as the `valid_until` claim.
 */
export async function mintEntitlementJwt(licenseId: string): Promise<string> {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET not set — cannot mint entitlement');
  }

  const license = await prisma.license.findUnique({ where: { id: licenseId } });
  if (!license) throw new Error(`license not found: ${licenseId}`);

  const totals = await computeSeatTotal(licenseId);
  const issuer = process.env.LICENSE_SERVER_ISSUER ?? 'licensing.agencio.cloud';
  const now = Math.floor(Date.now() / 1000);

  const claims: EntitlementClaims = {
    iss: issuer,
    sub: `license:${licenseId}`,
    iat: now,
    exp: now + 24 * 3600,
    tenant: {
      id: license.id,
      license_key: license.key,
      customer_id: license.customerId,
      seat_quota: totals.seatQuota,
      packs_of_5: totals.packsOf5,
      packs_of_10: totals.packsOf10,
      valid_until: license.expiresAt
        ? license.expiresAt.toISOString()
        : new Date(now * 1000 + 365 * 24 * 3600 * 1000).toISOString(),
      license_type: license.licenseType,
      license_status: license.status,
    },
  };

  return jwt.sign(claims, secret, { algorithm: 'HS256' });
}

/**
 * Verify an entitlement JWT — used by Cortex but exposed here for tests.
 */
export function verifyEntitlementJwt(token: string): EntitlementClaims {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not set');
  return jwt.verify(token, secret, { algorithms: ['HS256'] }) as EntitlementClaims;
}
