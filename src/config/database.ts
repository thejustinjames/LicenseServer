import { PrismaClient } from '@prisma/client';
import { logger } from '../services/logger.service.js';

/**
 * Prisma Client with connection pool configuration.
 *
 * Connection pool settings are configured via DATABASE_URL query parameters:
 * - connection_limit: Max connections in pool (default: 5 per query engine)
 * - pool_timeout: Timeout waiting for connection (default: 10s)
 * - connect_timeout: Timeout establishing connection (default: 5s)
 *
 * Example: postgresql://user:pass@host:5432/db?connection_limit=10&pool_timeout=20
 *
 * For production workloads, consider:
 * - connection_limit: (num_cpus * 2) + 1 is a good starting point
 * - pool_timeout: 10-30 seconds depending on query complexity
 */
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development'
    ? [
        { emit: 'event', level: 'query' },
        { emit: 'stdout', level: 'error' },
        { emit: 'stdout', level: 'warn' },
      ]
    : [{ emit: 'stdout', level: 'error' }],
});

// Log slow queries in development
if (process.env.NODE_ENV === 'development') {
  prisma.$on('query' as never, (e: { duration: number; query: string }) => {
    if (e.duration > 100) {
      logger.warn('Slow query detected', {
        duration: e.duration,
        query: e.query.substring(0, 200),
      });
    }
  });
}

export async function connectDatabase() {
  try {
    await prisma.$connect();
    logger.info('Database connected successfully');
  } catch (error) {
    logger.error('Failed to connect to database:', error);
    process.exit(1);
  }
}

export async function disconnectDatabase() {
  await prisma.$disconnect();
}
