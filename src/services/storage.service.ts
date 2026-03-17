import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client } from '../config/s3.js';
import { config } from '../config/index.js';
import * as productService from './product.service.js';
import * as licenseService from './license.service.js';

const DEFAULT_EXPIRATION = 3600; // 1 hour

export interface SignedDownloadUrl {
  url: string;
  expiresAt: Date;
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
    expiresIn: DEFAULT_EXPIRATION,
  });

  const expiresAt = new Date();
  expiresAt.setSeconds(expiresAt.getSeconds() + DEFAULT_EXPIRATION);

  const filename = product.s3PackageKey.split('/').pop() || 'download';

  return {
    url,
    expiresAt,
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
    expiresIn: DEFAULT_EXPIRATION,
  });

  const expiresAt = new Date();
  expiresAt.setSeconds(expiresAt.getSeconds() + DEFAULT_EXPIRATION);

  const filename = product.s3PackageKey.split('/').pop() || 'download';

  return {
    url,
    expiresAt,
    filename,
  };
}
