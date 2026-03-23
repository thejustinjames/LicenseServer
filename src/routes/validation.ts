import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validationRateLimit } from '../middleware/rateLimit.js';
import * as licenseService from '../services/license.service.js';
import { getPublicKey } from '../utils/crypto.js';
import { logger } from '../services/logger.service.js';

const router = Router();

router.use(validationRateLimit);

const validateSchema = z.object({
  licenseKey: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'Invalid license key format'),
  machineFingerprint: z.string().optional(),
  productId: z.string().uuid().optional(),
});

const activateSchema = z.object({
  licenseKey: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'Invalid license key format'),
  machineFingerprint: z.string().min(1),
  machineName: z.string().optional(),
});

const deactivateSchema = z.object({
  licenseKey: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'Invalid license key format'),
  machineFingerprint: z.string().min(1),
});

router.post('/validate', async (req: Request, res: Response) => {
  try {
    const data = validateSchema.parse(req.body);
    const result = await licenseService.validateLicense(
      data.licenseKey,
      data.machineFingerprint
    );

    if (!result.valid) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ valid: false, error: 'Invalid request', details: error.errors });
      return;
    }
    logger.error('Validate error:', error);
    res.status(500).json({ valid: false, error: 'Validation failed' });
  }
});

router.post('/activate', async (req: Request, res: Response) => {
  try {
    const data = activateSchema.parse(req.body);
    const ipAddress = req.ip || req.socket.remoteAddress;

    const result = await licenseService.activateLicense(
      data.licenseKey,
      data.machineFingerprint,
      data.machineName,
      ipAddress
    );

    if (!result.success) {
      res.status(400).json({ success: false, error: result.error });
      return;
    }

    res.json({
      success: true,
      activation: {
        machineFingerprint: result.activation?.machineFingerprint,
        activatedAt: result.activation?.activatedAt,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, error: 'Invalid request', details: error.errors });
      return;
    }
    logger.error('Activate error:', error);
    res.status(500).json({ success: false, error: 'Activation failed' });
  }
});

router.post('/deactivate', async (req: Request, res: Response) => {
  try {
    const data = deactivateSchema.parse(req.body);
    const result = await licenseService.deactivateLicense(
      data.licenseKey,
      data.machineFingerprint
    );

    if (!result.success) {
      res.status(400).json({ success: false, error: result.error });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, error: 'Invalid request', details: error.errors });
      return;
    }
    logger.error('Deactivate error:', error);
    res.status(500).json({ success: false, error: 'Deactivation failed' });
  }
});

router.get('/public-key', (_req: Request, res: Response) => {
  const publicKey = getPublicKey();

  if (!publicKey) {
    res.status(404).json({ error: 'Public key not available' });
    return;
  }

  res.type('text/plain').send(publicKey);
});

router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;
