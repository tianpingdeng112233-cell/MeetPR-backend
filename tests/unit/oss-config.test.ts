import { describe, expect, it } from 'vitest';

import { maybeCreateOssService } from '../../src/services/oss';

const fullOssEnv = {
  OSS_ACCESS_KEY_ID: 'test-ak-id',
  OSS_ACCESS_KEY_SECRET: 'test-ak-secret',
  OSS_BUCKET: 'meetpr-test-bucket',
  OSS_REGION: 'oss-cn-hangzhou',
};

describe('maybeCreateOssService', () => {
  it('builds a service when all required OSS vars are present', () => {
    const service = maybeCreateOssService(fullOssEnv);

    expect(service).toBeDefined();
    expect(typeof service?.initiateMultipartUpload).toBe('function');
    expect(typeof service?.signGetUrl).toBe('function');
  });

  it('accepts an explicit endpoint', () => {
    const service = maybeCreateOssService({
      ...fullOssEnv,
      OSS_ENDPOINT: 'https://oss-cn-hangzhou.aliyuncs.com',
    });

    expect(service).toBeDefined();
  });

  it.each(['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_BUCKET', 'OSS_REGION'] as const)(
    'returns undefined when %s is missing',
    (missingKey) => {
      const service = maybeCreateOssService({ ...fullOssEnv, [missingKey]: undefined });

      expect(service).toBeUndefined();
    },
  );

  it('does not require OSS_ENDPOINT', () => {
    const service = maybeCreateOssService(fullOssEnv);

    expect(service).toBeDefined();
  });

  it('accepts an optional transfer-acceleration endpoint', async () => {
    const service = maybeCreateOssService({
      ...fullOssEnv,
      OSS_ACCELERATE_ENDPOINT: 'https://oss-accelerate.aliyuncs.com',
    });

    expect(service?.accelerationEnabled).toBe(true);
    await expect(
      service?.signGetUrl('attachments/video.mp4', 900, { useAccelerateEndpoint: true }),
    ).resolves.toContain('meetpr-test-bucket.oss-accelerate.aliyuncs.com');
  });
});
