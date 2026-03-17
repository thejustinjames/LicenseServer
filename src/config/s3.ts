import { S3Client } from '@aws-sdk/client-s3';
import { config } from './index.js';

export const s3Client = new S3Client({
  region: config.AWS_REGION,
  credentials: config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY
    ? {
        accessKeyId: config.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      }
    : undefined,
});
