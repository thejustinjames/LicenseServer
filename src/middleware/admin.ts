import { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Require an authenticated admin. When the token came from Cognito (i.e.
 * AUTH_PROVIDER=cognito), the token must:
 *   - originate from the staff pool (`pool === 'staff'`)
 *   - prove MFA was used in this session (`amr` contains `mfa`/`totp_mfa`)
 * unless `ADMIN_REQUIRE_MFA=false` is set (escape hatch for local dev only).
 *
 * For the legacy local-JWT provider, no Cognito-side MFA exists; admin status
 * is granted by the `customers.is_admin` flag on the local row.
 */
export function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (!req.user.isAdmin) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  const usingCognito = (process.env.AUTH_PROVIDER || 'jwt') === 'cognito';
  const enforceMfa = process.env.ADMIN_REQUIRE_MFA !== 'false';

  if (usingCognito) {
    if (req.user.pool !== 'staff') {
      res.status(403).json({ error: 'Admin token must originate from the staff pool' });
      return;
    }
    if (enforceMfa && !req.user.mfaAuthenticated) {
      res.status(403).json({
        error: 'MFA required for admin actions',
        code: 'ADMIN_MFA_REQUIRED',
      });
      return;
    }
  }

  next();
}
