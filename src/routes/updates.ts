/**
 * Updates API Routes
 * Provides version check and update notifications for K8 Inspector
 *
 * Copyright (c) 2026 Agencio. All rights reserved.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validationRateLimit } from '../middleware/rateLimit.js';
import { logger } from '../services/logger.service.js';

const router = Router();

// Apply rate limiting (same as validation - 60 req/min per IP)
router.use(validationRateLimit);

// Current K8 Inspector version info - UPDATE THIS WHEN RELEASING NEW VERSIONS
const CURRENT_RELEASE = {
  version: '2.0.1',
  releaseDate: '2026-05-16',
  releaseNotes: `## K8 Inspector v2.0.1

### Bug Fixes
- Fixed license validation for LemonSqueezy integration
- Fixed cluster connection when running inside Kubernetes (in-cluster ServiceAccount fallback)
- Fixed region display in Setup Wizard review step

### Improvements
- Improved in-cluster authentication detection
- Better error messages for cluster connection failures
- Updated documentation for deployment scenarios
`,
  downloadUrl: 'https://agencio.app/downloads',
  minVersion: '1.0.0', // Minimum supported version for upgrades
  critical: false, // Set to true for security updates
};

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
 * GET /api/updates/check
 * Quick version check - returns latest version info
 */
router.get('/check', (_req: Request, res: Response) => {
  res.json({
    latestVersion: CURRENT_RELEASE.version,
    releaseDate: CURRENT_RELEASE.releaseDate,
    downloadUrl: CURRENT_RELEASE.downloadUrl,
    critical: CURRENT_RELEASE.critical,
  });
});

/**
 * POST /api/updates/check
 * Full version check with comparison
 */
router.post('/check', async (req: Request, res: Response) => {
  try {
    const data = versionCheckSchema.parse(req.body);
    const { currentVersion, licenseKey, deploymentMethod, platform } = data;

    const updateAvailable = compareVersions(CURRENT_RELEASE.version, currentVersion) > 0;
    const isOutdated = compareVersions(currentVersion, CURRENT_RELEASE.minVersion) < 0;

    // Log the check for analytics (no PII)
    logger.info('Version check', {
      currentVersion,
      latestVersion: CURRENT_RELEASE.version,
      updateAvailable,
      deploymentMethod,
      platform,
      hasLicense: !!licenseKey,
    });

    res.json({
      success: true,
      currentVersion,
      latestVersion: CURRENT_RELEASE.version,
      updateAvailable,
      isOutdated,
      critical: CURRENT_RELEASE.critical,
      releaseDate: CURRENT_RELEASE.releaseDate,
      releaseNotes: updateAvailable ? CURRENT_RELEASE.releaseNotes : null,
      downloadUrl: CURRENT_RELEASE.downloadUrl,
      upgradeInstructions: updateAvailable ? getUpgradeInstructions(deploymentMethod) : null,
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
 */
router.get('/latest', (_req: Request, res: Response) => {
  res.json({
    version: CURRENT_RELEASE.version,
    releaseDate: CURRENT_RELEASE.releaseDate,
    releaseNotes: CURRENT_RELEASE.releaseNotes,
    downloadUrl: CURRENT_RELEASE.downloadUrl,
    critical: CURRENT_RELEASE.critical,
    minVersion: CURRENT_RELEASE.minVersion,
  });
});

/**
 * GET /api/updates/changelog
 * Get release notes/changelog
 */
router.get('/changelog', (_req: Request, res: Response) => {
  res.json({
    version: CURRENT_RELEASE.version,
    releaseNotes: CURRENT_RELEASE.releaseNotes,
    releaseDate: CURRENT_RELEASE.releaseDate,
  });
});

/**
 * Get upgrade instructions based on deployment method
 */
function getUpgradeInstructions(deploymentMethod?: string): object {
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
      command: `kubectl set image deployment/k8inspector k8inspector=k8inspector:${CURRENT_RELEASE.version}`,
    },
    helm: {
      title: 'Helm Upgrade',
      steps: [
        'Update your values.yaml with the new image tag',
        'Run: helm upgrade k8inspector ./k8inspector-chart',
      ],
      command: `helm upgrade k8inspector ./k8inspector-chart --set image.tag=${CURRENT_RELEASE.version}`,
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
