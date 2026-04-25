import { Router, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { authenticate } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { idleTimeout } from '../middleware/idleTimeout.js';
import { validateIdParam, parsePositiveInt, sanitizeString } from '../middleware/validation.js';
import * as productService from '../services/product.service.js';
import * as licenseService from '../services/license.service.js';
import * as customerService from '../services/customer.service.js';
import * as paymentService from '../services/payment.service.js';
import * as storageService from '../services/storage.service.js';
import * as seatService from '../services/seat.service.js';
import * as quoteService from '../services/quote.service.js';
import * as desktopService from '../services/desktop.service.js';
import * as crlService from '../services/crl.service.js';
import { isMtlsCaEnabled } from '../services/ca.service.js';
import { prisma } from '../config/database.js';
import { logger } from '../services/logger.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

// Configure multer for memory storage (files up to 500MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max
  },
  fileFilter: (_req, file, cb) => {
    // Allow common archive and installer types
    const allowedTypes = [
      'application/zip',
      'application/x-zip-compressed',
      'application/x-tar',
      'application/gzip',
      'application/x-gzip',
      'application/x-bzip2',
      'application/x-7z-compressed',
      'application/x-rar-compressed',
      'application/octet-stream', // Generic binary
      'application/x-msdownload', // .exe
      'application/x-msi', // .msi
      'application/x-apple-diskimage', // .dmg
      'application/vnd.debian.binary-package', // .deb
      'application/x-rpm', // .rpm
    ];

    // Also check by extension for fallback
    const allowedExtensions = [
      '.zip', '.tar', '.gz', '.tgz', '.bz2', '.7z', '.rar',
      '.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.AppImage',
    ];

    const ext = '.' + (file.originalname.split('.').pop() || '').toLowerCase();

    if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype} (${ext})`));
    }
  },
});

const router = Router();

router.use(authenticate);
router.use(idleTimeout);
router.use(requireAdmin);

// Product schemas
const createProductSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  validationMode: z.enum(['ONLINE', 'OFFLINE', 'HYBRID']).optional(),
  pricingType: z.enum(['FIXED', 'METERED']).optional(),
  purchaseType: z.enum(['SUBSCRIPTION', 'ONE_TIME']).optional(),
  licenseDurationDays: z.number().positive().optional(),
  s3PackageKey: z.string().optional(),
  version: z.string().optional(),
  features: z.array(z.string()).optional(),
  createStripeProduct: z.boolean().optional(),
  // Monthly price in cents
  stripePriceAmount: z.number().positive().optional(),
  stripePriceCurrency: z.string().optional(),
  stripePriceInterval: z.enum(['month', 'year']).optional(),
  // Annual price in cents (for subscriptions)
  stripePriceAmountAnnual: z.number().positive().optional(),
  // Local display prices (in cents)
  priceMonthly: z.number().nonnegative().optional(),
  priceAnnual: z.number().nonnegative().optional(),
  // Metered billing options
  meteredUsageType: z.enum(['licensed', 'metered', 'aggregated']).optional(),
  meteredAggregateUsage: z.enum(['sum', 'last_during_period', 'last_ever', 'max']).optional(),
  // Tax options
  taxCode: z.string().optional(),
  taxBehavior: z.enum(['exclusive', 'inclusive', 'unspecified']).optional(),
});

const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  category: z.string().nullable().optional(),
  validationMode: z.enum(['ONLINE', 'OFFLINE', 'HYBRID']).optional(),
  pricingType: z.enum(['FIXED', 'METERED']).optional(),
  purchaseType: z.enum(['SUBSCRIPTION', 'ONE_TIME']).optional(),
  licenseDurationDays: z.number().positive().nullable().optional(),
  s3PackageKey: z.string().optional(),
  version: z.string().optional(),
  features: z.array(z.string()).optional(),
  priceMonthly: z.number().nonnegative().nullable().optional(),
  priceAnnual: z.number().nonnegative().nullable().optional(),
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
    logger.error('Create product error:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

router.get('/products', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const search = req.query.search as string | undefined;
    const category = req.query.category as string | undefined;
    const products = await productService.listProducts({ search, category });
    res.json(products);
  } catch (error) {
    logger.error('List products error:', error);
    res.status(500).json({ error: 'Failed to list products' });
  }
});

router.get('/products/categories', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const categories = await productService.listCategories();
    res.json(categories);
  } catch (error) {
    logger.error('List categories error:', error);
    res.status(500).json({ error: 'Failed to list categories' });
  }
});

router.get('/products/:id', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const product = await productService.getProductById(req.params.id);
    if (!product) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }
    res.json(product);
  } catch (error) {
    logger.error('Get product error:', error);
    res.status(500).json({ error: 'Failed to get product' });
  }
});

router.put('/products/:id', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
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
    logger.error('Update product error:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

router.delete('/products/:id', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await productService.deleteProduct(req.params.id);
    res.status(204).send();
  } catch (error) {
    if (error instanceof Error && error.message.includes('active licenses')) {
      res.status(400).json({ error: error.message });
      return;
    }
    logger.error('Delete product error:', error);
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
    logger.error('Create license error:', error);
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
    logger.error('List licenses error:', error);
    res.status(500).json({ error: 'Failed to list licenses' });
  }
});

router.get('/licenses/:id', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const license = await licenseService.getLicenseById(req.params.id);
    if (!license) {
      res.status(404).json({ error: 'License not found' });
      return;
    }
    res.json(license);
  } catch (error) {
    logger.error('Get license error:', error);
    res.status(500).json({ error: 'Failed to get license' });
  }
});

router.put('/licenses/:id', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
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
    logger.error('Update license error:', error);
    res.status(500).json({ error: 'Failed to update license' });
  }
});

router.post('/licenses/:id/revoke', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const license = await licenseService.revokeLicense(req.params.id);
    res.json(license);
  } catch (error) {
    logger.error('Revoke license error:', error);
    res.status(500).json({ error: 'Failed to revoke license' });
  }
});

router.post('/licenses/:id/suspend', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const license = await licenseService.suspendLicense(req.params.id);
    res.json(license);
  } catch (error) {
    logger.error('Suspend license error:', error);
    res.status(500).json({ error: 'Failed to suspend license' });
  }
});

router.post('/licenses/:id/reactivate', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const license = await licenseService.reactivateLicense(req.params.id);
    res.json(license);
  } catch (error) {
    logger.error('Reactivate license error:', error);
    res.status(500).json({ error: 'Failed to reactivate license' });
  }
});

router.get('/licenses/:id/offline-token', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const token = await licenseService.generateOfflineLicense(req.params.id);
    if (!token) {
      res.status(500).json({ error: 'Failed to generate offline token' });
      return;
    }
    res.json({ token });
  } catch (error) {
    logger.error('Generate offline token error:', error);
    res.status(500).json({ error: 'Failed to generate offline token' });
  }
});

// ============================================================================
// SEAT MANAGEMENT
// ============================================================================

const assignSeatSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  sendInvite: z.boolean().optional().default(true),
});

const bulkAssignSeatsSchema = z.object({
  assignments: z.array(z.object({
    email: z.string().email(),
    name: z.string().optional(),
  })).min(1).max(100),
  sendInvites: z.boolean().optional().default(true),
});

// Get seat assignments for a license
router.get('/licenses/:id/seats', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await seatService.getSeatAssignments(req.params.id);

    if (!result.license) {
      res.status(404).json({ error: 'License not found' });
      return;
    }

    res.json({
      seats: result.seats,
      available: result.available,
      total: result.total,
    });
  } catch (error) {
    logger.error('Get seat assignments error:', error);
    res.status(500).json({ error: 'Failed to get seat assignments' });
  }
});

// Assign a seat to a user
router.post('/licenses/:id/seats', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = assignSeatSchema.parse(req.body);

    const result = await seatService.assignSeat({
      licenseId: req.params.id,
      email: data.email,
      name: data.name,
      assignedBy: req.user?.email,
      sendInvite: data.sendInvite,
    });

    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.status(201).json({
      assignment: result.assignment,
      inviteUrl: result.inviteUrl,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    logger.error('Assign seat error:', error);
    res.status(500).json({ error: 'Failed to assign seat' });
  }
});

// Bulk assign seats
router.post('/licenses/:id/seats/bulk', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = bulkAssignSeatsSchema.parse(req.body);

    const result = await seatService.bulkAssignSeats(
      req.params.id,
      data.assignments,
      req.user?.email,
      data.sendInvites
    );

    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    logger.error('Bulk assign seats error:', error);
    res.status(500).json({ error: 'Failed to bulk assign seats' });
  }
});

// Remove a seat assignment
router.delete('/licenses/:id/seats/:email', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await seatService.removeSeat(req.params.id, req.params.email);

    if (!result.success) {
      res.status(404).json({ error: result.error });
      return;
    }

    res.status(204).send();
  } catch (error) {
    logger.error('Remove seat error:', error);
    res.status(500).json({ error: 'Failed to remove seat' });
  }
});

// Resend seat invite
router.post('/licenses/:id/seats/:email/resend', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await seatService.resendSeatInvite(req.params.id, req.params.email);

    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ success: true, message: 'Invite resent' });
  } catch (error) {
    logger.error('Resend seat invite error:', error);
    res.status(500).json({ error: 'Failed to resend invite' });
  }
});

// Get desktop activations for a license
router.get('/licenses/:id/activations', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await desktopService.listDesktopActivations(req.params.id);
    res.json(result);
  } catch (error) {
    logger.error('List activations error:', error);
    res.status(500).json({ error: 'Failed to list activations' });
  }
});

// Revoke a specific activation
router.delete('/activations/:id', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await desktopService.revokeActivation(req.params.id);

    if (!result.success) {
      res.status(404).json({ error: result.error });
      return;
    }

    res.status(204).send();
  } catch (error) {
    logger.error('Revoke activation error:', error);
    res.status(500).json({ error: 'Failed to revoke activation' });
  }
});

// ============================================================================
// ENTERPRISE QUOTES
// ============================================================================

const createQuoteSchema = z.object({
  productId: z.string().uuid(),
  contactEmail: z.string().email(),
  contactName: z.string().optional(),
  companyName: z.string().optional(),
  customerId: z.string().uuid().optional(),
  seatCount: z.number().positive(),
  term: z.enum(['SUBSCRIPTION', 'PERPETUAL', 'MULTI_YEAR']).optional(),
  termYears: z.number().positive().max(5).optional(),
  discount: z.number().min(0).max(1).optional(),
  customFeatures: z.array(z.string()).optional(),
  notes: z.string().optional(),
  validDays: z.number().positive().optional(),
});

// List quotes
router.get('/quotes', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const quotes = await quoteService.listQuotes({
      status: req.query.status as 'DRAFT' | 'SENT' | 'ACCEPTED' | undefined,
      customerId: req.query.customerId as string | undefined,
      productId: req.query.productId as string | undefined,
    });
    res.json(quotes);
  } catch (error) {
    logger.error('List quotes error:', error);
    res.status(500).json({ error: 'Failed to list quotes' });
  }
});

// Create a quote
router.post('/quotes', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = createQuoteSchema.parse(req.body);
    const quote = await quoteService.createQuote(data);
    res.status(201).json(quote);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    logger.error('Create quote error:', error);
    res.status(500).json({ error: 'Failed to create quote' });
  }
});

// Get quote by ID
router.get('/quotes/:id', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const quote = await quoteService.getQuoteById(req.params.id);
    if (!quote) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }
    res.json(quote);
  } catch (error) {
    logger.error('Get quote error:', error);
    res.status(500).json({ error: 'Failed to get quote' });
  }
});

// Send quote to customer
router.post('/quotes/:id/send', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await quoteService.sendQuote(req.params.id);

    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ success: true, message: 'Quote sent' });
  } catch (error) {
    logger.error('Send quote error:', error);
    res.status(500).json({ error: 'Failed to send quote' });
  }
});

// Update quote status
router.put('/quotes/:id/status', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const statusSchema = z.object({
      status: z.enum(['DRAFT', 'SENT', 'VIEWED', 'ACCEPTED', 'REJECTED', 'EXPIRED']),
    });

    const data = statusSchema.parse(req.body);
    const quote = await quoteService.updateQuoteStatus(req.params.id, data.status);
    res.json(quote);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    logger.error('Update quote status error:', error);
    res.status(500).json({ error: 'Failed to update quote status' });
  }
});

// Convert quote to license
router.post('/quotes/:id/convert', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const convertSchema = z.object({
      customerId: z.string().uuid(),
    });

    const data = convertSchema.parse(req.body);
    const result = await quoteService.convertQuoteToLicense(req.params.id, data.customerId);

    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({
      success: true,
      licenseId: result.licenseId,
      licenseKey: result.licenseKey,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    logger.error('Convert quote error:', error);
    res.status(500).json({ error: 'Failed to convert quote' });
  }
});

// Duplicate quote
router.post('/quotes/:id/duplicate', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const quote = await quoteService.duplicateQuote(req.params.id);
    res.status(201).json(quote);
  } catch (error) {
    if (error instanceof Error && error.message === 'Quote not found') {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }
    logger.error('Duplicate quote error:', error);
    res.status(500).json({ error: 'Failed to duplicate quote' });
  }
});

// Customer routes
router.get('/customers', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const customers = await customerService.listCustomers();
    res.json(customers);
  } catch (error) {
    logger.error('List customers error:', error);
    res.status(500).json({ error: 'Failed to list customers' });
  }
});

router.get('/customers/:id', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const customer = await customerService.getCustomerById(req.params.id);
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }
    res.json(customer);
  } catch (error) {
    logger.error('Get customer error:', error);
    res.status(500).json({ error: 'Failed to get customer' });
  }
});

router.get('/customers/:id/licenses', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const licenses = await licenseService.getLicensesByCustomerId(req.params.id);
    res.json(licenses);
  } catch (error) {
    logger.error('Get customer licenses error:', error);
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
      totalRefunds,
    ] = await Promise.all([
      prisma.customer.count(),
      prisma.product.count(),
      prisma.license.count(),
      prisma.license.count({ where: { status: 'ACTIVE' } }),
      prisma.subscription.count({ where: { status: 'ACTIVE' } }),
      prisma.refund.count(),
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
      totalRefunds,
      recentLicenses,
    });
  } catch (error) {
    logger.error('Get dashboard stats error:', error);
    res.status(500).json({ error: 'Failed to get dashboard stats' });
  }
});

// ============================================================================
// USAGE-BASED BILLING (METERED)
// ============================================================================

// Report usage for a subscription (admin can report on behalf of customers)
router.post('/subscriptions/:id/usage', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reportUsageSchema = z.object({
      quantity: z.number().positive(),
      action: z.enum(['increment', 'set']).optional(),
      timestamp: z.string().datetime().optional(),
      idempotencyKey: z.string().optional(),
      metadata: z.record(z.string()).optional(),
    });

    const data = reportUsageSchema.parse(req.body);

    const result = await paymentService.reportUsage({
      subscriptionId: req.params.id,
      quantity: data.quantity,
      action: data.action,
      timestamp: data.timestamp ? new Date(data.timestamp) : undefined,
      idempotencyKey: data.idempotencyKey,
      metadata: data.metadata,
    });

    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ success: true, usageRecordId: result.usageRecordId });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    logger.error('Report usage error:', error);
    res.status(500).json({ error: 'Failed to report usage' });
  }
});

// Get usage summary for a subscription
router.get('/subscriptions/:id/usage', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const summary = await paymentService.getUsageSummary(req.params.id);
    if (!summary) {
      res.status(404).json({ error: 'Subscription not found or not metered' });
      return;
    }
    res.json(summary);
  } catch (error) {
    logger.error('Get usage summary error:', error);
    res.status(500).json({ error: 'Failed to get usage summary' });
  }
});

// Get usage records for a subscription
router.get('/subscriptions/:id/usage/records', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const records = await paymentService.getUsageRecords(req.params.id, {
      startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
      endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
      limit: req.query.limit ? parsePositiveInt(req.query.limit as string, 100, 1000) : undefined,
    });
    res.json(records);
  } catch (error) {
    logger.error('Get usage records error:', error);
    res.status(500).json({ error: 'Failed to get usage records' });
  }
});

// ============================================================================
// METERED PRICING
// ============================================================================

// Create metered price for existing product
router.post('/products/:id/metered-price', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const meteredPriceSchema = z.object({
      unitAmount: z.number().positive(),
      currency: z.string().optional(),
      interval: z.enum(['month', 'year']).optional(),
      aggregateUsage: z.enum(['sum', 'last_during_period', 'last_ever', 'max']).optional(),
      taxBehavior: z.enum(['exclusive', 'inclusive', 'unspecified']).optional(),
    });

    const data = meteredPriceSchema.parse(req.body);

    const product = await productService.createMeteredPrice(req.params.id, data);
    res.json(product);
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
      if (error.message.includes('Stripe')) {
        res.status(400).json({ error: error.message });
        return;
      }
    }
    logger.error('Create metered price error:', error);
    res.status(500).json({ error: 'Failed to create metered price' });
  }
});

// ============================================================================
// TAX CONFIGURATION
// ============================================================================

// Get common tax codes
router.get('/tax/codes', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const taxCodes = productService.getCommonTaxCodes();
    res.json(taxCodes);
  } catch (error) {
    logger.error('Get tax codes error:', error);
    res.status(500).json({ error: 'Failed to get tax codes' });
  }
});

// Update product tax code
router.put('/products/:id/tax-code', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const taxCodeSchema = z.object({
      taxCode: z.string().min(1),
    });

    const data = taxCodeSchema.parse(req.body);

    const product = await productService.updateProductTaxCode(req.params.id, data.taxCode);
    res.json(product);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    if (error instanceof Error && error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
      return;
    }
    logger.error('Update tax code error:', error);
    res.status(500).json({ error: 'Failed to update tax code' });
  }
});

// Get Stripe pricing info for product
router.get('/products/:id/pricing', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const pricing = await productService.getStripePricingInfo(req.params.id);
    if (!pricing) {
      res.status(404).json({ error: 'Product not found or no Stripe price configured' });
      return;
    }
    res.json(pricing);
  } catch (error) {
    logger.error('Get pricing info error:', error);
    res.status(500).json({ error: 'Failed to get pricing info' });
  }
});

// ============================================================================
// SUBSCRIPTIONS
// ============================================================================

// List all subscriptions
router.get('/subscriptions', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const subscriptions = await prisma.subscription.findMany({
      where: req.query.status ? { status: req.query.status as 'ACTIVE' | 'CANCELED' | 'PAST_DUE' } : undefined,
      include: {
        customer: { select: { id: true, email: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(subscriptions);
  } catch (error) {
    logger.error('List subscriptions error:', error);
    res.status(500).json({ error: 'Failed to list subscriptions' });
  }
});

// Get subscription by ID
router.get('/subscriptions/:id', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const subscription = await prisma.subscription.findUnique({
      where: { id: req.params.id },
      include: {
        customer: { select: { id: true, email: true, name: true } },
        usageRecords: {
          orderBy: { timestamp: 'desc' },
          take: 20,
        },
      },
    });

    if (!subscription) {
      res.status(404).json({ error: 'Subscription not found' });
      return;
    }

    res.json(subscription);
  } catch (error) {
    logger.error('Get subscription error:', error);
    res.status(500).json({ error: 'Failed to get subscription' });
  }
});

// ============================================================================
// REFUNDS
// ============================================================================

// List all refunds
router.get('/refunds', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const refunds = await prisma.refund.findMany({
      where: req.query.customerId ? { customerId: req.query.customerId as string } : undefined,
      include: {
        customer: { select: { id: true, email: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(refunds);
  } catch (error) {
    logger.error('List refunds error:', error);
    res.status(500).json({ error: 'Failed to list refunds' });
  }
});

// ============================================================================
// COUPONS & PROMOTION CODES
// ============================================================================

// Create a coupon
router.post('/coupons', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const createCouponSchema = z.object({
      name: z.string().min(1),
      percentOff: z.number().min(1).max(100).optional(),
      amountOff: z.number().positive().optional(),
      currency: z.string().optional(),
      duration: z.enum(['once', 'repeating', 'forever']),
      durationInMonths: z.number().positive().optional(),
      maxRedemptions: z.number().positive().optional(),
      redeemBy: z.string().datetime().optional(),
      appliesTo: z.array(z.string()).optional(),
    }).refine(
      data => data.percentOff || data.amountOff,
      { message: 'Either percentOff or amountOff must be provided' }
    );

    const data = createCouponSchema.parse(req.body);

    const coupon = await paymentService.createCoupon({
      ...data,
      redeemBy: data.redeemBy ? new Date(data.redeemBy) : undefined,
    });

    res.status(201).json(coupon);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    logger.error('Create coupon error:', error);
    res.status(500).json({ error: 'Failed to create coupon' });
  }
});

// List coupons
router.get('/coupons', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const coupons = await paymentService.listCoupons({
      limit: req.query.limit ? parsePositiveInt(req.query.limit as string, 25, 100) : undefined,
      startingAfter: req.query.startingAfter as string | undefined,
    });
    res.json(coupons);
  } catch (error) {
    logger.error('List coupons error:', error);
    res.status(500).json({ error: 'Failed to list coupons' });
  }
});

// Get coupon by ID
router.get('/coupons/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const coupon = await paymentService.getCoupon(req.params.id);
    res.json(coupon);
  } catch (error) {
    logger.error('Get coupon error:', error);
    res.status(500).json({ error: 'Failed to get coupon' });
  }
});

// Update coupon
router.put('/coupons/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const updateCouponSchema = z.object({
      name: z.string().min(1).optional(),
      metadata: z.record(z.string()).optional(),
    });

    const data = updateCouponSchema.parse(req.body);
    const coupon = await paymentService.updateCoupon(req.params.id, data);
    res.json(coupon);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    logger.error('Update coupon error:', error);
    res.status(500).json({ error: 'Failed to update coupon' });
  }
});

// Delete coupon
router.delete('/coupons/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    await paymentService.deleteCoupon(req.params.id);
    res.status(204).send();
  } catch (error) {
    logger.error('Delete coupon error:', error);
    res.status(500).json({ error: 'Failed to delete coupon' });
  }
});

// Create promotion code
router.post('/promotion-codes', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const createPromoCodeSchema = z.object({
      couponId: z.string().min(1),
      code: z.string().min(3).max(50).regex(/^[A-Z0-9_-]+$/i, 'Code must contain only letters, numbers, underscores, and hyphens'),
      maxRedemptions: z.number().positive().optional(),
      expiresAt: z.string().datetime().optional(),
      firstTimeTransaction: z.boolean().optional(),
      minimumAmount: z.number().positive().optional(),
      minimumAmountCurrency: z.string().optional(),
    });

    const data = createPromoCodeSchema.parse(req.body);

    const promoCode = await paymentService.createPromotionCode({
      ...data,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
    });

    res.status(201).json(promoCode);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    logger.error('Create promotion code error:', error);
    res.status(500).json({ error: 'Failed to create promotion code' });
  }
});

// List promotion codes
router.get('/promotion-codes', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const promoCodes = await paymentService.listPromotionCodes({
      couponId: req.query.couponId as string | undefined,
      active: req.query.active === 'true' ? true : req.query.active === 'false' ? false : undefined,
      limit: req.query.limit ? parsePositiveInt(req.query.limit as string, 25, 100) : undefined,
      startingAfter: req.query.startingAfter as string | undefined,
    });
    res.json(promoCodes);
  } catch (error) {
    logger.error('List promotion codes error:', error);
    res.status(500).json({ error: 'Failed to list promotion codes' });
  }
});

// Get promotion code by ID
router.get('/promotion-codes/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const promoCode = await paymentService.getPromotionCode(req.params.id);
    res.json(promoCode);
  } catch (error) {
    logger.error('Get promotion code error:', error);
    res.status(500).json({ error: 'Failed to get promotion code' });
  }
});

// Update promotion code (activate/deactivate)
router.put('/promotion-codes/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const updatePromoCodeSchema = z.object({
      active: z.boolean().optional(),
      metadata: z.record(z.string()).optional(),
    });

    const data = updatePromoCodeSchema.parse(req.body);
    const promoCode = await paymentService.updatePromotionCode(req.params.id, data);
    res.json(promoCode);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    logger.error('Update promotion code error:', error);
    res.status(500).json({ error: 'Failed to update promotion code' });
  }
});

// Validate a promotion code (public endpoint check)
router.get('/promotion-codes/validate/:code', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await paymentService.validatePromotionCode(req.params.code);
    res.json(result);
  } catch (error) {
    logger.error('Validate promotion code error:', error);
    res.status(500).json({ error: 'Failed to validate promotion code' });
  }
});

// ============================================================================
// FILE UPLOAD & BUNDLE MANAGEMENT
// ============================================================================

// Upload a bundle file for a product
router.post(
  '/products/:id/upload',
  validateIdParam,
  upload.single('file'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!storageService.isS3Configured()) {
        res.status(400).json({ error: 'S3 storage is not configured' });
        return;
      }

      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      // Get the product
      const product = await productService.getProductById(req.params.id);
      if (!product) {
        res.status(404).json({ error: 'Product not found' });
        return;
      }

      // Get version from body or use current product version
      const version = req.body.version || product.version || undefined;

      // Generate the S3 key
      const key = storageService.generateProductFileKey(
        product.category || 'products',
        product.name,
        file.originalname,
        version
      );

      // Upload to S3
      const result = await storageService.uploadFile(
        key,
        file.buffer,
        file.mimetype
      );

      // Optionally set as active bundle if requested
      if (req.body.setActive === 'true') {
        await productService.updateProduct(req.params.id, {
          s3PackageKey: key,
          version: version || undefined,
        });
      }

      res.status(201).json({
        key: result.key,
        size: result.size,
        contentType: result.contentType,
        filename: file.originalname,
        setActive: req.body.setActive === 'true',
      });
    } catch (error) {
      logger.error('Upload bundle error:', error);
      if (error instanceof Error && error.message.includes('File type not allowed')) {
        res.status(400).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: 'Failed to upload file' });
    }
  }
);

// List all bundles for a product
router.get('/products/:id/bundles', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!storageService.isS3Configured()) {
      res.json({ bundles: [], s3Configured: false });
      return;
    }

    const product = await productService.getProductById(req.params.id);
    if (!product) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    // Get the prefix for this product's bundles
    const prefix = storageService.getProductBundlePrefix(
      product.category || 'products',
      product.name
    );

    // List files in the prefix
    const bundles = await storageService.listFiles(prefix);

    // Mark the active bundle
    const bundlesWithActive = bundles.map((bundle) => ({
      ...bundle,
      isActive: bundle.key === product.s3PackageKey,
      sizeFormatted: formatFileSize(bundle.size),
    }));

    res.json({
      bundles: bundlesWithActive,
      activeKey: product.s3PackageKey,
      s3Configured: true,
    });
  } catch (error) {
    logger.error('List bundles error:', error);
    res.status(500).json({ error: 'Failed to list bundles' });
  }
});

// Set active bundle for a product
router.put('/products/:id/bundle', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const setBundleSchema = z.object({
      s3PackageKey: z.string().min(1),
      version: z.string().optional(),
    });

    const data = setBundleSchema.parse(req.body);

    // Verify the file exists
    const exists = await storageService.checkFileExists(data.s3PackageKey);
    if (!exists) {
      res.status(400).json({ error: 'Bundle file does not exist in storage' });
      return;
    }

    // Update the product
    const product = await productService.updateProduct(req.params.id, {
      s3PackageKey: data.s3PackageKey,
      version: data.version,
    });

    res.json(product);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: error.errors });
      return;
    }
    logger.error('Set bundle error:', error);
    res.status(500).json({ error: 'Failed to set active bundle' });
  }
});

// Delete a bundle file
router.delete('/products/:id/bundles/:key(*)', validateIdParam, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const product = await productService.getProductById(req.params.id);
    if (!product) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    const key = req.params.key;

    // Don't allow deleting the active bundle
    if (key === product.s3PackageKey) {
      res.status(400).json({ error: 'Cannot delete the active bundle. Set a different active bundle first.' });
      return;
    }

    const deleted = await storageService.deleteFile(key);
    if (!deleted) {
      res.status(500).json({ error: 'Failed to delete bundle' });
      return;
    }

    res.status(204).send();
  } catch (error) {
    logger.error('Delete bundle error:', error);
    res.status(500).json({ error: 'Failed to delete bundle' });
  }
});

// Agent certificate management (mTLS) — admin-only.
router.get('/agents/certificates', authenticate, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = parsePositiveInt(req.query.limit as string | undefined, 100, 500);
    const certs = await prisma.agentCertificate.findMany({
      orderBy: { issuedAt: 'desc' },
      take: limit,
    });
    res.json({ certificates: certs });
  } catch (error) {
    logger.error('List agent certificates error:', error);
    res.status(500).json({ error: 'List failed' });
  }
});

router.post('/agents/certificates/:serial/revoke', authenticate, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!isMtlsCaEnabled()) {
      res.status(503).json({ error: 'mTLS agent CA is disabled on this deployment' });
      return;
    }
    const serial = sanitizeString(req.params.serial, 64);
    const reason = sanitizeString(typeof req.body?.reason === 'string' ? req.body.reason : '', 256);
    const result = await crlService.revokeAgentCertificate(serial, reason || undefined);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Revoke agent cert error:', error);
    if ((error as { code?: string }).code === 'P2025') {
      res.status(404).json({ error: 'Certificate not found' });
      return;
    }
    res.status(500).json({ error: 'Revocation failed' });
  }
});

// Helper function to format file size
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  if (bytes < 0) return 'Invalid size';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  // Ensure index doesn't exceed array bounds
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export default router;
