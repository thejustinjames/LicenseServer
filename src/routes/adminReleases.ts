/**
 * Admin Releases API Routes
 * CRUD operations for software releases (update notifications)
 *
 * Copyright (c) 2026 Agencio. All rights reserved.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { logger } from '../services/logger.service.js';

const router = Router();

// Schema for release creation/update
const releaseSchema = z.object({
  productSlug: z.string().min(1).max(50),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/, 'Invalid version format'),
  releaseDate: z.string().datetime().optional(),
  releaseNotes: z.string().optional(),
  downloadUrl: z.string().url().optional().or(z.literal('')),
  minVersion: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/).optional().or(z.literal('')),
  isCritical: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

/**
 * GET /api/admin/releases
 * List all releases, optionally filtered by product
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { productSlug, activeOnly } = req.query;

    const where: any = {};
    if (productSlug) {
      where.productSlug = productSlug;
    }
    if (activeOnly === 'true') {
      where.isActive = true;
    }

    const releases = await prisma.release.findMany({
      where,
      orderBy: [
        { productSlug: 'asc' },
        { releaseDate: 'desc' },
      ],
    });

    res.json(releases);
  } catch (error) {
    logger.error('Failed to list releases:', error);
    res.status(500).json({ error: 'Failed to list releases' });
  }
});

/**
 * GET /api/admin/releases/products
 * Get list of unique product slugs
 */
router.get('/products', async (_req: Request, res: Response) => {
  try {
    const products = await prisma.release.findMany({
      select: { productSlug: true },
      distinct: ['productSlug'],
      orderBy: { productSlug: 'asc' },
    });

    // Add known products that might not have releases yet
    const knownProducts = ['k8inspector', 'silo', 'agencio-predict'];
    const existingSlugs = products.map(p => p.productSlug);
    const allProducts = Array.from(new Set([...existingSlugs, ...knownProducts])).sort();

    res.json(allProducts);
  } catch (error) {
    logger.error('Failed to list product slugs:', error);
    res.status(500).json({ error: 'Failed to list products' });
  }
});

/**
 * GET /api/admin/releases/:id
 * Get a specific release
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const release = await prisma.release.findUnique({
      where: { id: req.params.id },
    });

    if (!release) {
      res.status(404).json({ error: 'Release not found' });
      return;
    }

    res.json(release);
  } catch (error) {
    logger.error('Failed to get release:', error);
    res.status(500).json({ error: 'Failed to get release' });
  }
});

/**
 * POST /api/admin/releases
 * Create a new release
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const data = releaseSchema.parse(req.body);

    // If this is marked as active, deactivate other releases for same product
    if (data.isActive) {
      await prisma.release.updateMany({
        where: { productSlug: data.productSlug, isActive: true },
        data: { isActive: false },
      });
    }

    const release = await prisma.release.create({
      data: {
        productSlug: data.productSlug,
        version: data.version,
        releaseDate: data.releaseDate ? new Date(data.releaseDate) : new Date(),
        releaseNotes: data.releaseNotes || null,
        downloadUrl: data.downloadUrl || null,
        minVersion: data.minVersion || null,
        isCritical: data.isCritical || false,
        isActive: data.isActive ?? true,
        createdBy: (req as any).user?.id || null,
      },
    });

    logger.info('Release created', {
      releaseId: release.id,
      productSlug: release.productSlug,
      version: release.version,
    });

    res.status(201).json(release);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', details: error.errors });
      return;
    }
    // Handle unique constraint violation
    if ((error as any).code === 'P2002') {
      res.status(409).json({ error: 'A release with this version already exists for this product' });
      return;
    }
    logger.error('Failed to create release:', error);
    res.status(500).json({ error: 'Failed to create release' });
  }
});

/**
 * PUT /api/admin/releases/:id
 * Update an existing release
 */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const data = releaseSchema.partial().parse(req.body);

    // Check release exists
    const existing = await prisma.release.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      res.status(404).json({ error: 'Release not found' });
      return;
    }

    // If setting as active, deactivate others for same product
    if (data.isActive && !existing.isActive) {
      await prisma.release.updateMany({
        where: { productSlug: existing.productSlug, isActive: true },
        data: { isActive: false },
      });
    }

    const release = await prisma.release.update({
      where: { id: req.params.id },
      data: {
        ...(data.productSlug && { productSlug: data.productSlug }),
        ...(data.version && { version: data.version }),
        ...(data.releaseDate && { releaseDate: new Date(data.releaseDate) }),
        ...(data.releaseNotes !== undefined && { releaseNotes: data.releaseNotes || null }),
        ...(data.downloadUrl !== undefined && { downloadUrl: data.downloadUrl || null }),
        ...(data.minVersion !== undefined && { minVersion: data.minVersion || null }),
        ...(data.isCritical !== undefined && { isCritical: data.isCritical }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
    });

    logger.info('Release updated', {
      releaseId: release.id,
      productSlug: release.productSlug,
      version: release.version,
    });

    res.json(release);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', details: error.errors });
      return;
    }
    if ((error as any).code === 'P2002') {
      res.status(409).json({ error: 'A release with this version already exists for this product' });
      return;
    }
    logger.error('Failed to update release:', error);
    res.status(500).json({ error: 'Failed to update release' });
  }
});

/**
 * DELETE /api/admin/releases/:id
 * Delete a release
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const release = await prisma.release.findUnique({
      where: { id: req.params.id },
    });

    if (!release) {
      res.status(404).json({ error: 'Release not found' });
      return;
    }

    await prisma.release.delete({
      where: { id: req.params.id },
    });

    logger.info('Release deleted', {
      releaseId: release.id,
      productSlug: release.productSlug,
      version: release.version,
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete release:', error);
    res.status(500).json({ error: 'Failed to delete release' });
  }
});

/**
 * POST /api/admin/releases/:id/activate
 * Set a release as the active release for its product
 */
router.post('/:id/activate', async (req: Request, res: Response) => {
  try {
    const release = await prisma.release.findUnique({
      where: { id: req.params.id },
    });

    if (!release) {
      res.status(404).json({ error: 'Release not found' });
      return;
    }

    // Deactivate all other releases for this product
    await prisma.release.updateMany({
      where: { productSlug: release.productSlug, isActive: true },
      data: { isActive: false },
    });

    // Activate this release
    const updated = await prisma.release.update({
      where: { id: req.params.id },
      data: { isActive: true },
    });

    logger.info('Release activated', {
      releaseId: release.id,
      productSlug: release.productSlug,
      version: release.version,
    });

    res.json(updated);
  } catch (error) {
    logger.error('Failed to activate release:', error);
    res.status(500).json({ error: 'Failed to activate release' });
  }
});

export default router;
