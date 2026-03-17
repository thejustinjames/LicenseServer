import { logger } from './logger.service.js';

const HCAPTCHA_VERIFY_URL = 'https://hcaptcha.com/siteverify';

interface HCaptchaResponse {
  success: boolean;
  'error-codes'?: string[];
  challenge_ts?: string;
  hostname?: string;
}

/**
 * Verify hCaptcha token
 * @param token The hCaptcha response token from the client
 * @returns true if verification passed, false otherwise
 */
export async function verifyCaptcha(token: string | undefined): Promise<boolean> {
  const secretKey = process.env.HCAPTCHA_SECRET_KEY;

  // If CAPTCHA is not configured, skip verification (for development)
  if (!secretKey) {
    logger.warn('CAPTCHA verification skipped - HCAPTCHA_SECRET_KEY not configured');
    return true;
  }

  if (!token) {
    logger.warn('CAPTCHA verification failed - no token provided');
    return false;
  }

  try {
    const formData = new URLSearchParams();
    formData.append('secret', secretKey);
    formData.append('response', token);

    const response = await fetch(HCAPTCHA_VERIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    const data = await response.json() as HCaptchaResponse;

    if (!data.success) {
      logger.warn('CAPTCHA verification failed', { errors: data['error-codes'] });
      return false;
    }

    logger.debug('CAPTCHA verification successful', {
      hostname: data.hostname,
      timestamp: data.challenge_ts
    });

    return true;
  } catch (error) {
    logger.error('CAPTCHA verification error', error);
    // Fail open in case of network errors (configurable)
    const failOpen = process.env.CAPTCHA_FAIL_OPEN === 'true';
    return failOpen;
  }
}

/**
 * Get the hCaptcha site key for frontend use
 */
export function getCaptchaSiteKey(): string | null {
  return process.env.HCAPTCHA_SITE_KEY || null;
}

/**
 * Check if CAPTCHA is enabled
 */
export function isCaptchaEnabled(): boolean {
  return !!(process.env.HCAPTCHA_SITE_KEY && process.env.HCAPTCHA_SECRET_KEY);
}
