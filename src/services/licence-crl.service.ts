/**
 * The licence revocation list.
 *
 * A companion to `crl.service.ts`, which publishes an X.509 CRL for agent
 * *certificates*. This publishes the licences that are no longer good, and it
 * is a different kind of object: a licence is not a certificate, so there is
 * nothing to sign in the X.509 sense and the list is JSON.
 *
 * ## What it carries, and what it deliberately does not
 *
 * Keys are listed by the **SHA-256 of the key**, never the key itself. Every
 * Cortex in the estate fetches this, so publishing the actual keys would hand
 * each of them every other customer's licence.
 *
 * ## Why it is not signed
 *
 * Because it is not the authority, and making it one would be a mistake.
 *
 * A Cortex that finds its own fingerprint here does not act on that. It calls
 * `POST /api/v1/validate`, which is authenticated by the key itself and
 * carries the server's own reason, and *that* is what changes its standing.
 * The list only says "worth asking now".
 *
 * That keeps the worst case of a forged or tampered list at one extra
 * validate call rather than a revocation, which is what a signature would
 * otherwise be protecting against. Signing it would become necessary the day
 * something is allowed to act on the list alone.
 */

import { prisma } from '../config/database.js';
import { createHash } from 'node:crypto';

/** How long a fetched list may be treated as current. */
const MAX_AGE_SECONDS = 300;

export interface RevokedLicence {
  /** SHA-256 of the licence key, hex. Never the key. */
  fingerprint: string;
  /** REVOKED | SUSPENDED | EXPIRED */
  status: string;
  /** When the licence was last touched, which for a revoke is when it happened. */
  since: string;
}

export interface LicenceCrl {
  issued_at: string;
  next_update_at: string;
  /** Present so a reader can tell a truncated list from a short one. */
  count: number;
  revoked: RevokedLicence[];
}

export function fingerprint(licenceKey: string): string {
  return createHash('sha256').update(licenceKey.trim()).digest('hex');
}

export async function buildLicenceCrl(): Promise<LicenceCrl> {
  // SUSPENDED and EXPIRED are listed beside REVOKED because all three make
  // `validate` refuse, and the point of the list is to tell a Cortex that
  // asking again is worth its while. What each one *means* is the validate
  // call's answer, not this list's.
  const rows = await prisma.license.findMany({
    where: { status: { in: ['REVOKED', 'SUSPENDED', 'EXPIRED'] } },
    select: { key: true, status: true, updatedAt: true },
  });

  const now = new Date();
  return {
    issued_at: now.toISOString(),
    next_update_at: new Date(now.getTime() + MAX_AGE_SECONDS * 1000).toISOString(),
    count: rows.length,
    revoked: rows.map((r) => ({
      fingerprint: fingerprint(r.key),
      status: r.status,
      since: r.updatedAt.toISOString(),
    })),
  };
}

export const CRL_MAX_AGE_SECONDS = MAX_AGE_SECONDS;
