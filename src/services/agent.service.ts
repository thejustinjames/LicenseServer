/**
 * Agent enrollment service
 *
 * Signs CSRs presented by SILO sidecars after license validation, returning a
 * short-lived client certificate the agent uses for mTLS to the customer's
 * Cortex. Issuance ledger lives in the `agent_certificates` table for audit
 * and revocation.
 *
 * Gated on the same MTLS_AGENT_CA_ENABLED flag as ca.service.
 */

import forge from 'node-forge';
import crypto from 'node:crypto';
import { prisma } from '../config/database.js';
import { config } from '../config/index.js';
import { ensureCA, isMtlsCaEnabled } from './ca.service.js';
import { validateLicense } from './license.service.js';
import { logger } from './logger.service.js';

export interface EnrollInput {
  licenseKey: string;
  machineFingerprint: string;
  csrPem: string;
  /** Optional override; capped server-side by MTLS_AGENT_CERT_VALIDITY_DAYS. */
  requestedValidityDays?: number;
}

export interface EnrollResult {
  certPem: string;
  caChainPem: string;
  serial: string;
  notBefore: string;
  notAfter: string;
  fingerprintSha256: string;
}

export class EnrollmentError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = 'EnrollmentError';
  }
}

function sha256Hex(pem: string): string {
  // forge fingerprint of the DER bytes of the cert.
  const cert = forge.pki.certificateFromPem(pem);
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return crypto.createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex');
}

/** Sign a CSR with the bootstrapped CA. Throws EnrollmentError on bad input. */
async function signCsrWithCa(
  csrPem: string,
  machineFingerprint: string,
  validityDays: number,
): Promise<{
  cert: forge.pki.Certificate;
  caCertPem: string;
  serial: string;
  notBefore: Date;
  notAfter: Date;
}> {
  const ca = await ensureCA();

  let csr: forge.pki.CertificateSigningRequest;
  try {
    csr = forge.pki.certificationRequestFromPem(csrPem);
  } catch {
    throw new EnrollmentError(400, 'Invalid CSR (failed to parse PEM)');
  }
  if (!csr.verify()) {
    throw new EnrollmentError(400, 'CSR signature is invalid');
  }

  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);

  const cert = forge.pki.createCertificate();
  cert.publicKey = csr.publicKey!;
  // Random 16-byte positive serial; first byte forced positive per RFC 5280.
  const serialBytes = forge.random.getBytesSync(16);
  const serialHex =
    (serialBytes.charCodeAt(0) & 0x80 ? '00' : '') + forge.util.bytesToHex(serialBytes);
  cert.serialNumber = serialHex;

  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + validityDays * 24 * 60 * 60 * 1000);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  // Subject: take CN from CSR if present, otherwise force machineFingerprint.
  const csrSubject = csr.subject.attributes;
  const hasCN = csrSubject.some((a) => a.shortName === 'CN' || a.name === 'commonName');
  const subjectAttrs = hasCN
    ? csrSubject
    : [{ name: 'commonName', value: machineFingerprint }];
  cert.setSubject(subjectAttrs);
  cert.setIssuer(caCert.subject.attributes);

  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    {
      name: 'keyUsage',
      critical: true,
      digitalSignature: true,
      keyEncipherment: true,
    },
    { name: 'extKeyUsage', clientAuth: true },
    { name: 'subjectKeyIdentifier' },
    {
      name: 'authorityKeyIdentifier',
      keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes(),
    },
    {
      name: 'subjectAltName',
      altNames: [
        // URI form keeps the agent's machine fingerprint discoverable to Cortex.
        { type: 6, value: `urn:silo:agent:${machineFingerprint}` },
      ],
    },
  ]);

  cert.sign(caKey, forge.md.sha256.create());

  return { cert, caCertPem: ca.certPem, serial: serialHex, notBefore, notAfter };
}

export async function enrollAgent(input: EnrollInput): Promise<EnrollResult> {
  if (!isMtlsCaEnabled()) {
    throw new EnrollmentError(503, 'mTLS agent enrollment is disabled on this deployment');
  }

  const { licenseKey, machineFingerprint, csrPem } = input;

  // 1. License must validate (and seat-count check via existing logic).
  const validation = await validateLicense(licenseKey, machineFingerprint);
  if (!validation.valid) {
    throw new EnrollmentError(403, validation.error ?? 'License validation failed');
  }

  // 2. Cap validity at the server-configured ceiling.
  const ceiling = parseInt(config.MTLS_AGENT_CERT_VALIDITY_DAYS, 10);
  const validityDays = Math.max(
    1,
    Math.min(ceiling, input.requestedValidityDays ?? ceiling),
  );

  // 3. Sign.
  const { cert, caCertPem, serial, notBefore, notAfter } = await signCsrWithCa(
    csrPem,
    machineFingerprint,
    validityDays,
  );
  const certPem = forge.pki.certificateToPem(cert);
  const fingerprintSha256 = sha256Hex(certPem);

  // 4. Look up the license id for the ledger row.
  const license = await prisma.license.findUnique({ where: { key: licenseKey } });
  if (!license) {
    // validateLicense already covered this, but defend the FK.
    throw new EnrollmentError(403, 'License not found');
  }

  await prisma.agentCertificate.create({
    data: {
      licenseId: license.id,
      machineFingerprint,
      serial,
      subject: cert.subject.attributes
        .map((a) => `${a.shortName ?? a.name}=${a.value}`)
        .join(','),
      fingerprintSha256,
      notBefore,
      notAfter,
    },
  });

  logger.info('Agent enrolled', {
    licenseId: license.id,
    machineFingerprint,
    serial,
    notAfter: notAfter.toISOString(),
  });

  return {
    certPem,
    caChainPem: caCertPem,
    serial,
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    fingerprintSha256,
  };
}
