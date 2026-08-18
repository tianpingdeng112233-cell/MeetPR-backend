import { describe, expect, it } from 'vitest';

import { createS3StorageService } from '../../src/services/s3-storage';

// Deliberately does NOT mock @aws-sdk/s3-request-presigner: this pins the real
// presigner output. SDK >=3.729 defaults to CRC32 request checksums; a
// presigned UploadPart URL carrying x-amz-checksum-* for an empty body makes
// R2 reject the client's real part with BadDigest. The service must configure
// requestChecksumCalculation WHEN_REQUIRED so these params never appear.
describe('S3 presigned URLs stay checksum-free', () => {
  it('signs part URLs without any x-amz-checksum/x-amz-sdk-checksum params', async () => {
    const service = createS3StorageService({
      endpoint: 'https://account.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'test-bucket',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
    });

    const urls = await service.signPartUrls('attachments/video.mp4', 'upload-1', 2, 3600);

    expect(urls).toHaveLength(2);
    for (const part of urls) {
      const url = new URL(part.url);
      const paramNames = [...url.searchParams.keys()].map((name) => name.toLowerCase());
      expect(paramNames.some((name) => name.includes('checksum'))).toBe(false);
      expect(url.searchParams.get('partNumber')).toBe(String(part.part_number));
    }
  });
});
