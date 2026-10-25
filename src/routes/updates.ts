/**
 * Updates API Routes
 * Provides version check and update notifications for K8 Inspector and other products
 *
 * Copyright (c) 2026 Agencio. All rights reserved.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { validationRateLimit } from '../middleware/rateLimit.js';
import { logger } from '../services/logger.service.js';
import crypto from 'crypto';
import { signedManifestOf, compareVersions as compareSemver, componentAllowed, pickArtifact, COMPONENT_RE, PLATFORM_RE } from '../services/release.service.js';
import { effectiveComponentsFor, getLicenseByKey } from '../services/license.service.js';
import { presignKey, keyFromDownloadToken, openObject } from '../services/storage.service.js';

const router = Router();

// Apply rate limiting (same as validation - 60 req/min per IP)
router.use(validationRateLimit);

// Schema for version check request
const versionCheckSchema = z.object({
  currentVersion: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/, 'Invalid version format'),
  licenseKey: z.string().optional(),
  deploymentMethod: z.enum(['docker', 'kubernetes', 'helm', 'standalone']).optional(),
  platform: z.string().optional(),
});

/**
 * Compare semver versions
 * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1: string, v2: string): number {
  const normalize = (v: string) => v.replace(/^v/, '').split('-')[0];
  const parts1 = normalize(v1).split('.').map(Number);
  const parts2 = normalize(v2).split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

/**
 * Get the active release for a product
 */
async function getActiveRelease(productSlug: string) {
  return prisma.release.findFirst({
    where: {
      productSlug,
      isActive: true,
    },
    orderBy: { releaseDate: 'desc' },
  });
}

/**
 * GET /api/updates/check
 * Quick version check - returns latest version info
 * Query param: product (default: k8inspector)
 */
router.get('/check', async (req: Request, res: Response) => {
  try {
    const productSlug = (req.query.product as string) || 'k8inspector';
    const release = await getActiveRelease(productSlug);

    if (!release) {
      res.json({
        latestVersion: null,
        releaseDate: null,
        downloadUrl: null,
        critical: false,
        message: 'No releases found for this product',
      });
      return;
    }

    res.json({
      latestVersion: release.version,
      releaseDate: release.releaseDate.toISOString().split('T')[0],
      downloadUrl: release.downloadUrl,
      critical: release.isCritical,
    });
  } catch (error) {
    logger.error('Version check error:', error);
    res.status(500).json({
      success: false,
      error: 'Version check failed',
    });
  }
});

/**
 * POST /api/updates/check
 * Full version check with comparison
 */
router.post('/check', async (req: Request, res: Response) => {
  try {
    const data = versionCheckSchema.parse(req.body);
    const { currentVersion, licenseKey, deploymentMethod, platform } = data;

    // Get product slug from query or default to k8inspector
    const productSlug = (req.query.product as string) || 'k8inspector';
    const release = await getActiveRelease(productSlug);

    if (!release) {
      res.json({
        success: true,
        currentVersion,
        latestVersion: currentVersion,
        updateAvailable: false,
        isOutdated: false,
        critical: false,
        message: 'No releases found for this product',
      });
      return;
    }

    const updateAvailable = compareVersions(release.version, currentVersion) > 0;
    const isOutdated = release.minVersion
      ? compareVersions(currentVersion, release.minVersion) < 0
      : false;

    // Log the check for analytics (no PII)
    logger.info('Version check', {
      productSlug,
      currentVersion,
      latestVersion: release.version,
      updateAvailable,
      deploymentMethod,
      platform,
      hasLicense: !!licenseKey,
    });

    res.json({
      success: true,
      currentVersion,
      latestVersion: release.version,
      updateAvailable,
      isOutdated,
      critical: release.isCritical,
      releaseDate: release.releaseDate.toISOString().split('T')[0],
      releaseNotes: updateAvailable ? release.releaseNotes : null,
      downloadUrl: release.downloadUrl,
      upgradeInstructions: updateAvailable ? getUpgradeInstructions(deploymentMethod, release.version) : null,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: 'Invalid request',
        details: error.errors,
      });
      return;
    }
    logger.error('Version check error:', error);
    res.status(500).json({
      success: false,
      error: 'Version check failed',
    });
  }
});

/**
 * GET /api/updates/latest
 * Get full release info
 * Query param: product (default: k8inspector)
 */
router.get('/latest', async (req: Request, res: Response) => {
  try {
    const productSlug = (req.query.product as string) || 'k8inspector';
    const release = await getActiveRelease(productSlug);

    if (!release) {
      res.status(404).json({
        error: 'No releases found for this product',
      });
      return;
    }

    res.json({
      version: release.version,
      releaseDate: release.releaseDate.toISOString().split('T')[0],
      releaseNotes: release.releaseNotes,
      downloadUrl: release.downloadUrl,
      critical: release.isCritical,
      minVersion: release.minVersion,
    });
  } catch (error) {
    logger.error('Get latest release error:', error);
    res.status(500).json({ error: 'Failed to get release info' });
  }
});

/**
 * GET /api/updates/changelog
 * Get release notes/changelog
 * Query param: product (default: k8inspector)
 */
router.get('/changelog', async (req: Request, res: Response) => {
  try {
    const productSlug = (req.query.product as string) || 'k8inspector';
    const release = await getActiveRelease(productSlug);

    if (!release) {
      res.status(404).json({
        error: 'No releases found for this product',
      });
      return;
    }

    res.json({
      version: release.version,
      releaseNotes: release.releaseNotes,
      releaseDate: release.releaseDate.toISOString().split('T')[0],
    });
  } catch (error) {
    logger.error('Get changelog error:', error);
    res.status(500).json({ error: 'Failed to get changelog' });
  }
});

/**
 * GET /api/updates/history
 * Get release history for a product
 * Query param: product (default: k8inspector), limit (default: 10)
 */
router.get('/history', async (req: Request, res: Response) => {
  try {
    const productSlug = (req.query.product as string) || 'k8inspector';
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

    const releases = await prisma.release.findMany({
      where: { productSlug },
      orderBy: { releaseDate: 'desc' },
      take: limit,
      select: {
        version: true,
        releaseDate: true,
        releaseNotes: true,
        isCritical: true,
        isActive: true,
      },
    });

    res.json({
      product: productSlug,
      releases: releases.map(r => ({
        version: r.version,
        releaseDate: r.releaseDate.toISOString().split('T')[0],
        releaseNotes: r.releaseNotes,
        critical: r.isCritical,
        current: r.isActive,
      })),
    });
  } catch (error) {
    logger.error('Get release history error:', error);
    res.status(500).json({ error: 'Failed to get release history' });
  }
});

/**
 * Get upgrade instructions based on deployment method
 */
/**
 * GET /api/updates/manifest?product=<slug>&channel=stable&currentVersion=1.2.3
 *
 * The active release on a channel as a SIGNED manifest: a deployment verifies the signature with
 * the public key compiled into its build before it believes the version, the artefact or the
 * image reference. `updateAvailable` compares against `currentVersion` when given.
 */
router.get('/manifest', async (req: Request, res: Response) => {
  try {
    const productSlug = String(req.query.product || '');
    const channel = String(req.query.channel || 'stable');
    const currentVersion = typeof req.query.currentVersion === 'string' ? req.query.currentVersion : null;
    if (!/^[a-z0-9-]{2,50}$/.test(productSlug)) { res.status(400).json({ error: 'product is required (a slug)' }); return; }
    if (!/^[a-z0-9-]{2,20}$/.test(channel)) { res.status(400).json({ error: 'channel must be a short slug' }); return; }
    const release = await prisma.release.findFirst({ where: { productSlug, channel, isActive: true }, orderBy: { releaseDate: 'desc' }, include: { artifacts: true } });
    if (!release) { res.json({ product: productSlug, channel, updateAvailable: false, manifest: null, signature: null, releaseNotes: null }); return; }
    const signed = signedManifestOf(release);
    if (!signed) { res.status(503).json({ error: 'The server cannot sign releases (no signing key)' }); return; }
    const updateAvailable = currentVersion ? compareSemver(release.version, currentVersion) > 0 : true;
    const outdated = currentVersion && release.minVersion ? compareSemver(currentVersion, release.minVersion) < 0 : false;
    res.json({ product: productSlug, channel, currentVersion, updateAvailable, outdated, ...signed });
  } catch (error) {
    logger.error('Manifest error:', error);
    res.status(500).json({ error: 'Manifest lookup failed' });
  }
});

/**
 * POST /api/updates/download
 *
 * A download URL for a release's artefact, for an ACTIVE deployment with a licence in force:
 * the body `{ deploymentId, product, version }` is signed with the deployment's secret in
 * `X-Deployment-Signature` (HMAC-SHA256 of the raw JSON, as the validate route). The URL is the
 * bundle store's signed URL, good for the configured hours; the manifest and its signature come
 * back with it so the caller checks the bytes it fetches against the manifest it verified.
 *
 * With `component` (and `platform`, default "any") the URL is for that component's artefact in
 * a release made of several parts, refused when the licence leaves out the component's module.
 */
router.post('/download', async (req: Request, res: Response) => {
  try {
    const b = (req.body || {}) as { deploymentId?: unknown; product?: unknown; version?: unknown; component?: unknown; platform?: unknown };
    const deploymentId = typeof b.deploymentId === 'string' ? b.deploymentId : '';
    const product = typeof b.product === 'string' ? b.product : '';
    const version = typeof b.version === 'string' ? b.version : '';
    if (!deploymentId || !product || !version) { res.status(400).json({ error: 'deploymentId, product and version are required' }); return; }
    const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { license: { include: { product: { select: { components: true } } } }, product: { select: { slug: true, components: true } } } });
    if (!deployment || !deployment.secret) { res.status(403).json({ error: 'Unknown deployment' }); return; }
    const signature = req.headers['x-deployment-signature'];
    const expected = Buffer.from(crypto.createHmac('sha256', deployment.secret).update(JSON.stringify(req.body || {})).digest('hex'));
    // Compare as bytes: timingSafeEqual throws on a length mismatch, and a string's length is
    // not its byte length once a header carries anything beyond ASCII.
    const presented = typeof signature === 'string' ? Buffer.from(signature) : Buffer.alloc(0);
    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
      logger.warn('Download refused: bad deployment signature', { deploymentId });
      res.status(401).json({ error: 'Invalid deployment signature' }); return;
    }
    if (deployment.status !== 'ACTIVE') { res.status(403).json({ error: `Deployment is ${deployment.status.toLowerCase()}` }); return; }
    if (deployment.license && (deployment.license.status !== 'ACTIVE' || (deployment.license.expiresAt && deployment.license.expiresAt < new Date()))) {
      res.status(403).json({ error: 'Licence is not in force' }); return;
    }
    // A deployment downloads its own product's artefacts and nothing else's.
    if (deployment.product?.slug !== product) {
      logger.warn('Download refused: deployment is not of that product', { deploymentId, product });
      res.status(403).json({ error: 'Deployment is not licensed for that product' }); return;
    }
    const component = typeof b.component === 'string' && b.component ? b.component : null;
    const platform = typeof b.platform === 'string' && b.platform ? b.platform : 'any';
    if (component && (!COMPONENT_RE.test(component) || !PLATFORM_RE.test(platform))) { res.status(400).json({ error: 'component or platform is malformed' }); return; }
    if (component) {
      const modules = deployment.license ? effectiveComponentsFor(deployment.license) : (deployment.product?.components ?? []);
      if (!componentAllowed(component, modules)) {
        logger.warn('Download refused: the licence leaves the component out', { deploymentId, component });
        res.status(403).json({ error: `The licence does not include ${component}` }); return;
      }
    }
    // Only an active release is served: a withdrawn one stays in the store but is not handed out.
    const release = await prisma.release.findFirst({ where: { productSlug: product, version, isActive: true }, include: { artifacts: true } });
    if (!release) { res.status(404).json({ error: 'No artefact for that release' }); return; }
    const signed = signedManifestOf(release);
    if (!signed) { res.status(503).json({ error: 'The server cannot sign releases (no signing key)' }); return; }
    const key = component ? pickArtifact(signed.manifest, component, platform)?.key : release.artifactKey;
    if (!key) { res.status(404).json({ error: component ? `No ${component} artefact for ${platform} in that release` : 'No artefact for that release' }); return; }
    const link = await presignKey(key);
    logger.info('Release download issued', { deploymentId, product, version, component, platform });
    res.json({ url: link.url, expiresAt: link.expiresAt.toISOString(), filename: link.filename, ...signed });
  } catch (error) {
    logger.error('Download error:', error);
    res.status(500).json({ error: 'Download failed' });
  }
});

/**
 * POST /api/updates/bootstrap
 *
 * A download URL for an installer that has not enrolled anything yet: the licence key itself is
 * the credential. Body `{ licenseKey, product, component, platform?, version?, channel? }`; the
 * licence must be in force, be for `product`, and include the component's module. Without
 * `version` the active release on the channel (default stable) is used. The signed manifest
 * comes back with the URL, so the installer verifies the bytes against it before it runs them.
 * Rate-limited with the rest of this router; a wrong key is answered as an unknown one.
 */
router.post('/bootstrap', async (req: Request, res: Response) => {
  try {
    const b = (req.body || {}) as Record<string, unknown>;
    const str = (x: unknown) => (typeof x === 'string' ? x : '');
    const licenseKey = str(b.licenseKey), product = str(b.product), component = str(b.component);
    const platform = str(b.platform) || 'any', version = str(b.version), channel = str(b.channel) || 'stable';
    if (!licenseKey || !product || !component) { res.status(400).json({ error: 'licenseKey, product and component are required' }); return; }
    if (!COMPONENT_RE.test(component) || !PLATFORM_RE.test(platform) || !/^[a-z0-9-]{2,20}$/.test(channel)) { res.status(400).json({ error: 'component, platform or channel is malformed' }); return; }
    const licence = await getLicenseByKey(licenseKey);
    if (!licence) { res.status(403).json({ error: 'Unknown licence key' }); return; }
    const withProduct = await prisma.license.findUnique({ where: { id: licence.id }, include: { product: { select: { slug: true, components: true } } } });
    if (!withProduct || withProduct.product.slug !== product) { res.status(403).json({ error: 'The licence is not for that product' }); return; }
    if (withProduct.status !== 'ACTIVE' || (withProduct.expiresAt && withProduct.expiresAt < new Date())) { res.status(403).json({ error: 'Licence is not in force' }); return; }
    if (!componentAllowed(component, effectiveComponentsFor(withProduct))) { res.status(403).json({ error: `The licence does not include ${component}` }); return; }
    const release = await prisma.release.findFirst({
      where: version ? { productSlug: product, version, isActive: true } : { productSlug: product, channel, isActive: true },
      orderBy: { releaseDate: 'desc' },
      include: { artifacts: true },
    });
    if (!release) { res.status(404).json({ error: 'No active release' }); return; }
    const signed = signedManifestOf(release);
    if (!signed) { res.status(503).json({ error: 'The server cannot sign releases (no signing key)' }); return; }
    const artefact = pickArtifact(signed.manifest, component, platform);
    if (!artefact) { res.status(404).json({ error: `No ${component} artefact for ${platform} in ${release.version}` }); return; }
    const link = await presignKey(artefact.key);
    logger.info('Bootstrap download issued', { licenceId: licence.id, product, version: release.version, component, platform });
    res.json({ url: link.url, expiresAt: link.expiresAt.toISOString(), filename: link.filename, version: release.version, ...signed });
  } catch (error) {
    logger.error('Bootstrap download error:', error);
    res.status(500).json({ error: 'Download failed' });
  }
});

/**
 * GET /api/updates/files/<token>
 *
 * A release file streamed from the bundle store, for a link this server signed (download and
 * bootstrap answer with one when the store is not reachable from outside). The token names the
 * object and an expiry; nothing else is served.
 */
router.get('/files/:token', async (req: Request, res: Response) => {
  req.setTimeout(60 * 60_000);
  res.setTimeout(60 * 60_000);
  const key = keyFromDownloadToken(req.params.token);
  if (!key || !key.startsWith('releases/')) { res.status(403).json({ error: 'The link is not valid or has expired' }); return; }
  try {
    const obj = await openObject(key);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${obj.filename.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'no-store');
    if (obj.size !== null) res.setHeader('Content-Length', String(obj.size));
    obj.body.on('error', (e) => { logger.error('Release file stream failed', { key, error: String(e) }); res.destroy(e as Error); });
    obj.body.pipe(res);
  } catch (error) {
    logger.error('Release file error:', error);
    if (!res.headersSent) res.status(404).json({ error: 'No such file' });
  }
});

function getUpgradeInstructions(deploymentMethod?: string, version?: string): object {
  const instructions: Record<string, object> = {
    docker: {
      title: 'Docker Upgrade',
      steps: [
        'Stop the current container: docker-compose down',
        'Pull the latest image: docker-compose pull',
        'Start with new image: docker-compose up -d',
        'Verify: docker-compose logs -f',
      ],
      command: 'docker-compose down && docker-compose pull && docker-compose up -d',
    },
    kubernetes: {
      title: 'Kubernetes Upgrade',
      steps: [
        'Update the image tag in your deployment manifest',
        'Apply the changes: kubectl apply -f k8inspector-deployment.yaml',
        'Monitor rollout: kubectl rollout status deployment/k8inspector',
      ],
      command: `kubectl set image deployment/k8inspector k8inspector=k8inspector:${version || 'latest'}`,
    },
    helm: {
      title: 'Helm Upgrade',
      steps: [
        'Update your values.yaml with the new image tag',
        'Run: helm upgrade k8inspector ./k8inspector-chart',
      ],
      command: `helm upgrade k8inspector ./k8inspector-chart --set image.tag=${version || 'latest'}`,
    },
    standalone: {
      title: 'Standalone Upgrade',
      steps: [
        'Download the latest release from agencio.app/downloads',
        'Stop K8 Inspector: ./stop.sh or Ctrl+C',
        'Extract new version over existing installation',
        'Preserve your backend/.env file',
        'Start: ./start.sh',
      ],
    },
  };

  return instructions[deploymentMethod || 'standalone'] || instructions.standalone;
}

export default router;
