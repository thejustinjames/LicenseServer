#!/usr/bin/env node
/**
 * Issue a server certificate for the SILO Cortex mTLS agent listener,
 * signed by the CA stored in AWS Secrets Manager (MTLS_CA_SECRET_NAME).
 *
 * Output: a Kubernetes Secret manifest (YAML) on stdout containing
 *   data:
 *     server.crt: <base64 PEM>
 *     server.key: <base64 PEM>
 *     ca.crt:     <base64 PEM>
 *
 * The operator pipes this to `kubectl apply -f -` to populate the
 * Secret silo-cortex-mtls that the cortex Deployment mounts at
 * /etc/silo/mtls/.
 *
 * Customer-deployable: knows nothing about Agencio specifics. All inputs
 * come from env or CLI flags so customers can run this in their own AWS
 * (or any environment with awscli + node 20) against their own CA secret.
 *
 * Usage:
 *   MTLS_CA_SECRET_NAME=preprod/silo-license-ca \
 *   AWS_REGION=ap-southeast-1 \
 *   CORTEX_HOSTNAMES=agents.preprod.silo-dev.com,silo-cortex.preprod.svc.cluster.local \
 *   CORTEX_VALIDITY_DAYS=365 \
 *   K8S_SECRET_NAME=silo-cortex-mtls \
 *   K8S_NAMESPACE=preprod \
 *     node scripts/issue-cortex-mtls.mjs > cortex-mtls.yaml
 *   kubectl apply -f cortex-mtls.yaml
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import forge from 'node-forge';

const env = process.env;
const SECRET_NAME = env.MTLS_CA_SECRET_NAME ?? 'preprod/silo-license-ca';
const REGION = env.AWS_REGION ?? env.MTLS_CA_REGION ?? 'ap-southeast-1';
const HOSTNAMES = (env.CORTEX_HOSTNAMES ?? 'agents.preprod.silo-dev.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const VALIDITY_DAYS = parseInt(env.CORTEX_VALIDITY_DAYS ?? '365', 10);
const K8S_SECRET = env.K8S_SECRET_NAME ?? 'silo-cortex-mtls';
const K8S_NS = env.K8S_NAMESPACE ?? 'preprod';

if (HOSTNAMES.length === 0) {
  console.error('CORTEX_HOSTNAMES must list at least one DNS name');
  process.exit(1);
}

async function main() {
  const sm = new SecretsManagerClient({ region: REGION });
  const out = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
  if (!out.SecretString) {
    throw new Error(`Secret ${SECRET_NAME} has no SecretString`);
  }
  const ca = JSON.parse(out.SecretString);
  if (!ca.certPem || !ca.keyPem) {
    throw new Error(
      `Secret ${SECRET_NAME} is not a populated CA bundle. ` +
        `Did the license-server bootstrap run with MTLS_AGENT_CA_ENABLED=true?`,
    );
  }

  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);

  const keys = forge.pki.rsa.generateKeyPair({ bits: 4096, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber =
    '01' + forge.util.bytesToHex(forge.random.getBytesSync(15));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(
    cert.validity.notBefore.getTime() + VALIDITY_DAYS * 24 * 60 * 60 * 1000,
  );

  cert.setSubject([{ name: 'commonName', value: HOSTNAMES[0] }]);
  cert.setIssuer(caCert.subject.attributes);

  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    {
      name: 'keyUsage',
      critical: true,
      digitalSignature: true,
      keyEncipherment: true,
    },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectKeyIdentifier' },
    {
      name: 'authorityKeyIdentifier',
      keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes(),
    },
    {
      name: 'subjectAltName',
      altNames: HOSTNAMES.map((h) => ({ type: 2, value: h })),
    },
  ]);

  cert.sign(caKey, forge.md.sha256.create());

  const serverCertPem = forge.pki.certificateToPem(cert);
  const serverKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const caCertPem = ca.certPem;

  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

  const yaml = [
    `apiVersion: v1`,
    `kind: Secret`,
    `metadata:`,
    `  name: ${K8S_SECRET}`,
    `  namespace: ${K8S_NS}`,
    `  labels:`,
    `    app: silo-cortex`,
    `    issued-by: license-server`,
    `  annotations:`,
    `    silo.io/ca-secret: "${SECRET_NAME}"`,
    `    silo.io/issued-at: "${new Date().toISOString()}"`,
    `    silo.io/valid-until: "${cert.validity.notAfter.toISOString()}"`,
    `    silo.io/sans: "${HOSTNAMES.join(',')}"`,
    `type: Opaque`,
    `data:`,
    `  server.crt: ${b64(serverCertPem)}`,
    `  server.key: ${b64(serverKeyPem)}`,
    `  ca.crt: ${b64(caCertPem)}`,
    ``,
  ].join('\n');

  process.stdout.write(yaml);
  console.error(
    `Issued cortex server cert: serial=${cert.serialNumber} ` +
      `SANs=[${HOSTNAMES.join(',')}] ` +
      `valid_until=${cert.validity.notAfter.toISOString()}`,
  );
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
