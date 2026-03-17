import crypto from 'crypto';

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SEGMENT_LENGTH = 4;
const SEGMENT_COUNT = 4;

function generateSegment(): string {
  const bytes = crypto.randomBytes(SEGMENT_LENGTH);
  let segment = '';
  for (let i = 0; i < SEGMENT_LENGTH; i++) {
    segment += CHARSET[bytes[i] % CHARSET.length];
  }
  return segment;
}

function calculateChecksum(segments: string[]): string {
  const data = segments.join('');
  const hash = crypto.createHash('sha256').update(data).digest();
  let checksum = '';
  for (let i = 0; i < 2; i++) {
    checksum += CHARSET[hash[i] % CHARSET.length];
  }
  return checksum;
}

export function generateLicenseKey(): string {
  const segments: string[] = [];
  for (let i = 0; i < SEGMENT_COUNT - 1; i++) {
    segments.push(generateSegment());
  }

  const checksum = calculateChecksum(segments);
  const lastSegment = generateSegment().slice(0, 2) + checksum;
  segments.push(lastSegment);

  return segments.join('-');
}

export function validateLicenseKeyFormat(key: string): boolean {
  const pattern = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
  if (!pattern.test(key)) {
    return false;
  }

  const segments = key.split('-');
  const providedChecksum = segments[3].slice(2);
  const calculatedChecksum = calculateChecksum(segments.slice(0, 3));

  return providedChecksum === calculatedChecksum;
}

export function formatLicenseKey(key: string): string {
  const cleaned = key.replace(/[^A-Z2-9]/gi, '').toUpperCase();
  if (cleaned.length !== 16) {
    throw new Error('Invalid license key length');
  }

  const segments = [];
  for (let i = 0; i < cleaned.length; i += SEGMENT_LENGTH) {
    segments.push(cleaned.slice(i, i + SEGMENT_LENGTH));
  }

  return segments.join('-');
}
