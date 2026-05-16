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
