import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client } from '../config/s3.js';
import { config } from '../config/index.js';
import * as productService from './product.service.js';
import * as licenseService from './license.service.js';
import { logger } from './logger.service.js';

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

/**
 * Upload a file to S3
 */
export interface UploadResult {
  key: string;
  size: number;
  contentType: string;
}

export async function uploadFile(
  key: string,
  body: Buffer,
  contentType: string
): Promise<UploadResult> {
  if (!config.S3_BUCKET_NAME) {
    throw new Error('S3 bucket not configured');
  }

  const command = new PutObjectCommand({
    Bucket: config.S3_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: contentType,
  });

  await s3Client.send(command);

  return {
    key,
    size: body.length,
    contentType,
  };
}

/**
 * List files in a prefix (folder)
 */
export interface S3ListItem {
  key: string;
  size: number;
  lastModified: Date;
  filename: string;
}

export async function listFiles(prefix: string): Promise<S3ListItem[]> {
  if (!config.S3_BUCKET_NAME) {
    return [];
  }

  try {
    const command = new ListObjectsV2Command({
      Bucket: config.S3_BUCKET_NAME,
      Prefix: prefix,
    });

    const response = await s3Client.send(command);
    const items: S3ListItem[] = [];

    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key && obj.Size && obj.Size > 0) {
          items.push({
            key: obj.Key,
            size: obj.Size,
            lastModified: obj.LastModified || new Date(),
            filename: obj.Key.split('/').pop() || obj.Key,
          });
        }
      }
    }

    // Sort by last modified, newest first
    items.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

    return items;
  } catch (error) {
    logger.error('Failed to list files:', error);
    return [];
  }
}

/**
 * Delete a file from S3
 */
export async function deleteFile(key: string): Promise<boolean> {
  if (!config.S3_BUCKET_NAME) {
    return false;
  }

  try {
    const command = new DeleteObjectCommand({
      Bucket: config.S3_BUCKET_NAME,
      Key: key,
    });

    await s3Client.send(command);
    return true;
  } catch (error) {
    logger.error('Failed to delete file:', error);
    return false;
  }
}

/**
 * Generate a unique file key for a product
 */
export function generateProductFileKey(
  category: string,
  productName: string,
  filename: string,
  version?: string
): string {
  // Sanitize category and product name for use as path components
  const sanitize = (str: string) =>
    str
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

  const categoryPath = sanitize(category || 'products');
  const productPath = sanitize(productName);

  // Add version to filename if provided
  if (version) {
    const ext = filename.includes('.') ? filename.substring(filename.lastIndexOf('.')) : '';
    const base = filename.includes('.') ? filename.substring(0, filename.lastIndexOf('.')) : filename;
    filename = `${base}-v${version}${ext}`;
  }

  return `${categoryPath}/${productPath}/${filename}`;
}

/**
 * Get folder prefix for a product's bundles
 */
export function getProductBundlePrefix(category: string, productName: string): string {
  const sanitize = (str: string) =>
    str
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

  const categoryPath = sanitize(category || 'products');
  const productPath = sanitize(productName);

  return `${categoryPath}/${productPath}/`;
}
