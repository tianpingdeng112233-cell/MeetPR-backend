import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createS3StorageService } from '../../src/services/s3-storage';

vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }));

const key = 'attachments/video.mp4';

function makeService() {
  return createS3StorageService({
    endpoint: 'https://account-id.r2.cloudflarestorage.com',
    region: 'auto',
    bucket: 'meetpr-test-bucket',
    accessKeyId: 'test-s3-key-id',
    secretAccessKey: 'test-s3-secret',
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(getSignedUrl).mockReset();
});

describe('S3-compatible storage service', () => {
  it('initiates a multipart upload with its content type and disables OSS acceleration', async () => {
    const sendSpy = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({ UploadId: 'upload-1' } as never);
    const service = makeService();

    await expect(service.initiateMultipartUpload(key, 'video/mp4')).resolves.toBe('upload-1');

    expect(service.accelerationEnabled).toBe(false);
    const command = sendSpy.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(CreateMultipartUploadCommand);
    expect(command).toMatchObject({
      input: {
        Bucket: 'meetpr-test-bucket',
        Key: key,
        ContentType: 'video/mp4',
      },
    });
  });

  it('signs one UploadPart command per part without a Content-Type header', async () => {
    const presignMock = vi.mocked(getSignedUrl);
    presignMock
      .mockResolvedValueOnce('https://r2.example.test/video?partNumber=1&X-Amz-Expires=3600')
      .mockResolvedValueOnce('https://r2.example.test/video?partNumber=2&X-Amz-Expires=3600');
    const service = makeService();

    await expect(
      service.signPartUrls(key, 'upload-1', 2, 3600, { useAccelerateEndpoint: true }),
    ).resolves.toEqual([
      {
        part_number: 1,
        url: 'https://r2.example.test/video?partNumber=1&X-Amz-Expires=3600',
      },
      {
        part_number: 2,
        url: 'https://r2.example.test/video?partNumber=2&X-Amz-Expires=3600',
      },
    ]);

    expect(presignMock).toHaveBeenCalledTimes(2);
    expect(presignMock.mock.calls[0]?.[1]).toBeInstanceOf(UploadPartCommand);
    expect(presignMock.mock.calls[0]?.[1]).toMatchObject({
      input: {
        Bucket: 'meetpr-test-bucket',
        Key: key,
        UploadId: 'upload-1',
        PartNumber: 1,
      },
    });
    expect(presignMock.mock.calls[1]?.[1]).toBeInstanceOf(UploadPartCommand);
    expect(presignMock.mock.calls[1]?.[1]).toMatchObject({
      input: {
        Bucket: 'meetpr-test-bucket',
        Key: key,
        UploadId: 'upload-1',
        PartNumber: 2,
      },
    });
    expect(presignMock.mock.calls[0]?.[2]).toEqual({ expiresIn: 3600 });
    expect(presignMock.mock.calls[1]?.[2]).toEqual({ expiresIn: 3600 });
  });

  it('passes quoted R2 ETags through unchanged when completing', async () => {
    const sendSpy = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    const service = makeService();

    await service.completeMultipartUpload(
      key,
      'upload-1',
      [
        { part_number: 1, etag: '"etag-one"' },
        { part_number: 2, etag: '"etag-two"' },
      ],
      123,
    );

    const command = sendSpy.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(command).toMatchObject({
      input: {
        Bucket: 'meetpr-test-bucket',
        Key: key,
        UploadId: 'upload-1',
        MultipartUpload: {
          Parts: [
            { PartNumber: 1, ETag: '"etag-one"' },
            { PartNumber: 2, ETag: '"etag-two"' },
          ],
        },
      },
    });
  });

  it('aborts multipart uploads and treats NoSuchUpload as idempotent success', async () => {
    const sendSpy = vi
      .spyOn(S3Client.prototype, 'send')
      .mockRejectedValueOnce({ name: 'NoSuchUpload' });
    const service = makeService();

    await expect(service.abortMultipartUpload(key, 'upload-1')).resolves.toBeUndefined();

    const command = sendSpy.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(AbortMultipartUploadCommand);
    expect(command).toMatchObject({
      input: {
        Bucket: 'meetpr-test-bucket',
        Key: key,
        UploadId: 'upload-1',
      },
    });
  });

  it('signs GET URLs with the requested expiry and ignores OSS sign options', async () => {
    const presignMock = vi
      .mocked(getSignedUrl)
      .mockResolvedValue('https://r2.example.test/video?X-Amz-Expires=900');
    const service = makeService();

    const url = await service.signGetUrl(key, 900, { useAccelerateEndpoint: true });

    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('900');
    const call = presignMock.mock.calls[0];
    expect(call?.[1]).toBeInstanceOf(GetObjectCommand);
    expect(call?.[1]).toMatchObject({
      input: {
        Bucket: 'meetpr-test-bucket',
        Key: key,
      },
    });
    expect(call?.[2]).toEqual({ expiresIn: 900 });
  });

  it('returns ContentLength from HeadObject and maps an S3 404 to null', async () => {
    const sendSpy = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValueOnce({ ContentLength: 123 } as never)
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
    const service = makeService();

    await expect(service.headObject(key)).resolves.toEqual({ sizeBytes: 123 });
    await expect(service.headObject('attachments/missing.mp4')).resolves.toBeNull();

    expect(sendSpy.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
    expect(sendSpy.mock.calls[0]?.[0]).toMatchObject({
      input: {
        Bucket: 'meetpr-test-bucket',
        Key: key,
      },
    });
  });

  it('deletes objects and treats an S3 404 as idempotent success', async () => {
    const sendSpy = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
    const service = makeService();

    await expect(service.deleteObject(key)).resolves.toBeUndefined();
    await expect(service.deleteObject('attachments/missing.mp4')).resolves.toBeUndefined();

    const command = sendSpy.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command).toMatchObject({
      input: {
        Bucket: 'meetpr-test-bucket',
        Key: key,
      },
    });
  });
});
