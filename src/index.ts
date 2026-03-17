import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config/index.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { ensureAdminExists } from './services/customer.service.js';

import adminRoutes from './routes/admin.js';
import portalRoutes from './routes/portal.js';
import validationRoutes from './routes/validation.js';
import webhookRoutes from './routes/webhooks.js';

const app = express();

// Security middleware
app.use(helmet());
app.use(cors());

// Stripe webhooks need raw body
app.use('/webhooks', express.raw({ type: 'application/json' }));

// JSON parsing for all other routes
app.use(express.json());

// Routes
app.use('/api/admin', adminRoutes);
app.use('/api/portal', portalRoutes);
app.use('/api/v1', validationRoutes);
app.use('/webhooks', webhookRoutes);

// Root endpoint
app.get('/', (_req, res) => {
  res.json({
    name: 'License Server',
    version: '1.0.0',
    endpoints: {
      admin: '/api/admin',
      portal: '/api/portal',
      validation: '/api/v1',
      webhooks: '/webhooks/stripe',
    },
  });
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
async function shutdown() {
  console.log('Shutting down...');
  await disconnectDatabase();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
async function start() {
  try {
    await connectDatabase();
    await ensureAdminExists();

    const port = parseInt(config.PORT, 10);
    app.listen(port, () => {
      console.log(`License Server running on port ${port}`);
      console.log(`Environment: ${config.NODE_ENV}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
