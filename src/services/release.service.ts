/**
 * Release manifests — what a deployment downloads and how it knows the download is ours.
 *
 * A release row names a version of a product on a channel and the artefact in the bundle store
 * (an image tarball for AOS, a package for a desktop client). The manifest is the canonical
 * JSON of those fields, signed with the server's RSA key (the same key that signs offline
 * licences), and a deployment verifies it with the public key compiled into its build before it
 * trusts a download URL. The signature covers everything the deployment acts on: product,
 * channel, version, artefact key, size and SHA-256, image reference, minimum version and the
 * critical flag. Notes are outside it: they are shown, never acted on.
 *
 * A release made of several parts lists each component's artefacts under `components`
 * (component → platform → artefact), inside the signature like everything else; a release with
 * none has no `components` key at all, so its manifest is byte for byte what it always was.
 */
import crypto from 'crypto';
import fs from 'fs';
import type { Release, ReleaseArtifact } from '@prisma/client';
import { config } from '../config/index.js';
import { logger } from './logger.service.js';

export interface ReleaseManifest {
  product: string;
  channel: string;
  version: string;
  releaseDate: string;
  artifact: { key: string; size: number; sha256: string } | null;
  imageRef: string | null;
  minVersion: string | null;
  critical: boolean;
  /** Present only on a release with component artefacts: component → platform → artefact. */
  components?: Record<string, Record<string, ComponentArtifact>>;
}

export interface ComponentArtifact {
  key: string;
  size: number;
  sha256: string;
  imageRef: string | null;
  version: string | null;
}

/** The artefact rows a manifest is built from (the fields that matter, so tests can pass plain objects). */
export type ArtifactRow = Pick<ReleaseArtifact, 'component' | 'platform' | 'key' | 'size' | 'sha256' | 'imageRef' | 'componentVersion'>;

export const COMPONENT_RE = /^[a-z][a-z0-9-]{1,30}$/;
export const PLATFORM_RE = /^(any|[a-z0-9]+-[a-z0-9]+)$/;

/**
 * The licence module a component belongs to. A licence that leaves the module out cannot fetch
 * the component; a component not listed here (the installer, the updater) needs only a licence
 * for the product. CloudCode's binaries and the VS Code extension are clients: CloudCode's own
 * module, and AOS's for the extension, which talks to nothing else.
 */
export const COMPONENT_MODULE: Record<string, string> = {
  aos: 'aos',
  vscode: 'aos',
  codeeasy: 'codeeasy',
  cloudcode: 'cloudcode',
  'models-runtime': 'models-host',
};

/** Whether a licence whose effective modules are `modules` may fetch `component`. An empty list is a legacy licence: everything. */
export function componentAllowed(component: string, modules: string[]): boolean {
  const needs = COMPONENT_MODULE[component];
  if (!needs || modules.length === 0) return true;
  return modules.includes(needs);
}

export interface SignedManifest {
  manifest: ReleaseManifest;
  /** Base64 RSA-SHA256 over `canonical(manifest)`. */
  signature: string;
  releaseNotes: string | null;
}

let privateKey: string | null = null;
try {
  if (config.LICENSE_PRIVATE_KEY_PATH) privateKey = fs.readFileSync(config.LICENSE_PRIVATE_KEY_PATH, 'utf8');
} catch (error) {
  logger.warn('Could not load the private key for release signing', { error: String(error) });
}

/** For tests: use a key pair of the test's own making. */
export function setSigningKeyForTests(pem: string | null): void {
  privateKey = pem;
}

export function manifestOf(release: Pick<Release, 'productSlug' | 'channel' | 'version' | 'releaseDate' | 'artifactKey' | 'artifactSize' | 'artifactSha256' | 'imageRef' | 'minVersion' | 'isCritical'> & { artifacts?: ArtifactRow[] }): ReleaseManifest {
  const manifest: ReleaseManifest = {
    product: release.productSlug,
    channel: release.channel,
    version: release.version,
    releaseDate: release.releaseDate.toISOString().split('T')[0],
    artifact: release.artifactKey && release.artifactSha256 ? { key: release.artifactKey, size: Number(release.artifactSize ?? 0), sha256: release.artifactSha256 } : null,
    imageRef: release.imageRef ?? null,
    minVersion: release.minVersion || null,
    critical: release.isCritical,
  };
  if (release.artifacts && release.artifacts.length > 0) {
    const components: Record<string, Record<string, ComponentArtifact>> = {};
    for (const a of release.artifacts) {
      (components[a.component] ??= {})[a.platform] = { key: a.key, size: Number(a.size), sha256: a.sha256, imageRef: a.imageRef ?? null, version: a.componentVersion ?? null };
    }
    manifest.components = components;
  }
  return manifest;
}

/** A component's artefact for a platform: the exact platform first, then "any". */
export function pickArtifact(manifest: ReleaseManifest, component: string, platform: string): ComponentArtifact | null {
  const byPlatform = manifest.components?.[component];
  if (!byPlatform) return null;
  return byPlatform[platform] ?? byPlatform['any'] ?? null;
}

/** JSON with keys in a fixed order at every level, so signer and verifier see the same bytes. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function signManifest(manifest: ReleaseManifest): string | null {
  if (!privateKey) return null;
  return crypto.sign('sha256', Buffer.from(canonical(manifest)), privateKey).toString('base64');
}

export function verifyManifest(manifest: ReleaseManifest, signature: string, publicKeyPem: string): boolean {
  try {
    return crypto.verify('sha256', Buffer.from(canonical(manifest)), publicKeyPem, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** The manifest a deployment is given: signed, or refused when the server cannot sign. */
export function signedManifestOf(release: Release & { artifacts?: ArtifactRow[] }): SignedManifest | null {
  const manifest = manifestOf(release);
  const signature = release.signature ?? signManifest(manifest);
  if (!signature) return null;
  return { manifest, signature, releaseNotes: release.releaseNotes };
}

/** Compare semantic versions: 1 when a > b, -1 when a < b, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map(Number);
  const pa = norm(a), pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}
