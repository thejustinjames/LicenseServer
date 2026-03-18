import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config/index.js';
import { connectDatabase, disconnectDatabase, prisma } from './config/database.js';
import { ensureAdminExists } from './services/customer.service.js';
import { getCorsConfig, isCorsEnabled } from './config/cors.js';
import { initializeAuthProvider } from './auth/index.js';
import { initializeConfigProvider } from './config/providers/index.js';
import { initializeEmailService } from './services/email.service.js';
import { initializeRedis, closeRedis, isRedisAvailable } from './config/redis.js';
import { logger, generateRequestId } from './services/logger.service.js';

import adminRoutes from './routes/admin.js';
import portalRoutes from './routes/portal.js';
import validationRoutes from './routes/validation.js';
import webhookRoutes from './routes/webhooks.js';
import desktopRoutes from './routes/desktop.js';

const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://js.hcaptcha.com", "https://hcaptcha.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://checkout.stripe.com", "https://api.stripe.com", "https://hcaptcha.com", "https://*.hcaptcha.com"],
      frameSrc: ["'self'", "https://checkout.stripe.com", "https://js.stripe.com", "https://hcaptcha.com", "https://*.hcaptcha.com"],
    },
  },
}));

// Configurable CORS
if (isCorsEnabled()) {
  app.use(cors(getCorsConfig()));
}

// Cookie parser for httpOnly auth cookies
app.use(cookieParser());

// Request ID for correlation
app.use((req, _res, next) => {
  req.headers['x-request-id'] = req.headers['x-request-id'] || generateRequestId();
  next();
});

// Stripe webhooks need raw body
app.use('/webhooks', express.raw({ type: 'application/json' }));

// JSON parsing for all other routes
app.use(express.json());

// Routes
app.use('/api/admin', adminRoutes);
app.use('/api/portal', portalRoutes);
app.use('/api/v1', validationRoutes);
app.use('/api/v1/desktop', desktopRoutes);
app.use('/webhooks', webhookRoutes);

// Serve static frontend
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath));

// API info endpoint
app.get('/api', (_req, res) => {
  res.json({
    name: 'License Server API',
    version: '1.0.0',
    endpoints: {
      admin: '/api/admin',
      portal: '/api/portal',
      validation: '/api/v1',
      desktop: '/api/v1/desktop',
      webhooks: '/webhooks/stripe',
      health: '/health',
      ready: '/health/ready',
    },
  });
});

// Health check - Liveness probe
// Returns OK if the server is running
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// Liveness alias
app.get('/health/live', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// Readiness probe - checks if dependencies are available
// Returns OK only if the server can handle traffic
app.get('/health/ready', async (_req, res) => {
  const checks: Record<string, { status: string; latency?: number; error?: string }> = {};
  let isReady = true;

  // Check database connection
  const dbStart = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = {
      status: 'ok',
      latency: Date.now() - dbStart,
    };
  } catch (error) {
    isReady = false;
    checks.database = {
      status: 'error',
      latency: Date.now() - dbStart,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Optional: Check AWS connectivity if using AWS services
  if (config.S3_BUCKET_NAME) {
    const s3Start = Date.now();
    try {
      const { s3Client } = await import('./config/s3.js');
      const { HeadBucketCommand } = await import('@aws-sdk/client-s3');
      await s3Client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET_NAME }));
      checks.s3 = {
        status: 'ok',
        latency: Date.now() - s3Start,
      };
    } catch (error) {
      // S3 check is informational, don't fail readiness
      checks.s3 = {
        status: 'degraded',
        latency: Date.now() - s3Start,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  const statusCode = isReady ? 200 : 503;
  res.status(statusCode).json({
    status: isReady ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    checks,
  });
});

// SPA catch-all route - serve index.html for any non-API routes
// This must come AFTER static middleware and API routes, but BEFORE 404 handler
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// 404 handler (for POST/PUT/DELETE to unknown routes)
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down...');
  await closeRedis();
  await disconnectDatabase();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
async function start() {
  try {
    // Initialize config provider (supports env, secrets-manager, kubernetes)
    await initializeConfigProvider();

    // Initialize auth provider (supports jwt, cognito)
    await initializeAuthProvider();

    // Initialize Redis (optional, for distributed rate limiting and token blacklist)
    await initializeRedis();

    // Initialize email service (Microsoft Graph / Office 365)
    initializeEmailService();

    await connectDatabase();
    await ensureAdminExists();

    const port = parseInt(config.PORT, 10);
    app.listen(port, () => {
      logger.info('License Server started', {
        port,
        environment: config.NODE_ENV,
        configProvider: process.env.CONFIG_PROVIDER || 'env',
        authProvider: process.env.AUTH_PROVIDER || 'jwt',
        redisEnabled: isRedisAvailable(),
      });
    });
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
}

start();
