import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validationRateLimit } from '../middleware/rateLimit.js';
import * as desktopService from '../services/desktop.service.js';
import { logger } from '../services/logger.service.js';

const router = Router();

// Apply rate limiting
router.use(validationRateLimit);

// Validation schemas
const desktopValidateSchema = z.object({
  licenseKey: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'Invalid license key format'),
  machineFingerprint: z.string().min(1),
  platform: z.enum(['windows', 'macos', 'linux']),
  appVersion: z.string().optional(),
  osVersion: z.string().optional(),
});

const checkInSchema = z.object({
  licenseKey: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'Invalid license key format'),
  machineFingerprint: z.string().min(1),
  appVersion: z.string().optional(),
  lastUsed: z.string().datetime().optional(),
});

/**
 * POST /api/v1/desktop/validate
 * Validate a desktop license with machine binding
 */
router.post('/validate', async (req: Request, res: Response) => {
  try {
    const data = desktopValidateSchema.parse(req.body);

    const result = await desktopService.validateDesktopLicense({
      licenseKey: data.licenseKey,
      machineFingerprint: data.machineFingerprint,
      platform: data.platform,
      appVersion: data.appVersion,
      osVersion: data.osVersion,
    });

    if (!result.valid) {
      res.status(400).json({
        valid: false,
        error: result.error,
      });
      return;
    }

    res.json({
      valid: true,
      product: result.product,
      features: result.features,
      expiresAt: result.expiresAt,
      offlineToken: result.offlineToken,
      checkInDays: result.checkInDays,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ valid: false, error: 'Invalid request', details: error.errors });
      return;
    }
    logger.error('Desktop validate error:', error);
    res.status(500).json({ valid: false, error: 'Validation failed' });
  }
});

/**
 * POST /api/v1/desktop/checkin
 * Phone-home check-in for desktop apps
 */
router.post('/checkin', async (req: Request, res: Response) => {
  try {
    const data = checkInSchema.parse(req.body);

    const result = await desktopService.checkIn({
      licenseKey: data.licenseKey,
      machineFingerprint: data.machineFingerprint,
      appVersion: data.appVersion,
      lastUsed: data.lastUsed ? new Date(data.lastUsed) : undefined,
    });

    if (!result.valid) {
      res.status(400).json({
        valid: false,
        error: result.error,
      });
      return;
    }

    res.json({
      valid: true,
      renewedToken: result.renewedToken,
      message: result.message,
      nextCheckIn: result.nextCheckIn?.toISOString(),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ valid: false, error: 'Invalid request', details: error.errors });
      return;
    }
    logger.error('Desktop check-in error:', error);
    res.status(500).json({ valid: false, error: 'Check-in failed' });
  }
});

/**
 * GET /api/v1/desktop/activation
 * Get activation details for a machine
 */
router.get('/activation', async (req: Request, res: Response) => {
  try {
    const licenseKey = req.query.licenseKey as string;
    const machineFingerprint = req.query.machineFingerprint as string;

    if (!licenseKey || !machineFingerprint) {
      res.status(400).json({ error: 'licenseKey and machineFingerprint are required' });
      return;
    }

    const activation = await desktopService.getActivationDetails(
      licenseKey,
      machineFingerprint
    );

    if (!activation) {
      res.status(404).json({ error: 'Activation not found' });
      return;
    }

    res.json({
      activationId: activation.id,
      platform: activation.platform,
      appVersion: activation.appVersion,
      activatedAt: activation.activatedAt,
      lastSeenAt: activation.lastSeenAt,
      lastCheckIn: activation.lastCheckIn,
    });
  } catch (error) {
    logger.error('Get activation error:', error);
    res.status(500).json({ error: 'Failed to get activation details' });
  }
});

export default router;
