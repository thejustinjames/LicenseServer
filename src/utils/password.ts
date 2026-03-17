import { z } from 'zod';

/**
 * Password requirements
 */
export const PASSWORD_REQUIREMENTS = {
  minLength: 12,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecial: true,
};

/**
 * Special characters allowed in passwords
 */
const SPECIAL_CHARACTERS = '!@#$%^&*()_+-=[]{}|;:,.<>?';

/**
 * Common weak passwords to reject
 */
const COMMON_PASSWORDS = new Set([
  'password1234',
  'password123!',
  'Password1234',
  'Password123!',
  'Qwerty123456',
  'Qwerty12345!',
  'Admin1234567',
  'Letmein12345',
  'Welcome12345',
  'Changeme1234',
]);

/**
 * Password validation result
 */
export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
  strength: 'weak' | 'fair' | 'strong' | 'very-strong';
}

/**
 * Validate password strength
 */
export function validatePassword(password: string): PasswordValidationResult {
  const errors: string[] = [];

  // Length check
  if (password.length < PASSWORD_REQUIREMENTS.minLength) {
    errors.push(`Password must be at least ${PASSWORD_REQUIREMENTS.minLength} characters`);
  }

  if (password.length > PASSWORD_REQUIREMENTS.maxLength) {
    errors.push(`Password must be at most ${PASSWORD_REQUIREMENTS.maxLength} characters`);
  }

  // Character type checks
  if (PASSWORD_REQUIREMENTS.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }

  if (PASSWORD_REQUIREMENTS.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }

  if (PASSWORD_REQUIREMENTS.requireNumber && !/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }

  if (PASSWORD_REQUIREMENTS.requireSpecial) {
    const hasSpecial = SPECIAL_CHARACTERS.split('').some((char) => password.includes(char));
    if (!hasSpecial) {
      errors.push(`Password must contain at least one special character (${SPECIAL_CHARACTERS})`);
    }
  }

  // Check for common passwords
  if (COMMON_PASSWORDS.has(password)) {
    errors.push('Password is too common, please choose a more unique password');
  }

  // Check for repeated characters
  if (/(.)\1{3,}/.test(password)) {
    errors.push('Password cannot contain more than 3 repeated characters in a row');
  }

  // Calculate strength
  let strength: PasswordValidationResult['strength'] = 'weak';
  if (errors.length === 0) {
    const lengthScore = Math.min(password.length / 20, 1);
    const varietyScore = calculateVarietyScore(password);
    const totalScore = (lengthScore + varietyScore) / 2;

    if (totalScore >= 0.9) {
      strength = 'very-strong';
    } else if (totalScore >= 0.7) {
      strength = 'strong';
    } else if (totalScore >= 0.5) {
      strength = 'fair';
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    strength,
  };
}

/**
 * Calculate variety score based on character types used
 */
function calculateVarietyScore(password: string): number {
  let score = 0;
  const checks = [
    /[a-z]/, // lowercase
    /[A-Z]/, // uppercase
    /[0-9]/, // numbers
    /[!@#$%^&*()]/, // special group 1
    /[_+\-=\[\]{}|;:,.<>?]/, // special group 2
  ];

  for (const check of checks) {
    if (check.test(password)) {
      score += 0.2;
    }
  }

  return score;
}

/**
 * Zod schema for password validation
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_REQUIREMENTS.minLength, `Password must be at least ${PASSWORD_REQUIREMENTS.minLength} characters`)
  .max(PASSWORD_REQUIREMENTS.maxLength, `Password must be at most ${PASSWORD_REQUIREMENTS.maxLength} characters`)
  .refine(
    (password) => /[A-Z]/.test(password),
    'Password must contain at least one uppercase letter'
  )
  .refine(
    (password) => /[a-z]/.test(password),
    'Password must contain at least one lowercase letter'
  )
  .refine(
    (password) => /[0-9]/.test(password),
    'Password must contain at least one number'
  )
  .refine(
    (password) => SPECIAL_CHARACTERS.split('').some((char) => password.includes(char)),
    `Password must contain at least one special character (${SPECIAL_CHARACTERS})`
  )
  .refine(
    (password) => !COMMON_PASSWORDS.has(password),
    'Password is too common'
  )
  .refine(
    (password) => !/(.)\1{3,}/.test(password),
    'Password cannot contain more than 3 repeated characters'
  );

/**
 * Get password requirements as user-friendly text
 */
export function getPasswordRequirementsText(): string[] {
  return [
    `At least ${PASSWORD_REQUIREMENTS.minLength} characters`,
    'At least one uppercase letter (A-Z)',
    'At least one lowercase letter (a-z)',
    'At least one number (0-9)',
    `At least one special character (${SPECIAL_CHARACTERS})`,
    'No more than 3 repeated characters in a row',
  ];
}
