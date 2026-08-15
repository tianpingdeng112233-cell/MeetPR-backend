import OSS from 'ali-oss';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOssService } from '../../src/services/oss';

const defaultEndpoint = 'https://oss-cn-hangzhou.aliyuncs.com';
const accelerateEndpoint = 'https://oss-accelerate.aliyuncs.com';

function makeService(accelerationEnabled: boolean) {
  return createOssService({
    accessKeyId: 'test-ak-id',
    accessKeySecret: 'test-ak-secret',
    bucket: 'meetpr-test-bucket',
    region: 'oss-cn-hangzhou',
    endpoint: defaultEndpoint,
    ...(accelerationEnabled ? { accelerateEndpoint } : {}),
  });
}

function clientEndpointHost(client: unknown): string {
  return (
    client as {
      options: { endpoint: { hostname: string } };
    }
  ).options.endpoint.hostname;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OSS endpoint selection', () => {
  it('keeps every signed URL on the default endpoint when acceleration is not configured', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    const service = makeService(false);
    const legacyClient = new OSS({
      accessKeyId: 'test-ak-id',
      accessKeySecret: 'test-ak-secret',
      bucket: 'meetpr-test-bucket',
      region: 'oss-cn-hangzhou',
      endpoint: defaultEndpoint,
      secure: true,
    });

    const parts = await service.signPartUrls('attachments/video.mp4', 'upload-1', 1, 3600, {
      useAccelerateEndpoint: true,
    });
    const getUrl = await service.signGetUrl('attachments/video.mp4', 900, {
      useAccelerateEndpoint: true,
    });

    expect(new URL(parts[0]?.url ?? 'https://missing.invalid').hostname).toBe(
      'meetpr-test-bucket.oss-cn-hangzhou.aliyuncs.com',
    );
    expect(new URL(getUrl).hostname).toBe('meetpr-test-bucket.oss-cn-hangzhou.aliyuncs.com');
    expect(parts[0]?.url).toBe(
      legacyClient.signatureUrl('attachments/video.mp4', {
        method: 'PUT',
        expires: 3600,
        subResource: { partNumber: '1', uploadId: 'upload-1' },
      }),
    );
    expect(getUrl).toBe(
      legacyClient.signatureUrl('attachments/video.mp4', { method: 'GET', expires: 900 }),
    );
  });

  it('uses acceleration only when the signing caller opts in and keeps PUT unsigned headers empty', async () => {
    const signatureSpy = vi.spyOn(OSS.prototype, 'signatureUrl');
    const service = makeService(true);

    const acceleratedParts = await service.signPartUrls(
      'attachments/video.mp4',
      'upload-1',
      1,
      3600,
      { useAccelerateEndpoint: true },
    );
    const acceleratedGet = await service.signGetUrl('attachments/video.mp4', 900, {
      useAccelerateEndpoint: true,
    });
    const defaultGet = await service.signGetUrl('attachments/video.mp4', 900, {
      useAccelerateEndpoint: false,
    });

    expect(new URL(acceleratedParts[0]?.url ?? 'https://missing.invalid').hostname).toBe(
      'meetpr-test-bucket.oss-accelerate.aliyuncs.com',
    );
    expect(new URL(acceleratedGet).hostname).toBe('meetpr-test-bucket.oss-accelerate.aliyuncs.com');
    expect(new URL(defaultGet).hostname).toBe('meetpr-test-bucket.oss-cn-hangzhou.aliyuncs.com');
    expect(signatureSpy).toHaveBeenCalledWith('attachments/video.mp4', {
      method: 'PUT',
      expires: 3600,
      subResource: { partNumber: '1', uploadId: 'upload-1' },
    });
  });

  it('keeps every control-plane method on the default endpoint when acceleration is configured', async () => {
    const calledHosts: string[] = [];
    vi.spyOn(OSS.prototype, 'initMultipartUpload').mockImplementation(function (this: OSS) {
      calledHosts.push(clientEndpointHost(this));
      return Promise.resolve({ uploadId: 'upload-1' } as never);
    });
    vi.spyOn(OSS.prototype, 'completeMultipartUpload').mockImplementation(function (this: OSS) {
      calledHosts.push(clientEndpointHost(this));
      return Promise.resolve(undefined as never);
    });
    vi.spyOn(OSS.prototype, 'head').mockImplementation(function (this: OSS) {
      calledHosts.push(clientEndpointHost(this));
      return Promise.resolve({ res: { headers: { 'content-length': '123' } } } as never);
    });
    vi.spyOn(OSS.prototype, 'abortMultipartUpload').mockImplementation(function (this: OSS) {
      calledHosts.push(clientEndpointHost(this));
      return Promise.resolve(undefined as never);
    });
    vi.spyOn(OSS.prototype, 'delete').mockImplementation(function (this: OSS) {
      calledHosts.push(clientEndpointHost(this));
      return Promise.resolve(undefined as never);
    });
    const service = makeService(true);

    const uploadId = await service.initiateMultipartUpload('attachments/video.mp4', 'video/mp4');
    await service.completeMultipartUpload(
      'attachments/video.mp4',
      uploadId,
      [{ part_number: 1, etag: 'etag-1' }],
      123,
    );
    await expect(service.headObject('attachments/video.mp4')).resolves.toEqual({ sizeBytes: 123 });
    await service.abortMultipartUpload('attachments/video.mp4', uploadId);
    await service.deleteObject('attachments/video.mp4');

    expect(calledHosts).toEqual([
      'oss-cn-hangzhou.aliyuncs.com',
      'oss-cn-hangzhou.aliyuncs.com',
      'oss-cn-hangzhou.aliyuncs.com',
      'oss-cn-hangzhou.aliyuncs.com',
      'oss-cn-hangzhou.aliyuncs.com',
    ]);
  });
});
