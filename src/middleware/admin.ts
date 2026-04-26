import { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import * as adminCognito from '../services/adminCognito.service.js';

/**
 * Require an authenticated admin. When the token came from Cognito (i.e.
 * AUTH_PROVIDER=cognito), the token must:
 *   - originate from the staff pool (`pool === 'staff'`)
 *   - be for a user with `PreferredMfaSetting=SOFTWARE_TOKEN_MFA` (i.e. TOTP
 *     was enforced and therefore completed in this auth session — Cognito
 *     refuses to issue tokens for these users without a TOTP code).
 *
 * Cognito does not emit the `amr` claim for direct user-pool flows
 * (`AdminInitiateAuth` / `AdminRespondToAuthChallenge`), so we can't rely on
 * `req.user.mfaAuthenticated`. Instead we look up `PreferredMfaSetting` via
 * `AdminGetUser` (cached for 5 min in memory).
 *
 * Set `ADMIN_REQUIRE_MFA=false` only for local dev to skip the MFA check.
 *
 * For the legacy local-JWT provider, no Cognito-side MFA exists; admin
 * status is granted by the `customers.is_admin` flag on the local row.
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

  if (!usingCognito) {
    next();
    return;
  }

  if (req.user.pool !== 'staff') {
    res.status(403).json({ error: 'Admin token must originate from the staff pool' });
    return;
  }

  if (!enforceMfa) {
    next();
    return;
  }

  // Async MFA check via cached AdminGetUser.
  adminCognito
    .hasTotpEnforced(req.user.email)
    .then((ok) => {
      if (!ok) {
        res.status(403).json({
          error: 'MFA required for admin actions',
          code: 'ADMIN_MFA_REQUIRED',
        });
        return;
      }
      next();
    })
    .catch(next);
}
