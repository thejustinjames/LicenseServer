import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client } from '../config/s3.js';
import { config } from '../config/index.js';
import * as productService from './product.service.js';
import * as licenseService from './license.service.js';

// Download link expiry in seconds (default 4 hours)
const DOWNLOAD_EXPIRY_SECONDS = parseInt(config.S3_DOWNLOAD_EXPIRY_HOURS || '4', 10) * 3600;

export interface SignedDownloadUrl {
  url: string;
  expiresAt: Date;
  expiresInHours: number;
  filename: string;
}

export async function getSignedDownloadUrl(
  productId: string,
  customerId: string
): Promise<SignedDownloadUrl | null> {
  if (!config.S3_BUCKET_NAME) {
    throw new Error('S3 bucket not configured');
  }

  const product = await productService.getProductById(productId);
  if (!product) {
    throw new Error('Product not found');
  }

  if (!product.s3PackageKey) {
    throw new Error('Product does not have a downloadable package');
  }

  const licenses = await licenseService.getLicensesByCustomerId(customerId);
  const hasValidLicense = licenses.some(
    (license) =>
      license.productId === productId &&
      license.status === 'ACTIVE' &&
      (!license.expiresAt || license.expiresAt > new Date())
  );

  if (!hasValidLicense) {
    throw new Error('No valid license for this product');
  }

  const command = new GetObjectCommand({
    Bucket: config.S3_BUCKET_NAME,
    Key: product.s3PackageKey,
  });

  const url = await getSignedUrl(s3Client, command, {
    expiresIn: DOWNLOAD_EXPIRY_SECONDS,
  });

  const expiresAt = new Date();
  expiresAt.setSeconds(expiresAt.getSeconds() + DOWNLOAD_EXPIRY_SECONDS);

  const filename = product.s3PackageKey.split('/').pop() || 'download';

  return {
    url,
    expiresAt,
    expiresInHours: getDownloadExpiryHours(),
    filename,
  };
}

export async function getSignedDownloadUrlByLicenseKey(
  productId: string,
  licenseKey: string
): Promise<SignedDownloadUrl | null> {
  if (!config.S3_BUCKET_NAME) {
    throw new Error('S3 bucket not configured');
  }

  const license = await licenseService.getLicenseByKey(licenseKey);
  if (!license) {
    throw new Error('Invalid license key');
  }

  if (license.productId !== productId) {
    throw new Error('License is not valid for this product');
  }

  if (license.status !== 'ACTIVE') {
    throw new Error('License is not active');
  }

  if (license.expiresAt && license.expiresAt < new Date()) {
    throw new Error('License has expired');
  }

  const product = await productService.getProductById(productId);
  if (!product?.s3PackageKey) {
    throw new Error('Product does not have a downloadable package');
  }

  const command = new GetObjectCommand({
    Bucket: config.S3_BUCKET_NAME,
    Key: product.s3PackageKey,
  });

  const url = await getSignedUrl(s3Client, command, {
    expiresIn: DOWNLOAD_EXPIRY_SECONDS,
  });

  const expiresAt = new Date();
  expiresAt.setSeconds(expiresAt.getSeconds() + DOWNLOAD_EXPIRY_SECONDS);

  const filename = product.s3PackageKey.split('/').pop() || 'download';

  return {
    url,
    expiresAt,
    expiresInHours: getDownloadExpiryHours(),
    filename,
  };
}

/**
 * Get download expiry hours for display to users
 */
export function getDownloadExpiryHours(): number {
  return parseInt(config.S3_DOWNLOAD_EXPIRY_HOURS || '4', 10);
}

/**
 * Check if an S3 object exists
 */
export async function checkFileExists(key: string): Promise<boolean> {
  if (!config.S3_BUCKET_NAME) {
    return false;
  }

  try {
    const command = new HeadObjectCommand({
      Bucket: config.S3_BUCKET_NAME,
      Key: key,
    });
    await s3Client.send(command);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get file info from S3
 */
export interface S3FileInfo {
  key: string;
  size: number;
  lastModified: Date;
  contentType?: string;
}

export async function getFileInfo(key: string): Promise<S3FileInfo | null> {
  if (!config.S3_BUCKET_NAME) {
    return null;
  }

  try {
    const command = new HeadObjectCommand({
      Bucket: config.S3_BUCKET_NAME,
      Key: key,
    });
    const response = await s3Client.send(command);

    return {
      key,
      size: response.ContentLength || 0,
      lastModified: response.LastModified || new Date(),
      contentType: response.ContentType,
    };
  } catch {
    return null;
  }
}

/**
 * Check if S3 is configured and accessible
 */
export function isS3Configured(): boolean {
  return !!config.S3_BUCKET_NAME;
}
