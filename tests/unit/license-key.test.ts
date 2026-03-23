import { describe, it, expect } from 'vitest';
import {
  generateLicenseKey,
  validateLicenseKeyFormat,
  formatLicenseKey,
} from '../../src/utils/license-key.js';

describe('License Key Utilities', () => {
  describe('generateLicenseKey', () => {
    it('should generate a valid license key format', () => {
      const key = generateLicenseKey();

      // Should match pattern XXXX-XXXX-XXXX-XXXX
      expect(key).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    });

    it('should generate unique keys', () => {
      const keys = new Set<string>();
      for (let i = 0; i < 100; i++) {
        keys.add(generateLicenseKey());
      }

      // All 100 keys should be unique
      expect(keys.size).toBe(100);
    });

    it('should generate keys with valid checksums', () => {
      for (let i = 0; i < 10; i++) {
        const key = generateLicenseKey();
        expect(validateLicenseKeyFormat(key)).toBe(true);
      }
    });

    it('should not include ambiguous characters (0, 1, I, O)', () => {
      for (let i = 0; i < 50; i++) {
        const key = generateLicenseKey();
        expect(key).not.toMatch(/[01IO]/);
      }
    });
  });

  describe('validateLicenseKeyFormat', () => {
    it('should validate correctly formatted keys', () => {
      const key = generateLicenseKey();
      expect(validateLicenseKeyFormat(key)).toBe(true);
    });

    it('should reject keys with wrong format', () => {
      expect(validateLicenseKeyFormat('ABCD-EFGH-IJKL')).toBe(false);
      expect(validateLicenseKeyFormat('ABCDEFGHIJKLMNOP')).toBe(false);
      expect(validateLicenseKeyFormat('')).toBe(false);
      expect(validateLicenseKeyFormat('invalid')).toBe(false);
    });

    it('should reject keys with invalid format', () => {
      // Lowercase keys are rejected (regex requires uppercase)
      expect(validateLicenseKeyFormat('abcd-efgh-ijkl-mnop')).toBe(false);
      // Special characters are rejected
      expect(validateLicenseKeyFormat('ABCD-EFGH-IJKL-MN!@')).toBe(false);
    });

    it('should accept legacy keys with 0 or 1 (backward compatibility)', () => {
      // Keys with 0 or 1 are allowed for backward compatibility
      // These were created before the current checksum system
      expect(validateLicenseKeyFormat('ABCD-EFGH-IJKL-MN01')).toBe(true);
      expect(validateLicenseKeyFormat('1234-5678-90AB-CDEF')).toBe(true);
    });

    it('should reject keys with invalid checksum', () => {
      // Generate a valid key and modify the checksum
      const validKey = generateLicenseKey();
      const segments = validKey.split('-');
      segments[3] = 'XXXX'; // Invalid checksum
      const invalidKey = segments.join('-');

      expect(validateLicenseKeyFormat(invalidKey)).toBe(false);
    });

    it('should reject keys with modified content', () => {
      const validKey = generateLicenseKey();
      const segments = validKey.split('-');

      // Modify first segment
      const chars = segments[0].split('');
      chars[0] = chars[0] === 'A' ? 'B' : 'A';
      segments[0] = chars.join('');

      const modifiedKey = segments.join('-');
      expect(validateLicenseKeyFormat(modifiedKey)).toBe(false);
    });
  });

  describe('formatLicenseKey', () => {
    it('should format a raw key string', () => {
      const raw = 'ABCD2345EFGH6789';
      const formatted = formatLicenseKey(raw);
      expect(formatted).toBe('ABCD-2345-EFGH-6789');
    });

    it('should handle lowercase input', () => {
      const raw = 'abcd2345efgh6789';
      const formatted = formatLicenseKey(raw);
      expect(formatted).toBe('ABCD-2345-EFGH-6789');
    });

    it('should handle input with dashes', () => {
      const input = 'ABCD-2345-EFGH-6789';
      const formatted = formatLicenseKey(input);
      expect(formatted).toBe('ABCD-2345-EFGH-6789');
    });

    it('should handle input with spaces', () => {
      const input = 'ABCD 2345 EFGH 6789';
      const formatted = formatLicenseKey(input);
      expect(formatted).toBe('ABCD-2345-EFGH-6789');
    });

    it('should throw for invalid length', () => {
      expect(() => formatLicenseKey('ABCD')).toThrow('Invalid license key length');
      expect(() => formatLicenseKey('ABCD234567890123456')).toThrow('Invalid license key length');
    });
  });
});
