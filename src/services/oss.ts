import OSS from 'ali-oss';

import type { Config } from '../config';

export interface CompletedPart {
  part_number: number;
  etag: string;
}

export interface PresignedPartUrl {
  part_number: number;
  url: string;
}

export interface OssSignOptions {
  /** Use the transfer-acceleration endpoint when one is configured. */
  useAccelerateEndpoint: boolean;
}

/**
 * Network boundary for Aliyun OSS. Routes depend on this interface only;
 * tests inject a fake (repo rule: mock only at network/DB boundaries).
 */
export interface OssService {
  /** Whether callers can opt into transfer-accelerated signing. */
  readonly accelerationEnabled: boolean;
  /** InitiateMultipartUpload — returns the OSS upload ID. */
  initiateMultipartUpload(key: string, contentType: string): Promise<string>;
  /** Presigned PUT URL per part (local HMAC signing, no OSS round-trip). */
  signPartUrls(
    key: string,
    uploadId: string,
    partCount: number,
    expiresSeconds: number,
    options?: OssSignOptions,
  ): Promise<PresignedPartUrl[]>;
  /** CompleteMultipartUpload — throws on etag mismatch / unknown upload. */
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
    expectedSizeBytes: number,
  ): Promise<void>;
  /** AbortMultipartUpload — swallows NoSuchUpload so abort stays idempotent. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  /** Presigned GET URL (local HMAC signing, no OSS round-trip). */
  signGetUrl(key: string, expiresSeconds: number, options?: OssSignOptions): Promise<string>;
  /** Verify the completed object before it is exposed as ready. */
  headObject(key: string): Promise<{ sizeBytes: number } | null>;
  /** Best-effort compensation after a completed object fails verification. */
  deleteObject(key: string): Promise<void>;
}

export interface OssServiceOptions {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  region: string;
  endpoint?: string;
  accelerateEndpoint?: string;
}

function isNoSuchUpload(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, name } = err as { code?: unknown; name?: unknown };
  return code === 'NoSuchUpload' || name === 'NoSuchUploadError';
}

export function createOssService(options: OssServiceOptions): OssService {
  const clientOptions = {
    accessKeyId: options.accessKeyId,
    accessKeySecret: options.accessKeySecret,
    bucket: options.bucket,
    region: options.region,
    secure: true,
  };
  const defaultClient = new OSS({
    ...clientOptions,
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
  });
  const accelerateClient =
    options.accelerateEndpoint === undefined
      ? undefined
      : new OSS({ ...clientOptions, endpoint: options.accelerateEndpoint });

  function signingClient(signOptions: OssSignOptions | undefined): OSS {
    return signOptions?.useAccelerateEndpoint === true && accelerateClient !== undefined
      ? accelerateClient
      : defaultClient;
  }

  return {
    accelerationEnabled: accelerateClient !== undefined,

    async initiateMultipartUpload(key, contentType) {
      const result = await defaultClient.initMultipartUpload(key, {
        headers: { 'Content-Type': contentType },
      });
      return result.uploadId;
    },

    signPartUrls(key, uploadId, partCount, expiresSeconds, signOptions) {
      const client = signingClient(signOptions);
      const urls = Array.from({ length: partCount }, (_, index) => {
        const partNumber = index + 1;
        return {
          part_number: partNumber,
          url: client.signatureUrl(key, {
            method: 'PUT',
            expires: expiresSeconds,
            subResource: { partNumber: String(partNumber), uploadId },
          }),
        };
      });
      return Promise.resolve(urls);
    },

    async completeMultipartUpload(key, uploadId, parts, _expectedSizeBytes) {
      await defaultClient.completeMultipartUpload(
        key,
        uploadId,
        parts.map((part) => ({ number: part.part_number, etag: part.etag })),
      );
    },

    async abortMultipartUpload(key, uploadId) {
      try {
        await defaultClient.abortMultipartUpload(key, uploadId);
      } catch (err) {
        if (isNoSuchUpload(err)) return;
        throw err;
      }
    },

    signGetUrl(key, expiresSeconds, signOptions) {
      const client = signingClient(signOptions);
      return Promise.resolve(client.signatureUrl(key, { method: 'GET', expires: expiresSeconds }));
    },

    async headObject(key) {
      try {
        const result = await defaultClient.head(key);
        const headers = result.res.headers as Record<string, string | string[] | undefined>;
        const contentLength = headers['content-length'];
        const parsed = Number(Array.isArray(contentLength) ? contentLength[0] : contentLength);
        return Number.isSafeInteger(parsed) && parsed >= 0 ? { sizeBytes: parsed } : null;
      } catch (err) {
        const record = err as { code?: unknown; status?: unknown };
        if (record.code === 'NoSuchKey' || record.status === 404) return null;
        throw err;
      }
    },

    async deleteObject(key) {
      try {
        await defaultClient.delete(key);
      } catch (err) {
        const record = err as { code?: unknown; status?: unknown };
        if (record.code === 'NoSuchKey' || record.status === 404) return;
        throw err;
      }
    },
  };
}

/**
 * Builds the OSS service from env-derived config. Returns undefined when any
 * required variable is missing so /uploads/* can answer 503 UPLOADS_NOT_CONFIGURED.
 */
export function maybeCreateOssService(
  config: Pick<
    Config,
    | 'OSS_ACCESS_KEY_ID'
    | 'OSS_ACCESS_KEY_SECRET'
    | 'OSS_BUCKET'
    | 'OSS_REGION'
    | 'OSS_ENDPOINT'
    | 'OSS_ACCELERATE_ENDPOINT'
  >,
): OssService | undefined {
  if (
    config.OSS_ACCESS_KEY_ID === undefined ||
    config.OSS_ACCESS_KEY_SECRET === undefined ||
    config.OSS_BUCKET === undefined ||
    config.OSS_REGION === undefined
  ) {
    return undefined;
  }

  return createOssService({
    accessKeyId: config.OSS_ACCESS_KEY_ID,
    accessKeySecret: config.OSS_ACCESS_KEY_SECRET,
    bucket: config.OSS_BUCKET,
    region: config.OSS_REGION,
    ...(config.OSS_ENDPOINT !== undefined ? { endpoint: config.OSS_ENDPOINT } : {}),
    ...(config.OSS_ACCELERATE_ENDPOINT !== undefined
      ? { accelerateEndpoint: config.OSS_ACCELERATE_ENDPOINT }
      : {}),
  });
}
