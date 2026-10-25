import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';

import { canonical, compareVersions, manifestOf, setSigningKeyForTests, signManifest, verifyManifest, signedManifestOf, pickArtifact, componentAllowed } from '../../src/services/release.service.js';

/**
 * A release manifest is what a deployment acts on, so its signature must cover every field that
 * matters, survive key order, and fail on any change.
 */
let publicPem = '';
let otherPublicPem = '';

beforeAll(() => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  setSigningKeyForTests(privateKey.export({ type: 'pkcs1', format: 'pem' }).toString());
  publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  otherPublicPem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
});

const release = {
  productSlug: 'agencie-lab', channel: 'stable', version: '1.2.3', releaseDate: new Date('2026-10-24T10:00:00Z'),
  artifactKey: 'releases/agencie-lab/aos-colony-1.2.3.tar', artifactSize: 300_000_000, artifactSha256: 'ab'.repeat(32),
  imageRef: 'aos-colony:1.2.3', minVersion: '1.1.0', isCritical: false,
};

describe('release manifests', () => {
  it('canonical JSON orders keys at every level', () => {
    expect(canonical({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('a manifest carries what the deployment acts on, and the date as a day', () => {
    const m = manifestOf(release);
    expect(m).toEqual({ product: 'agencie-lab', channel: 'stable', version: '1.2.3', releaseDate: '2026-10-24', artifact: { key: release.artifactKey, size: 300_000_000, sha256: 'ab'.repeat(32) }, imageRef: 'aos-colony:1.2.3', minVersion: '1.1.0', critical: false });
    expect(manifestOf({ ...release, artifactKey: null, artifactSha256: null, minVersion: '' }).artifact).toBeNull();
    expect(manifestOf({ ...release, minVersion: '' }).minVersion).toBeNull();
  });

  it('signs with the server key and verifies with its public key only; any change breaks it', () => {
    const m = manifestOf(release);
    const sig = signManifest(m)!;
    expect(sig).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(verifyManifest(m, sig, publicPem)).toBe(true);
    expect(verifyManifest(m, sig, otherPublicPem)).toBe(false);
    expect(verifyManifest({ ...m, version: '1.2.4' }, sig, publicPem)).toBe(false);
    expect(verifyManifest({ ...m, artifact: { ...m.artifact!, sha256: 'cd'.repeat(32) } }, sig, publicPem)).toBe(false);
    expect(verifyManifest(m, 'not-base64-signature', publicPem)).toBe(false);
    // Key order does not matter to the verifier.
    const reordered = { critical: m.critical, minVersion: m.minVersion, imageRef: m.imageRef, artifact: { sha256: m.artifact!.sha256, size: m.artifact!.size, key: m.artifact!.key }, releaseDate: m.releaseDate, version: m.version, channel: m.channel, product: m.product };
    expect(verifyManifest(reordered as any, sig, publicPem)).toBe(true);
  });

  it('a stored signature is used as is; a row without one is signed now; no key means no manifest', () => {
    const stored = { ...release, id: 'r1', releaseNotes: 'notes', downloadUrl: null, isActive: true, createdBy: null, createdAt: new Date(), updatedAt: new Date(), signature: 'stored' };
    expect(signedManifestOf(stored as any)!.signature).toBe('stored');
    const fresh = signedManifestOf({ ...stored, signature: null } as any)!;
    expect(verifyManifest(fresh.manifest, fresh.signature, publicPem)).toBe(true);
    expect(fresh.releaseNotes).toBe('notes');
    setSigningKeyForTests(null);
    expect(signedManifestOf({ ...stored, signature: null } as any)).toBeNull();
  });

  it('compares versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('v1.1.106', '1.1.106')).toBe(0);
    expect(compareVersions('1.1.105-beta', '1.1.106')).toBe(-1);
  });
});

describe('releases made of several parts', () => {
  const artifacts = [
    { component: 'aos', platform: 'any', key: 'releases/agencie-lab/1.2.3/aos-any-aos.tar.gz', size: BigInt(90_000_000), sha256: 'aa'.repeat(32), imageRef: 'agencie/aos:1.2.3', componentVersion: '1.2.3' },
    { component: 'cloudcode', platform: 'linux-x64', key: 'releases/agencie-lab/1.2.3/cloudcode-linux-x64-cloudcode', size: BigInt(70_000_000), sha256: 'bb'.repeat(32), imageRef: null, componentVersion: '1.4.24' },
    { component: 'cloudcode', platform: 'darwin-arm64', key: 'releases/agencie-lab/1.2.3/cloudcode-darwin-arm64-cloudcode', size: BigInt(68_000_000), sha256: 'cc'.repeat(32), imageRef: null, componentVersion: '1.4.24' },
  ];

  it('lists each component by platform, inside the signature; none means no components key at all', () => {
    const m = manifestOf({ ...release, artifacts });
    expect(m.components).toEqual({
      aos: { any: { key: artifacts[0].key, size: 90_000_000, sha256: 'aa'.repeat(32), imageRef: 'agencie/aos:1.2.3', version: '1.2.3' } },
      cloudcode: {
        'linux-x64': { key: artifacts[1].key, size: 70_000_000, sha256: 'bb'.repeat(32), imageRef: null, version: '1.4.24' },
        'darwin-arm64': { key: artifacts[2].key, size: 68_000_000, sha256: 'cc'.repeat(32), imageRef: null, version: '1.4.24' },
      },
    });
    expect('components' in manifestOf({ ...release, artifacts: [] })).toBe(false);
    expect(canonical(manifestOf({ ...release, artifacts: [] }))).toBe(canonical(manifestOf(release)));
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    setSigningKeyForTests(privateKey.export({ type: 'pkcs1', format: 'pem' }).toString());
    const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const sig = signManifest(m)!;
    expect(verifyManifest(m, sig, pub)).toBe(true);
    const tampered = JSON.parse(JSON.stringify(m));
    tampered.components.cloudcode['linux-x64'].sha256 = 'dd'.repeat(32);
    expect(verifyManifest(tampered, sig, pub)).toBe(false);
  });

  it('picks the exact platform, then "any", else nothing', () => {
    const m = manifestOf({ ...release, artifacts });
    expect(pickArtifact(m, 'cloudcode', 'darwin-arm64')!.sha256).toBe('cc'.repeat(32));
    expect(pickArtifact(m, 'aos', 'linux-x64')!.imageRef).toBe('agencie/aos:1.2.3');
    expect(pickArtifact(m, 'cloudcode', 'windows-x64')).toBeNull();
    expect(pickArtifact(m, 'vscode', 'any')).toBeNull();
    expect(pickArtifact(manifestOf(release), 'aos', 'any')).toBeNull();
  });

  it('a component needs its module; the installer and updater need only the product; a legacy licence has everything', () => {
    expect(componentAllowed('codeeasy', ['aos', 'codeeasy', 'cloudcode'])).toBe(true);
    expect(componentAllowed('codeeasy', ['aos', 'cloudcode'])).toBe(false);
    expect(componentAllowed('vscode', ['aos'])).toBe(true);
    expect(componentAllowed('cloudcode', ['aos'])).toBe(false);
    expect(componentAllowed('glue', ['aos'])).toBe(true);
    expect(componentAllowed('updater', ['models-host'])).toBe(true);
    expect(componentAllowed('models-runtime', ['models-host'])).toBe(true);
    expect(componentAllowed('models-runtime', ['aos'])).toBe(false);
    expect(componentAllowed('codeeasy', [])).toBe(true);
  });
});
