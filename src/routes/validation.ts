import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validationRateLimit } from '../middleware/rateLimit.js';
import * as licenseService from '../services/license.service.js';
import * as agentService from '../services/agent.service.js';
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

// mTLS agent enrollment — exchange CSR for short-lived client cert.
// Customer-opt-in via MTLS_AGENT_CA_ENABLED; returns 503 when disabled.
const enrollSchema = z.object({
  licenseKey: z
    .string()
    .regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'Invalid license key format'),
  machineFingerprint: z.string().min(1).max(256),
  csr: z.string().min(64).max(16384),
  requestedValidityDays: z.number().int().positive().max(365).optional(),
});

router.post('/agents/enroll', async (req: Request, res: Response) => {
  try {
    const data = enrollSchema.parse(req.body);
    const result = await agentService.enrollAgent({
      licenseKey: data.licenseKey,
      machineFingerprint: data.machineFingerprint,
      csrPem: data.csr,
      requestedValidityDays: data.requestedValidityDays,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', details: error.errors });
      return;
    }
    if (error instanceof agentService.EnrollmentError) {
      res.status(error.code).json({ error: error.message });
      return;
    }
    logger.error('Agent enrollment error:', error);
    res.status(500).json({ error: 'Agent enrollment failed' });
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
