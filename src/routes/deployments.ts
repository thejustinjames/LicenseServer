/**
 * Deployment Validation Routes
 *
 * Validates and tracks deployments of Agencio products.
 * Provides:
 * - Deployment validation on startup
 * - Heartbeat tracking
 * - Remote kill capability (self-destruct)
 * - Watermark registry for leak tracing
 */

import express from 'express';
import crypto from 'crypto';
import { prisma } from '../config/database.js';
import { DeploymentStatus } from '@prisma/client';
import { logger } from '../services/logger.service.js';
import { config } from '../config/index.js';

const router = express.Router();

// ============================================================================
// Types
// ============================================================================

interface DeploymentFingerprint {
  deploymentId: string;
  machineHash: string;
  version: string;
  environment: string;
  timestamp: string;
  productId: string;
}

interface ValidationResponse {
  valid: boolean;
  message: string;
  expiresAt?: string;
  features?: string[];
  tier?: string;
  action?: 'continue' | 'warn' | 'kill';
  killReason?: string;
  _ts?: number;
  _did?: string;
  _sig?: string;
}

// ============================================================================
// Response Signing
// ============================================================================

function signResponse(payload: Omit<ValidationResponse, '_sig'>, secret: string): ValidationResponse {
  const withMeta = { ...payload, _ts: Date.now() };
  const signature = crypto.createHmac('sha256', secret).update(JSON.stringify(withMeta)).digest('hex');
  return { ...withMeta, _sig: signature };
}

function signHeartbeatResponse(payload: Record<string, unknown>, secret: string): Record<string, unknown> {
  const withMeta = { ...payload, _ts: Date.now() };
  const signature = crypto.createHmac('sha256', secret).update(JSON.stringify(withMeta)).digest('hex');
  return { ...withMeta, _sig: signature };
}

// ============================================================================
// Signature Verification
// ============================================================================

function verifySignature(payload: string, signature: string, secret: string): boolean {
  if (!secret || signature === 'unsigned') {
    // In dev/testing, allow unsigned requests
    return config.NODE_ENV !== 'production';
  }

  const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
}

// ============================================================================
// Deployment Validation
// ============================================================================

/**
 * POST /api/deployments/validate
 *
 * Validates a deployment fingerprint against registered deployments.
 * Returns validation status and any actions to take.
 */
router.post('/validate', async (req, res) => {
  try {
    const fingerprint = (req.body || {}) as DeploymentFingerprint;
    const signature = req.headers['x-deployment-signature'] as string;
    // Header takes precedence; fall back to body so callers that only send
    // the signed fingerprint (which already contains deploymentId) work too.
    const deploymentId = (req.headers['x-deployment-id'] as string) || fingerprint.deploymentId;

    // Log the validation attempt
    logger.info('Deployment validation request', {
      deploymentId,
      productId: fingerprint.productId,
      environment: fingerprint.environment,
      version: fingerprint.version,
      ip: req.ip,
    });

    if (!deploymentId) {
      return res.status(400).json({
        valid: false,
        message: 'deploymentId is required (x-deployment-id header or request body)',
        action: 'warn',
        _ts: Date.now(),
      } as ValidationResponse);
    }

    // Check if this deployment is registered
    const deployment = await prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        license: true,
        customer: true,
      },
    });

    // Deployment not found - check if we should auto-register or reject
    if (!deployment) {
      // Check if auto-registration is enabled for this product
      const productConfig = await prisma.product.findFirst({
        where: { slug: fingerprint.productId },
      });

      if (productConfig?.allowAutoRegister && fingerprint.environment !== 'production') {
        // Auto-register dev/staging deployments - generate secret for signing
        const newSecret = crypto.randomBytes(32).toString('hex');
        await prisma.deployment.create({
          data: {
            id: deploymentId,
            machineHash: fingerprint.machineHash,
            productId: productConfig.id,
            environment: fingerprint.environment,
            version: fingerprint.version,
            status: 'ACTIVE',
            secret: newSecret,
            lastSeenAt: new Date(),
            metadata: {
              autoRegistered: true,
              firstSeen: new Date().toISOString(),
              ip: req.ip,
            },
          },
        });

        logger.info('Auto-registered development deployment', { deploymentId });

        // Dev auto-register: unsigned response (no shared secret yet)
        return res.json({
          valid: true,
          message: 'Development deployment auto-registered',
          tier: 'development',
          action: 'continue',
          _ts: Date.now(),
          _did: deploymentId,
        } as ValidationResponse);
      }

      // Unknown deployment in production - reject (unsigned, no secret)
      logger.warn('Unknown deployment attempted validation', {
        deploymentId,
        productId: fingerprint.productId,
        ip: req.ip,
      });

      return res.status(403).json({
        valid: false,
        message: 'Deployment not registered. Contact support@agencio.cloud',
        action: 'kill',
        killReason: 'UNREGISTERED_DEPLOYMENT',
        _ts: Date.now(),
      } as ValidationResponse);
    }

    // Check deployment status
    if (deployment.status === 'REVOKED') {
      logger.warn('Revoked deployment attempted validation', { deploymentId });

      const response: ValidationResponse = {
        valid: false,
        message: 'Deployment has been revoked',
        action: 'kill',
        killReason: 'DEPLOYMENT_REVOKED',
        _did: deploymentId,
      };
      return res.json(deployment.secret ? signResponse(response, deployment.secret) : { ...response, _ts: Date.now() });
    }

    if (deployment.status === 'KILL') {
      logger.warn('Kill-flagged deployment attempted validation', { deploymentId });

      const response: ValidationResponse = {
        valid: false,
        message: deployment.killReason || 'Deployment terminated by administrator',
        action: 'kill',
        killReason: deployment.killReason || 'ADMIN_KILL',
        _did: deploymentId,
      };
      return res.json(deployment.secret ? signResponse(response, deployment.secret) : { ...response, _ts: Date.now() });
    }

    if (deployment.status === 'SUSPENDED') {
      const response: ValidationResponse = {
        valid: false,
        message: 'Deployment is suspended. Contact support.',
        action: 'warn',
        _did: deploymentId,
      };
      return res.json(deployment.secret ? signResponse(response, deployment.secret) : { ...response, _ts: Date.now() });
    }

    // Verify signature if deployment has a secret
    if (deployment.secret) {
      const payload = JSON.stringify(fingerprint);
      if (!verifySignature(payload, signature, deployment.secret)) {
        logger.warn('Invalid signature on deployment validation', { deploymentId });

        // Sign even the rejection so client knows it's from real server
        const response: ValidationResponse = {
          valid: false,
          message: 'Invalid deployment signature',
          action: 'kill',
          killReason: 'INVALID_SIGNATURE',
          _did: deploymentId,
        };
        return res.status(401).json(signResponse(response, deployment.secret));
      }
    }

    // Check license validity
    if (deployment.license) {
      if (deployment.license.status !== 'ACTIVE') {
        const response: ValidationResponse = {
          valid: false,
          message: `License is ${deployment.license.status.toLowerCase()}`,
          action: deployment.license.status === 'EXPIRED' ? 'warn' : 'kill',
          _did: deploymentId,
        };
        return res.json(deployment.secret ? signResponse(response, deployment.secret) : { ...response, _ts: Date.now() });
      }

      if (deployment.license.expiresAt && new Date(deployment.license.expiresAt) < new Date()) {
        const response: ValidationResponse = {
          valid: false,
          message: 'License has expired',
          action: 'warn',
          expiresAt: deployment.license.expiresAt.toISOString(),
          _did: deploymentId,
        };
        return res.json(deployment.secret ? signResponse(response, deployment.secret) : { ...response, _ts: Date.now() });
      }
    }

    // Update last seen timestamp
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        lastSeenAt: new Date(),
        version: fingerprint.version,
        metadata: {
          ...(deployment.metadata as object || {}),
          lastIp: req.ip,
          lastUserAgent: req.headers['user-agent'],
        },
      },
    });

    // Successful validation
    const response: ValidationResponse = {
      valid: true,
      message: 'Deployment validated',
      tier: deployment.license?.licenseType || 'standard',
      action: 'continue',
      _did: deploymentId,
    };

    if (deployment.license?.expiresAt) {
      response.expiresAt = deployment.license.expiresAt.toISOString();
    }

    logger.info('Deployment validated successfully', { deploymentId });
    return res.json(deployment.secret ? signResponse(response, deployment.secret) : { ...response, _ts: Date.now() });

  } catch (error) {
    logger.error('Deployment validation error', error);

    // On error, allow in dev but reject in prod (unsigned - no deployment context)
    if (config.NODE_ENV !== 'production') {
      return res.json({
        valid: true,
        message: 'Validation skipped (server error in dev mode)',
        action: 'continue',
        _ts: Date.now(),
      } as ValidationResponse);
    }

    return res.status(500).json({
      valid: false,
      message: 'Validation service unavailable',
      action: 'warn',
      _ts: Date.now(),
    } as ValidationResponse);
  }
});

// ============================================================================
// Heartbeat
// ============================================================================

/**
 * POST /api/deployments/heartbeat
 *
 * Periodic check-in from active deployments.
 * Returns any pending actions (kill, update, etc.)
 */
router.post('/heartbeat', async (req, res) => {
  try {
    const { deploymentId, metrics } = req.body;

    const deployment = await prisma.deployment.findUnique({
      where: { id: deploymentId },
    });

    if (!deployment) {
      return res.status(404).json({
        action: 'kill',
        reason: 'DEPLOYMENT_NOT_FOUND',
        _ts: Date.now(),
      });
    }

    // Check for kill flag
    if (deployment.status === 'KILL') {
      const response = {
        action: 'kill',
        reason: deployment.killReason || 'ADMIN_KILL',
        message: deployment.killMessage,
        _did: deploymentId,
      };
      return res.json(deployment.secret ? signHeartbeatResponse(response, deployment.secret) : { ...response, _ts: Date.now() });
    }

    // Update last seen and metrics
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        lastSeenAt: new Date(),
        metrics: metrics || undefined,
      },
    });

    // Check for pending commands
    const pendingCommands = await prisma.deploymentCommand.findMany({
      where: {
        deploymentId,
        status: 'PENDING',
      },
      orderBy: { createdAt: 'asc' },
    });

    // Mark commands as delivered
    if (pendingCommands.length > 0) {
      await prisma.deploymentCommand.updateMany({
        where: {
          id: { in: pendingCommands.map((c: any) => c.id) },
        },
        data: { status: 'DELIVERED' },
      });
    }

    const response = {
      action: 'continue',
      commands: pendingCommands.map((c: any) => ({
        id: c.id,
        type: c.type,
        payload: c.payload,
      })),
      _did: deploymentId,
    };
    return res.json(deployment.secret ? signHeartbeatResponse(response, deployment.secret) : { ...response, _ts: Date.now() });

  } catch (error) {
    logger.error('Heartbeat error', error);
    return res.json({ action: 'continue', _ts: Date.now() });
  }
});

// ============================================================================
// Admin: Kill Deployment
// ============================================================================

/**
 * POST /api/deployments/:id/kill
 *
 * Admin endpoint to remotely kill a deployment.
 * The deployment will receive the kill signal on next heartbeat or validation.
 */
router.post('/:id/kill', async (req, res) => {
  // TODO: Add admin authentication
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== config.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { id } = req.params;
    const { reason, message } = req.body;

    const deployment = await prisma.deployment.update({
      where: { id },
      data: {
        status: 'KILL',
        killReason: reason || 'ADMIN_KILL',
        killMessage: message,
        killedAt: new Date(),
      },
    });

    logger.warn('Deployment kill issued', {
      deploymentId: id,
      reason,
      issuedBy: 'admin',
    });

    return res.json({
      success: true,
      deployment: {
        id: deployment.id,
        status: deployment.status,
        killReason: deployment.killReason,
      },
    });

  } catch (error) {
    logger.error('Kill deployment error', error);
    return res.status(500).json({ error: 'Failed to kill deployment' });
  }
});

// ============================================================================
// Admin: Register Deployment
// ============================================================================

/**
 * POST /api/deployments/register
 *
 * Admin endpoint to register a new authorized deployment.
 */
router.post('/register', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== config.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { deploymentId, productId, customerId, licenseId, environment, secret } = req.body;

    // Generate secret if not provided
    const deploymentSecret = secret || crypto.randomBytes(32).toString('hex');

    const deployment = await prisma.deployment.create({
      data: {
        id: deploymentId,
        productId,
        customerId,
        licenseId,
        environment: environment || 'production',
        status: 'ACTIVE',
        secret: deploymentSecret,
        metadata: {
          registeredAt: new Date().toISOString(),
          registeredBy: 'admin',
        },
      },
    });

    logger.info('Deployment registered', { deploymentId });

    return res.json({
      success: true,
      deployment: {
        id: deployment.id,
        secret: deploymentSecret, // Only returned once!
      },
    });

  } catch (error) {
    logger.error('Register deployment error', error);
    return res.status(500).json({ error: 'Failed to register deployment' });
  }
});

// ============================================================================
// Admin: List Deployments
// ============================================================================

/**
 * GET /api/deployments
 *
 * Admin endpoint to list all deployments.
 */
router.get('/', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== config.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { status, productId } = req.query;

    const deployments = await prisma.deployment.findMany({
      where: {
        ...(status ? { status: status as DeploymentStatus } : {}),
        ...(productId ? { productId: productId as string } : {}),
      },
      include: {
        license: true,
        customer: true,
      },
      orderBy: { lastSeenAt: 'desc' },
    });

    return res.json({
      deployments: deployments.map((d: any) => ({
        id: d.id,
        status: d.status,
        environment: d.environment,
        version: d.version,
        lastSeenAt: d.lastSeenAt,
        customer: d.customer?.email,
        license: d.license?.key?.slice(0, 8) + '...',
      })),
    });

  } catch (error) {
    logger.error('List deployments error', error);
    return res.status(500).json({ error: 'Failed to list deployments' });
  }
});

// ============================================================================
// Watermark Registry
// ============================================================================

/**
 * POST /api/deployments/watermark/identify
 *
 * Given a watermark found in leaked code, identify the source deployment.
 */
router.post('/watermark/identify', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== config.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { watermark } = req.body;

    // Get all deployments with their secrets
    const deployments = await prisma.deployment.findMany({
      where: { secret: { not: null } },
      select: {
        id: true,
        secret: true,
        customerId: true,
        customer: { select: { email: true, name: true } },
        environment: true,
        createdAt: true,
      },
    });

    // Check each deployment's watermark
    for (const deployment of deployments) {
      if (!deployment.secret) continue;

      const expectedWatermark = crypto
        .createHash('sha256')
        .update(deployment.secret)
        .digest('hex')
        .slice(0, 8);

      if (watermark === expectedWatermark) {
        logger.warn('Watermark identified', {
          watermark,
          deploymentId: deployment.id,
          customer: deployment.customer?.email,
        });

        return res.json({
          found: true,
          deployment: {
            id: deployment.id,
            customer: deployment.customer,
            environment: deployment.environment,
            createdAt: deployment.createdAt,
          },
        });
      }
    }

    return res.json({ found: false });

  } catch (error) {
    logger.error('Watermark identify error', error);
    return res.status(500).json({ error: 'Failed to identify watermark' });
  }
});

export default router;
