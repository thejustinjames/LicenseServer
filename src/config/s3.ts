/**
 * S3 Client Configuration
 *
 * Uses the AWS client factory for automatic credential resolution.
 * Supports IAM roles, service accounts, and explicit credentials.
 */

import { createS3Client } from './aws.js';

export const s3Client = createS3Client();
