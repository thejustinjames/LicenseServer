import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, getAuthProvider } from '../middleware/auth.js';
import { authRateLimit } from '../middleware/rateLimit.js';
import * as customerService from '../services/customer.service.js';
import * as licenseService from '../services/license.service.js';
import * as paymentService from '../services/payment.service.js';
import * as storageService from '../services/storage.service.js';
import * as productService from '../services/product.service.js';
import { passwordSchema, getPasswordRequirementsText } from '../utils/password.js';
import { JWTAuthProvider } from '../auth/jwt.auth.js';
import { logger } from '../services/logger.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const router = Router();

// Public routes (no authentication required)
router.get('/products', async (req, res: Response) => {
  try {
    const search = req.query.search as string | undefined;
    const category = req.query.category as string | undefined;
    const products = await productService.listProducts({ search, category });
    // Return only public product info (no sensitive data)
    const publicProducts = products.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      category: p.category,
      features: p.features,
      pricingType: p.pricingType,
      hasStripePrice: !!p.stripePriceId,
    }));
    res.json(publicProducts);
  } catch (error) {
    console.error('List products error:', error);
    res.status(500).json({ error: 'Failed to list products' });
  }
});

router.get('/products/categories', async (_req, res: Response) => {
  try {
    const categories = await productService.listCategories();
    res.json(categories);
  } catch (error) {
    console.error('List categories error:', error);
    res.status(500).json({ error: 'Failed to list categories' });
  }
});

// Auth schemas
const registerSchema = z.object({
  email: z.string().email(),
  password: passwordSchema,
  name: z.string().max(100).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

// Password requirements endpoint
router.get('/auth/password-requirements', (_req, res: Response) => {
  res.json({
    requirements: getPasswordRequirementsText(),
  });
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

    // Set httpOnly cookie
    const authProvider = getAuthProvider();
    if (authProvider instanceof JWTAuthProvider) {
      authProvider.setAuthCookie(res, auth.token);
    }

    logger.audit('register', {
      customerId: auth.customer.id,
      success: true,
    });

    res.status(201).json({
      customer: auth.customer,
      token: auth.token, // Also return token for backward compatibility
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    if (error instanceof Error && error.message.includes('already exists')) {
      res.status(409).json({ error: 'An account with this email already exists' });
      return;
    }
    logger.error('Register error', error);
    res.status(500).json({ error: 'Failed to register' });
  }
});

router.post('/auth/login', authRateLimit, async (req, res: Response) => {
  try {
    const data = loginSchema.parse(req.body);
    const auth = await customerService.authenticateCustomer(data.email, data.password);

    if (!auth) {
      logger.audit('login', {
        success: false,
        details: { email: data.email },
      });
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Set httpOnly cookie
    const authProvider = getAuthProvider();
    if (authProvider instanceof JWTAuthProvider) {
      authProvider.setAuthCookie(res, auth.token);
    }

    logger.audit('login', {
      customerId: auth.customer.id,
      success: true,
    });

    res.json({
      customer: auth.customer,
      token: auth.token, // Also return token for backward compatibility
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    logger.error('Login error', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Logout route
router.post('/auth/logout', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const authProvider = getAuthProvider();
    if (authProvider instanceof JWTAuthProvider) {
      await authProvider.logout(req, res);
    }

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Logout error', error);
    res.status(500).json({ error: 'Failed to logout' });
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
        res.status(403).json({ error: 'You do not have a valid license for this product' });
        return;
      }
      if (error.message.includes('not configured') || error.message.includes('not have')) {
        res.status(404).json({ error: 'Download not available for this product' });
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
        res.status(404).json({ error: 'Product not found' });
        return;
      }
      if (error.message.includes('Stripe price')) {
        res.status(400).json({ error: 'Product is not available for purchase' });
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
      res.status(400).json({ error: 'No billing account found. Please make a purchase first.' });
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

// Cancel subscription at period end
router.post('/subscriptions/:id/cancel', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    await paymentService.cancelSubscription(req.params.id);
    res.json({ success: true, message: 'Subscription will be canceled at period end' });
  } catch (error) {
    if (error instanceof Error && error.message.includes('not found')) {
      res.status(404).json({ error: 'Subscription not found' });
      return;
    }
    console.error('Cancel subscription error:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// Reactivate a canceled subscription
router.post('/subscriptions/:id/reactivate', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    await paymentService.reactivateSubscription(req.params.id);
    res.json({ success: true, message: 'Subscription reactivated' });
  } catch (error) {
    if (error instanceof Error && error.message.includes('not found')) {
      res.status(404).json({ error: 'Subscription not found' });
      return;
    }
    console.error('Reactivate subscription error:', error);
    res.status(500).json({ error: 'Failed to reactivate subscription' });
  }
});

// Get usage summary for a subscription
router.get('/subscriptions/:id/usage', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const summary = await paymentService.getUsageSummary(req.params.id);
    if (!summary) {
      res.status(404).json({ error: 'Subscription not found or not metered' });
      return;
    }

    res.json(summary);
  } catch (error) {
    console.error('Get usage summary error:', error);
    res.status(500).json({ error: 'Failed to get usage summary' });
  }
});

// Get usage records for a subscription
router.get('/subscriptions/:id/usage/records', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const records = await paymentService.getUsageRecords(req.params.id, {
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    });
    res.json(records);
  } catch (error) {
    console.error('Get usage records error:', error);
    res.status(500).json({ error: 'Failed to get usage records' });
  }
});

// Get refunds
router.get('/refunds', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const refunds = await paymentService.getRefundsByCustomerId(req.user.id);
    res.json(refunds);
  } catch (error) {
    console.error('Get refunds error:', error);
    res.status(500).json({ error: 'Failed to get refunds' });
  }
});

export default router;
