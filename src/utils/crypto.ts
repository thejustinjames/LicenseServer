import crypto from 'crypto';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { logger } from '../services/logger.service.js';
import type { OfflineLicensePayload } from '../types/index.js';

let privateKey: string | null = null;
let publicKey: string | null = null;

function loadKeys() {
  if (config.LICENSE_PRIVATE_KEY_PATH && config.LICENSE_PUBLIC_KEY_PATH) {
    try {
      privateKey = fs.readFileSync(config.LICENSE_PRIVATE_KEY_PATH, 'utf8');
      publicKey = fs.readFileSync(config.LICENSE_PUBLIC_KEY_PATH, 'utf8');
    } catch (error) {
      logger.warn('Could not load RSA keys for offline licensing', { error: String(error) });
    }
  }
}

loadKeys();

export function generateOfflineLicenseToken(payload: OfflineLicensePayload): string | null {
  if (!privateKey) {
    logger.warn('Private key not available for offline license generation');
    return null;
  }

  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    expiresIn: payload.expiresAt ? undefined : '10y',
  });
}

export function verifyOfflineLicenseToken(token: string): OfflineLicensePayload | null {
  if (!publicKey) {
    logger.warn('Public key not available for offline license verification');
    return null;
  }

  try {
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
    }) as OfflineLicensePayload;
    return decoded;
  } catch (error) {
    return null;
  }
}

export function getPublicKey(): string | null {
  return publicKey;
}

export function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const [salt, key] = hash.split(':');
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      resolve(crypto.timingSafeEqual(Buffer.from(key, 'hex'), derivedKey));
    });
  });
}

export function generateMachineFingerprint(components: string[]): string {
  return crypto
    .createHash('sha256')
    .update(components.join('|'))
    .digest('hex')
    .slice(0, 32);
}
