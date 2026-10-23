/**
 * The automation door — the admin API key instead of an admin's sign-in.
 *
 * The admin routes sign in a person (Cognito on the lab), which a script on a build host cannot
 * do. These few routes do what a release pipeline and an operator's one-paste need, with the
 * `x-api-key` the deployment routes already accept: issue a licence to a customer (created by
 * email when new), revoke one, and manage releases (the admin releases router as it is, including
 * the artefact upload). Nothing here reads a licence key back once issued except the issuing
 * answer itself, which the caller shows to the person who asked.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../config/database.js';
import { requireApiKey } from '../utils/apiKey.js';
import { logger } from '../services/logger.service.js';
import * as customerService from '../services/customer.service.js';
import * as licenseService from '../services/license.service.js';
import adminReleasesRoutes from './adminReleases.js';

const router = Router();
router.use(requireApiKey);

const issueSchema = z.object({
  customerEmail: z.string().email(),
  customerName: z.string().max(120).optional(),
  productSlug: z.string().regex(/^[a-z0-9-]{2,50}$/),
  expiresAt: z.string().datetime().optional(),
  /** Days from now, when `expiresAt` is not given (default 365). */
  days: z.number().int().positive().max(3650).optional(),
  maxActivations: z.number().int().positive().max(1000).optional(),
  enabledComponents: z.array(z.string()).optional(),
  /** A note kept in the licence's metadata (which machine it is for, say). */
  note: z.string().max(200).optional(),
});

/**
 * POST /api/automation/licences
 * Issue a licence for a product to a customer named by email (created when new, with a random
 * password: the portal is not how such a customer signs in). Answers the key ONCE.
 */
router.post('/licences', async (req: Request, res: Response) => {
  try {
    const data = issueSchema.parse(req.body);
    const product = await prisma.product.findUnique({ where: { slug: data.productSlug } });
    if (!product) { res.status(404).json({ error: `Product not found: ${data.productSlug}` }); return; }
    let customer = await customerService.getCustomerByEmail(data.customerEmail);
    if (!customer) {
      // No welcome email: the customer did not sign up and the password is not theirs to use.
      const created = await customerService.createCustomer({ email: data.customerEmail, name: data.customerName, password: crypto.randomBytes(24).toString('base64url'), skipNotifications: true });
      customer = await customerService.getCustomerByEmail(created.email);
      if (!customer) { res.status(500).json({ error: 'Customer could not be created' }); return; }
    }
    const expiresAt = data.expiresAt ? new Date(data.expiresAt) : new Date(Date.now() + (data.days ?? 365) * 86_400_000);
    const license = await licenseService.createLicense({
      customerId: customer.id, productId: product.id, expiresAt,
      maxActivations: data.maxActivations ?? 1,
      ...(data.enabledComponents ? { enabledComponents: data.enabledComponents } : {}),
      // notify: false keeps the key out of email: the first activation is not announced.
      metadata: { issuedBy: 'automation', issuedAt: new Date().toISOString(), notify: false, ...(data.note ? { note: data.note } : {}) },
    });
    logger.info('Licence issued by automation', { licenseId: license.id, productSlug: product.slug, customerId: customer.id });
    res.status(201).json({ id: license.id, key: license.key, product: product.name, productSlug: product.slug, customer: { id: customer.id, email: customer.email, name: customer.name }, expiresAt: license.expiresAt, maxActivations: license.maxActivations, components: license.enabledComponents.length ? license.enabledComponents : product.components });
  } catch (error) {
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'Validation error', details: error.errors }); return; }
    logger.error('Automation licence issue error:', error);
    res.status(500).json({ error: 'Failed to issue the licence' });
  }
});

/** GET /api/automation/licences?product=<slug> — the licences of a product, without their keys. */
router.get('/licences', async (req: Request, res: Response) => {
  try {
    const slug = typeof req.query.product === 'string' ? req.query.product : '';
    const where = slug ? { product: { slug } } : {};
    const rows = await prisma.license.findMany({ where, include: { customer: { select: { email: true, name: true } }, product: { select: { slug: true, name: true } }, activations: { select: { machineName: true, lastSeenAt: true } }, deployments: { select: { id: true, status: true, lastSeenAt: true, version: true } } }, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json(rows.map((l) => ({ id: l.id, product: l.product.slug, customer: l.customer.email, name: l.customer.name, status: l.status, expiresAt: l.expiresAt, maxActivations: l.maxActivations, activations: l.activations, deployments: l.deployments, metadata: l.metadata })));
  } catch (error) {
    logger.error('Automation licence list error:', error);
    res.status(500).json({ error: 'Failed to list licences' });
  }
});

/** POST /api/automation/licences/:id/revoke */
router.post('/licences/:id/revoke', async (req: Request, res: Response) => {
  try {
    const license = await licenseService.revokeLicense(req.params.id);
    res.json({ id: license.id, status: license.status });
  } catch (error) {
    logger.error('Automation licence revoke error:', error);
    res.status(500).json({ error: 'Failed to revoke the licence' });
  }
});

// Releases: the admin router as it is (create, update, activate, delete, the artefact upload).
router.use('/releases', adminReleasesRoutes);

export default router;
