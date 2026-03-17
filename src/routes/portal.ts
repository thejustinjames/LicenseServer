import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { authRateLimit } from '../middleware/rateLimit.js';
import * as customerService from '../services/customer.service.js';
import * as licenseService from '../services/license.service.js';
import * as paymentService from '../services/payment.service.js';
import * as storageService from '../services/storage.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const router = Router();

// Auth schemas
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

// Auth routes (no authentication required)
router.post('/auth/register', authRateLimit, async (req, res: Response) => {
  try {
    const data = registerSchema.parse(req.body);
    const customer = await customerService.createCustomer(data);
    const auth = await customerService.authenticateCustomer(data.email, data.password);

    if (!auth) {
      res.status(500).json({ error: 'Failed to authenticate after registration' });
      return;
    }

    res.status(201).json({
      customer: auth.customer,
      token: auth.token,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    if (error instanceof Error && error.message.includes('already exists')) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error('Register error:', error);
    res.status(500).json({ error: 'Failed to register' });
  }
});

router.post('/auth/login', authRateLimit, async (req, res: Response) => {
  try {
    const data = loginSchema.parse(req.body);
    const auth = await customerService.authenticateCustomer(data.email, data.password);

    if (!auth) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    res.json({
      customer: auth.customer,
      token: auth.token,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Protected routes (authentication required)
router.get('/me', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const customer = await customerService.getCustomerById(req.user.id);
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    res.json(customer);
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

router.put('/me', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const updateSchema = z.object({
      name: z.string().optional(),
      password: z.string().min(8).optional(),
    });

    const data = updateSchema.parse(req.body);
    const customer = await customerService.updateCustomer(req.user.id, data);
    res.json(customer);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    console.error('Update me error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

router.get('/licenses', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const licenses = await licenseService.getLicensesByCustomerId(req.user.id);
    res.json(licenses);
  } catch (error) {
    console.error('Get licenses error:', error);
    res.status(500).json({ error: 'Failed to get licenses' });
  }
});

router.get('/downloads/:productId', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const download = await storageService.getSignedDownloadUrl(
      req.params.productId,
      req.user.id
    );

    if (!download) {
      res.status(404).json({ error: 'Download not available' });
      return;
    }

    res.json(download);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('No valid license')) {
        res.status(403).json({ error: error.message });
        return;
      }
      if (error.message.includes('not configured') || error.message.includes('not have')) {
        res.status(404).json({ error: error.message });
        return;
      }
    }
    console.error('Get download error:', error);
    res.status(500).json({ error: 'Failed to get download URL' });
  }
});

router.post('/billing/checkout', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const checkoutSchema = z.object({
      productId: z.string().uuid(),
      successUrl: z.string().url().optional(),
      cancelUrl: z.string().url().optional(),
    });

    const data = checkoutSchema.parse(req.body);
    const url = await paymentService.createCheckoutSession({
      productId: data.productId,
      customerId: req.user.id,
      successUrl: data.successUrl,
      cancelUrl: data.cancelUrl,
    });

    res.json({ url });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    if (error instanceof Error) {
      if (error.message.includes('not found')) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error.message.includes('Stripe price')) {
        res.status(400).json({ error: error.message });
        return;
      }
    }
    console.error('Create checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

router.post('/billing/portal', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const url = await paymentService.createBillingPortalSession(req.user.id);
    res.json({ url });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Stripe account')) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('Create billing portal error:', error);
    res.status(500).json({ error: 'Failed to create billing portal session' });
  }
});

router.get('/subscriptions', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const subscriptions = await paymentService.getSubscriptionsByCustomerId(req.user.id);
    res.json(subscriptions);
  } catch (error) {
    console.error('Get subscriptions error:', error);
    res.status(500).json({ error: 'Failed to get subscriptions' });
  }
});

export default router;
