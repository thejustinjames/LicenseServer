/**
 * CRL service — builds X.509 v2 CRLs from the agent_certificates ledger.
 *
 * The CRL is signed by the same CA that issued each agent cert, so
 * Cortex (which trusts the CA) can verify the CRL signature out of the
 * box. Cortex polls a public endpoint on the license-server every few
 * minutes and reloads the CRL into its TLS verifier.
 *
 * Customer-deployable: behaviour matches every other mTLS feature here —
 * gated on MTLS_AGENT_CA_ENABLED, sources the CA from the same Secrets
 * Manager bundle, no Agencio specifics.
 */

import forge from 'node-forge';
import { prisma } from '../config/database.js';
import { ensureCA, isMtlsCaEnabled } from './ca.service.js';
import { logger } from './logger.service.js';

export interface CrlBundle {
  /** PEM-encoded CRL (preferred for ops). */
  crlPem: string;
  /** Last update timestamp baked into the CRL. */
  lastUpdate: Date;
  /** Next update — clients must re-fetch by this point. */
  nextUpdate: Date;
  /** Number of revoked entries in this CRL. */
  revokedCount: number;
}

/** Build a fresh CRL covering all currently-revoked agent certificates. */
export async function buildCRL(opts?: {
  /** How long the CRL is "good for" before clients must re-fetch (default 30 min). */
  validitySeconds?: number;
}): Promise<CrlBundle> {
  if (!isMtlsCaEnabled()) {
    throw new Error('mTLS agent CA is disabled — CRL endpoint is not available');
  }
  const ca = await ensureCA();
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);

  const validitySeconds = Math.max(60, opts?.validitySeconds ?? 30 * 60);

  const revoked = await prisma.agentCertificate.findMany({
    where: { revokedAt: { not: null } },
    select: { serial: true, revokedAt: true, revokedReason: true, notAfter: true },
    orderBy: { revokedAt: 'asc' },
  });

  // Drop entries already past notAfter — RFC 5280 lets us, and it keeps
  // the CRL bounded as the revocation history grows.
  const now = new Date();
  const fresh = revoked.filter((r) => r.notAfter > now);

  const lastUpdate = now;
  const nextUpdate = new Date(now.getTime() + validitySeconds * 1000);

  // node-forge does not expose CRL building. Build the ASN.1 by hand using
  // its low-level primitives. Structure is RFC 5280 §5.1 TBSCertList.
  const tbs = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    // version v2 (1)
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false,
      forge.asn1.integerToDer(1).getBytes()),
    // signature AlgorithmIdentifier sha256WithRSAEncryption
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false,
        forge.asn1.oidToDer(forge.pki.oids.sha256WithRSAEncryption).getBytes()),
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, ''),
    ]),
    // issuer Name — copy from CA cert
    forge.pki.distinguishedNameToAsn1(caCert.subject as forge.pki.Certificate['subject']),
    // thisUpdate UTCTime
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.UTCTIME, false,
      forge.asn1.dateToUtcTime(lastUpdate)),
    // nextUpdate UTCTime
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.UTCTIME, false,
      forge.asn1.dateToUtcTime(nextUpdate)),
    // revokedCertificates SEQUENCE OF SEQUENCE { serialNumber, revocationDate }
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true,
      fresh.map((r) =>
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
          forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false,
            forge.util.hexToBytes(stripLeadingZero(r.serial))),
          forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.UTCTIME, false,
            forge.asn1.dateToUtcTime(r.revokedAt!)),
        ]),
      ),
    ),
  ]);

  // Sign tbs with the CA private key.
  const tbsDer = forge.asn1.toDer(tbs).getBytes();
  const md = forge.md.sha256.create();
  md.update(tbsDer);
  const sigBytes = caKey.sign(md);

  const crlAsn1 = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    tbs,
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false,
        forge.asn1.oidToDer(forge.pki.oids.sha256WithRSAEncryption).getBytes()),
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, ''),
    ]),
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.BITSTRING, false,
      String.fromCharCode(0) + sigBytes),
  ]);

  const crlDer = forge.asn1.toDer(crlAsn1).getBytes();
  const crlPem =
    '-----BEGIN X509 CRL-----\n' +
    chunk(forge.util.encode64(crlDer), 64).join('\n') +
    '\n-----END X509 CRL-----\n';

  logger.info('Built CRL', { revokedCount: fresh.length, nextUpdate: nextUpdate.toISOString() });
  return { crlPem, lastUpdate, nextUpdate, revokedCount: fresh.length };
}

function stripLeadingZero(hex: string): string {
  // forge's INTEGER encoder can't take an extra leading zero byte; serial
  // numbers we write are 16 bytes, but if hex starts with '00' the integer
  // encoder will error.  Strip it; positive serials encoded this way are fine.
  return hex.startsWith('00') && hex.length > 2 ? hex.slice(2) : hex;
}

function chunk(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

/** Mark an issued cert as revoked; next CRL build will include it. */
export async function revokeAgentCertificate(
  serial: string,
  reason?: string,
): Promise<{ serial: string; revokedAt: Date }> {
  const updated = await prisma.agentCertificate.update({
    where: { serial },
    data: { revokedAt: new Date(), revokedReason: reason ?? null },
  });
  logger.warn('Agent cert revoked', { serial, reason });
  return { serial: updated.serial, revokedAt: updated.revokedAt! };
}
