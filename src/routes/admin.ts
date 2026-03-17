import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import * as productService from '../services/product.service.js';
import * as licenseService from '../services/license.service.js';
import * as customerService from '../services/customer.service.js';
import { prisma } from '../config/database.js';
import type { AuthenticatedRequest } from '../types/index.js';

const router = Router();

router.use(authenticate);
router.use(requireAdmin);

// Product schemas
const createProductSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  validationMode: z.enum(['ONLINE', 'OFFLINE', 'HYBRID']).optional(),
  licenseDurationDays: z.number().positive().optional(),
  s3PackageKey: z.string().optional(),
  version: z.string().optional(),
  features: z.array(z.string()).optional(),
  createStripeProduct: z.boolean().optional(),
  stripePriceAmount: z.number().positive().optional(),
  stripePriceCurrency: z.string().optional(),
  stripePriceInterval: z.enum(['month', 'year']).optional(),
});

const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  validationMode: z.enum(['ONLINE', 'OFFLINE', 'HYBRID']).optional(),
  licenseDurationDays: z.number().positive().nullable().optional(),
  s3PackageKey: z.string().optional(),
  version: z.string().optional(),
  features: z.array(z.string()).optional(),
});

// License schemas
const createLicenseSchema = z.object({
  customerId: z.string().uuid(),
  productId: z.string().uuid(),
  expiresAt: z.string().datetime().optional(),
  maxActivations: z.number().positive().optional(),
  metadata: z.any().optional(),
});

const updateLicenseSchema = z.object({
  status: z.enum(['ACTIVE', 'EXPIRED', 'REVOKED', 'SUSPENDED']).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  maxActivations: z.number().positive().optional(),
  metadata: z.any().optional(),
});

// Product routes
router.post('/products', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = createProductSchema.parse(req.body);
    const product = await productService.createProduct(data);
    res.status(201).json(product);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    console.error('Create product error:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

router.get('/products', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const products = await productService.listProducts();
    res.json(products);
  } catch (error) {
    console.error('List products error:', error);
    res.status(500).json({ error: 'Failed to list products' });
  }
});

router.get('/products/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const product = await productService.getProductById(req.params.id);
    if (!product) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }
    res.json(product);
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({ error: 'Failed to get product' });
  }
});

router.put('/products/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = updateProductSchema.parse(req.body);
    const product = await productService.updateProduct(req.params.id, {
      ...data,
      licenseDurationDays: data.licenseDurationDays ?? undefined,
    });
    res.json(product);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    console.error('Update product error:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

router.delete('/products/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    await productService.deleteProduct(req.params.id);
    res.status(204).send();
  } catch (error) {
    if (error instanceof Error && error.message.includes('active licenses')) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('Delete product error:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// License routes
router.post('/licenses', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = createLicenseSchema.parse(req.body);
    const license = await licenseService.createLicense({
      ...data,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
    });
    res.status(201).json(license);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    console.error('Create license error:', error);
    res.status(500).json({ error: 'Failed to create license' });
  }
});

router.get('/licenses', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const filters = {
      customerId: req.query.customerId as string | undefined,
      productId: req.query.productId as string | undefined,
      status: req.query.status as 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'SUSPENDED' | undefined,
    };
    const licenses = await licenseService.listLicenses(filters);
    res.json(licenses);
  } catch (error) {
    console.error('List licenses error:', error);
    res.status(500).json({ error: 'Failed to list licenses' });
  }
});

router.get('/licenses/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const license = await licenseService.getLicenseById(req.params.id);
    if (!license) {
      res.status(404).json({ error: 'License not found' });
      return;
    }
    res.json(license);
  } catch (error) {
    console.error('Get license error:', error);
    res.status(500).json({ error: 'Failed to get license' });
  }
});

router.put('/licenses/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = updateLicenseSchema.parse(req.body);
    const license = await licenseService.updateLicense(req.params.id, {
      ...data,
      expiresAt: data.expiresAt === null ? undefined : data.expiresAt ? new Date(data.expiresAt) : undefined,
    });
    res.json(license);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    console.error('Update license error:', error);
    res.status(500).json({ error: 'Failed to update license' });
  }
});

router.post('/licenses/:id/revoke', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const license = await licenseService.revokeLicense(req.params.id);
    res.json(license);
  } catch (error) {
    console.error('Revoke license error:', error);
    res.status(500).json({ error: 'Failed to revoke license' });
  }
});

router.post('/licenses/:id/suspend', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const license = await licenseService.suspendLicense(req.params.id);
    res.json(license);
  } catch (error) {
    console.error('Suspend license error:', error);
    res.status(500).json({ error: 'Failed to suspend license' });
  }
});

router.post('/licenses/:id/reactivate', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const license = await licenseService.reactivateLicense(req.params.id);
    res.json(license);
  } catch (error) {
    console.error('Reactivate license error:', error);
    res.status(500).json({ error: 'Failed to reactivate license' });
  }
});

router.get('/licenses/:id/offline-token', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const token = await licenseService.generateOfflineLicense(req.params.id);
    if (!token) {
      res.status(500).json({ error: 'Failed to generate offline token' });
      return;
    }
    res.json({ token });
  } catch (error) {
    console.error('Generate offline token error:', error);
    res.status(500).json({ error: 'Failed to generate offline token' });
  }
});

// Customer routes
router.get('/customers', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const customers = await customerService.listCustomers();
    res.json(customers);
  } catch (error) {
    console.error('List customers error:', error);
    res.status(500).json({ error: 'Failed to list customers' });
  }
});

router.get('/customers/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const customer = await customerService.getCustomerById(req.params.id);
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }
    res.json(customer);
  } catch (error) {
    console.error('Get customer error:', error);
    res.status(500).json({ error: 'Failed to get customer' });
  }
});

router.get('/customers/:id/licenses', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const licenses = await licenseService.getLicensesByCustomerId(req.params.id);
    res.json(licenses);
  } catch (error) {
    console.error('Get customer licenses error:', error);
    res.status(500).json({ error: 'Failed to get customer licenses' });
  }
});

// Dashboard stats
router.get('/dashboard/stats', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const [
      totalCustomers,
      totalProducts,
      totalLicenses,
      activeLicenses,
      activeSubscriptions,
    ] = await Promise.all([
      prisma.customer.count(),
      prisma.product.count(),
      prisma.license.count(),
      prisma.license.count({ where: { status: 'ACTIVE' } }),
      prisma.subscription.count({ where: { status: 'ACTIVE' } }),
    ]);

    const recentLicenses = await prisma.license.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { email: true, name: true } },
        product: { select: { name: true } },
      },
    });

    res.json({
      totalCustomers,
      totalProducts,
      totalLicenses,
      activeLicenses,
      activeSubscriptions,
      recentLicenses,
    });
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({ error: 'Failed to get dashboard stats' });
  }
});

export default router;
