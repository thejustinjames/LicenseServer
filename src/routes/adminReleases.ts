/**
 * Admin Releases API Routes
 * CRUD operations for software releases (update notifications)
 *
 * Copyright (c) 2026 Agencio. All rights reserved.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { logger } from '../services/logger.service.js';
import crypto from 'crypto';
import express from 'express';
import { manifestOf, signManifest } from '../services/release.service.js';
import { uploadFile, isS3Configured } from '../services/storage.service.js';

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
  channel: z.string().regex(/^[a-z0-9-]{2,20}$/).optional(),
  imageRef: z.string().max(200).optional().or(z.literal('')),
});

/** The signature over the manifest for a row as it is about to be stored. */
function signatureFor(row: Parameters<typeof manifestOf>[0]): string | null {
  return signManifest(manifestOf(row));
}

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

    // A release is active unless told otherwise, and an active release stands alone on its
    // product's channel: the others there are deactivated.
    const channel = data.channel || 'stable';
    if (data.isActive ?? true) {
      await prisma.release.updateMany({
        where: { productSlug: data.productSlug, channel, isActive: true },
        data: { isActive: false },
      });
    }
    const row = {
      productSlug: data.productSlug,
      channel,
      version: data.version,
      releaseDate: data.releaseDate ? new Date(data.releaseDate) : new Date(),
      releaseNotes: data.releaseNotes || null,
      downloadUrl: data.downloadUrl || null,
      minVersion: data.minVersion || null,
      isCritical: data.isCritical || false,
      isActive: data.isActive ?? true,
      imageRef: data.imageRef || null,
      artifactKey: null as string | null, artifactSize: null as number | null, artifactSha256: null as string | null,
      createdBy: (req as any).user?.id || null,
    };
    const release = await prisma.release.create({ data: { ...row, signature: signatureFor(row) } });

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

    // If the release is active once updated, it stands alone on its product's channel as the
    // update leaves them (a move to another channel or product takes the active slot there).
    const productSlug = data.productSlug || existing.productSlug;
    const channel = data.channel || existing.channel;
    if (data.isActive ?? existing.isActive) {
      await prisma.release.updateMany({
        where: { productSlug, channel, isActive: true, id: { not: existing.id } },
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
        ...(data.channel && { channel: data.channel }),
        ...(data.imageRef !== undefined && { imageRef: data.imageRef || null }),
      },
    });

    logger.info('Release updated', {
      releaseId: release.id,
      productSlug: release.productSlug,
      version: release.version,
    });

    const signed = await prisma.release.update({ where: { id: release.id }, data: { signature: signatureFor(release) } });
    res.json(signed);
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
      where: { productSlug: release.productSlug, channel: release.channel, isActive: true },
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

/**
 * PUT /api/admin/releases/:id/artifact?filename=<name>
 *
 * The release's artefact, as the raw request body (an image tarball, a package): stored in the
 * bundle store under releases/<product>/<filename>, its size and SHA-256 recorded, and the
 * manifest re-signed. Up to 1 GB.
 *
 * The body is buffered whole in memory (the hash and the store's upload both want the bytes), so
 * an upload costs the process its size in RAM while it runs; one at a time is the expectation.
 * A body over the limit is answered 413 here, as JSON, before any of that.
 */
const ARTIFACT_LIMIT = '1gb';
router.put('/:id/artifact', express.raw({ type: '*/*', limit: ARTIFACT_LIMIT }), (err: Error & { type?: string }, _req: Request, res: Response, next: NextFunction) => {
  if (err?.type === 'entity.too.large') { res.status(413).json({ error: `The artefact is larger than the ${ARTIFACT_LIMIT} limit` }); return; }
  next(err);
}, async (req: Request, res: Response) => {
  try {
    if (!isS3Configured()) { res.status(503).json({ error: 'The bundle store (S3) is not configured' }); return; }
    const release = await prisma.release.findUnique({ where: { id: req.params.id } });
    if (!release) { res.status(404).json({ error: 'Release not found' }); return; }
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) { res.status(400).json({ error: 'An artefact body is required' }); return; }
    const given = typeof req.query.filename === 'string' ? req.query.filename : '';
    const filename = (given || `${release.productSlug}-${release.version}.bin`).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120);
    const key = `releases/${release.productSlug}/${filename}`;
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    await uploadFile(key, body, (req.headers['content-type'] as string) || 'application/octet-stream');
    const row = { ...release, artifactKey: key, artifactSize: body.length, artifactSha256: sha256 };
    const updated = await prisma.release.update({ where: { id: release.id }, data: { artifactKey: key, artifactSize: body.length, artifactSha256: sha256, signature: signatureFor(row) } });
    logger.info('Release artefact stored', { releaseId: release.id, key, size: body.length });
    res.json(updated);
  } catch (error) {
    logger.error('Failed to store release artefact:', error);
    res.status(500).json({ error: 'Failed to store the artefact' });
  }
});

export default router;
