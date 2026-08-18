import { describe, expect, it } from 'vitest';

import { maybeCreateS3StorageService } from '../../src/services/s3-storage';

const fullS3Env = {
  S3_ENDPOINT: 'https://account-id.r2.cloudflarestorage.com',
  S3_REGION: 'auto',
  S3_BUCKET: 'meetpr-test-bucket',
  S3_ACCESS_KEY_ID: 'test-s3-key-id',
  S3_SECRET_ACCESS_KEY: 'test-s3-secret',
};

describe('maybeCreateS3StorageService', () => {
  it('builds the selected backend when all five S3 vars are present', () => {
    const service = maybeCreateS3StorageService(fullS3Env);

    expect(service).toBeDefined();
    expect(service?.accelerationEnabled).toBe(false);
    expect(typeof service?.initiateMultipartUpload).toBe('function');
    expect(typeof service?.signGetUrl).toBe('function');
  });

  it.each([
    'S3_ENDPOINT',
    'S3_REGION',
    'S3_BUCKET',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
  ] as const)('returns undefined when selected S3 backend is missing %s', (missingKey) => {
    const service = maybeCreateS3StorageService({ ...fullS3Env, [missingKey]: undefined });

    expect(service).toBeUndefined();
  });
});
