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

import type { Config } from '../config';
import type { OssService } from './oss';

export interface S3StorageServiceOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function errorField(err: unknown, field: string): unknown {
  if (typeof err !== 'object' || err === null) return undefined;
  return Reflect.get(err, field);
}

function hasErrorCode(err: unknown, ...codes: string[]): boolean {
  return [errorField(err, 'name'), errorField(err, 'code'), errorField(err, 'Code')].some(
    (value) => typeof value === 'string' && codes.includes(value),
  );
}

function errorStatus(err: unknown): unknown {
  return errorField(errorField(err, '$metadata'), 'httpStatusCode');
}

export function createS3StorageService(options: S3StorageServiceOptions): OssService {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    // SDK >=3.729 defaults to CRC32 checksums on every request. A presigned
    // UploadPart URL would then carry x-amz-checksum-crc32 for an EMPTY body,
    // and R2 rejects the client's real part with BadDigest. Same class of trap
    // as the OSS Content-Type signature rule — keep checksums opt-in only.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  return {
    accelerationEnabled: false,

    async initiateMultipartUpload(key, contentType) {
      const result = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: options.bucket,
          Key: key,
          ContentType: contentType,
        }),
      );
      if (result.UploadId === undefined) {
        throw new Error('s3_create_multipart_upload_missing_upload_id');
      }
      return result.UploadId;
    },

    async signPartUrls(key, uploadId, partCount, expiresSeconds) {
      return Promise.all(
        Array.from({ length: partCount }, async (_, index) => {
          const partNumber = index + 1;
          const url = await getSignedUrl(
            client,
            new UploadPartCommand({
              Bucket: options.bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: partNumber,
            }),
            { expiresIn: expiresSeconds },
          );
          return { part_number: partNumber, url };
        }),
      );
    },

    async completeMultipartUpload(key, uploadId, parts, _expectedSizeBytes) {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: options.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({
              PartNumber: part.part_number,
              ETag: part.etag,
            })),
          },
        }),
      );
    },

    async abortMultipartUpload(key, uploadId) {
      try {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: options.bucket,
            Key: key,
            UploadId: uploadId,
          }),
        );
      } catch (err) {
        if (hasErrorCode(err, 'NoSuchUpload', 'NoSuchUploadError')) return;
        throw err;
      }
    },

    signGetUrl(key, expiresSeconds) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: options.bucket, Key: key }), {
        expiresIn: expiresSeconds,
      });
    },

    async headObject(key) {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: options.bucket, Key: key }),
        );
        const sizeBytes = result.ContentLength;
        return sizeBytes !== undefined && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0
          ? { sizeBytes }
          : null;
      } catch (err) {
        if (errorStatus(err) === 404) return null;
        throw err;
      }
    },

    async deleteObject(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
      } catch (err) {
        if (errorStatus(err) === 404 || hasErrorCode(err, 'NoSuchKey', 'NotFound')) return;
        throw err;
      }
    },
  };
}

/**
 * Builds the S3-compatible service only when all five required settings exist.
 * An incomplete selected backend deliberately becomes the existing uploads 503.
 */
export function maybeCreateS3StorageService(
  config: Pick<
    Config,
    'S3_ENDPOINT' | 'S3_REGION' | 'S3_BUCKET' | 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY'
  >,
): OssService | undefined {
  if (
    config.S3_ENDPOINT === undefined ||
    config.S3_REGION === undefined ||
    config.S3_BUCKET === undefined ||
    config.S3_ACCESS_KEY_ID === undefined ||
    config.S3_SECRET_ACCESS_KEY === undefined
  ) {
    return undefined;
  }

  return createS3StorageService({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  });
}
