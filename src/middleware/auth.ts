/**
 * Authentication Middleware
 *
 * Re-exports the authentication middleware from the auth provider system.
 * This maintains backward compatibility while enabling multiple auth providers.
 */

export { authenticate, optionalAuth } from '../auth/index.js';
