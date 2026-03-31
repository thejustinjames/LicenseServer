import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
// LOG_LEVEL is validated by config schema, defaults to 'info'
const logLevel = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

// Create base logger
const baseLogger = pino({
  level: logLevel,
  ...(isProduction
    ? {
        // Production: JSON format for log aggregation
        formatters: {
          level: (label) => ({ level: label }),
        },
        // Redact sensitive fields
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'password',
            'passwordHash',
            'token',
            'secret',
            'apiKey',
            '*.password',
            '*.passwordHash',
            '*.token',
            '*.secret',
          ],
          remove: true,
        },
      }
    : {
        // Development: Pretty print
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      }),
});

// Request ID storage (for correlation)
let requestIdCounter = 0;
const requestIds = new Map<string, string>();

/**
 * Generate a unique request ID
 */
export function generateRequestId(): string {
  const timestamp = Date.now().toString(36);
  const counter = (++requestIdCounter).toString(36);
  return `${timestamp}-${counter}`;
}

/**
 * Create a child logger with context
 */
export function createLogger(context: string) {
  return baseLogger.child({ context });
}

/**
 * Main logger with context methods
 */
export const logger = {
  /**
   * Log info message
   */
  info(message: string, data?: Record<string, unknown>) {
    baseLogger.info(data || {}, message);
  },

  /**
   * Log warning message
   */
  warn(message: string, data?: Record<string, unknown>) {
    baseLogger.warn(data || {}, message);
  },

  /**
   * Log error message
   */
  error(message: string, error?: Error | unknown, data?: Record<string, unknown>) {
    const errorData: Record<string, unknown> = { ...data };
    if (error instanceof Error) {
      errorData.error = {
        name: error.name,
        message: error.message,
        stack: isProduction ? undefined : error.stack,
      };
    } else if (error) {
      errorData.error = String(error);
    }
    baseLogger.error(errorData, message);
  },

  /**
   * Log debug message
   */
  debug(message: string, data?: Record<string, unknown>) {
    baseLogger.debug(data || {}, message);
  },

  /**
   * Create a child logger with request context
   */
  withRequest(requestId: string, customerId?: string) {
    return {
      info: (message: string, data?: Record<string, unknown>) => {
        baseLogger.info({ requestId, customerId, ...data }, message);
      },
      warn: (message: string, data?: Record<string, unknown>) => {
        baseLogger.warn({ requestId, customerId, ...data }, message);
      },
      error: (message: string, error?: Error | unknown, data?: Record<string, unknown>) => {
        const errorData: Record<string, unknown> = { requestId, customerId, ...data };
        if (error instanceof Error) {
          errorData.error = {
            name: error.name,
            message: error.message,
            stack: isProduction ? undefined : error.stack,
          };
        } else if (error) {
          errorData.error = String(error);
        }
        baseLogger.error(errorData, message);
      },
      debug: (message: string, data?: Record<string, unknown>) => {
        baseLogger.debug({ requestId, customerId, ...data }, message);
      },
    };
  },

  /**
   * Log audit event (for security-relevant actions)
   */
  audit(action: string, data: {
    userId?: string;
    customerId?: string;
    resourceType?: string;
    resourceId?: string;
    success: boolean;
    details?: Record<string, unknown>;
  }) {
    baseLogger.info({
      audit: true,
      action,
      ...data,
    }, `AUDIT: ${action}`);
  },
};

export default logger;
