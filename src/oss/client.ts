import OSS from 'ali-oss';

import type { Config } from '../config';

export interface MultipartPart {
  partNumber: number;
  etag: string;
}

export interface MultipartUpload {
  key: string;
  uploadId: string;
}

export interface HeadObjectResult {
  etag: string | null;
  contentLength: number;
}

export interface PresignOptions {
  method: 'GET' | 'PUT';
  expires?: number;
  subResource?: Record<string, string | number>;
  contentType?: string;
}

export interface OSSClient {
  initiateMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: MultipartPart[],
  ): Promise<{ etag: string | null }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  listMultipartUploads(prefix: string): Promise<MultipartUpload[]>;
  headObject(key: string): Promise<HeadObjectResult>;
  signature(key: string, options: PresignOptions): string;
}

interface AliOSSRawClient {
  initMultipartUpload(
    key: string,
    options: { mime: string },
  ): Promise<{ uploadId: string; name?: string }>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: { number: number; etag: string }[],
  ): Promise<{ etag?: string; res?: { headers?: Record<string, string | undefined> } }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<unknown>;
  listUploads(query: {
    prefix: string;
  }): Promise<{ uploads: { name: string; uploadId: string }[] }>;
  head(key: string): Promise<{ res?: { headers?: Record<string, string | undefined> } }>;
  signatureUrl(key: string, options: Record<string, unknown>): string;
}

function normalizeEtag(etag: string | undefined): string | null {
  return etag?.replace(/^"|"$/g, '') ?? null;
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  return record.status === 404 || record.statusCode === 404 || record.code === 'NoSuchUpload';
}

export class AliyunOSSClient implements OSSClient {
  constructor(private readonly client: AliOSSRawClient) {}

  async initiateMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }> {
    const result = await this.client.initMultipartUpload(key, { mime: contentType });
    return { uploadId: result.uploadId };
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: MultipartPart[],
  ): Promise<{ etag: string | null }> {
    const result = await this.client.completeMultipartUpload(
      key,
      uploadId,
      parts.map((part) => ({ number: part.partNumber, etag: part.etag })),
    );
    return { etag: normalizeEtag(result.etag ?? result.res?.headers?.etag) };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.abortMultipartUpload(key, uploadId);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  async listMultipartUploads(prefix: string): Promise<MultipartUpload[]> {
    const result = await this.client.listUploads({ prefix });
    return result.uploads.map((upload) => ({ key: upload.name, uploadId: upload.uploadId }));
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    const result = await this.client.head(key);
    const headers = result.res?.headers ?? {};
    return {
      etag: normalizeEtag(headers.etag),
      contentLength: Number(headers['content-length'] ?? 0),
    };
  }

  signature(key: string, options: PresignOptions): string {
    const signatureOptions: Record<string, unknown> = {
      method: options.method,
      expires: options.expires,
      subResource: options.subResource,
    };
    if (options.contentType) {
      signatureOptions['Content-Type'] = options.contentType;
    }
    return this.client.signatureUrl(key, signatureOptions);
  }
}

export function createAliyunOSSClient(config: Config): OSSClient {
  if (!config.OSS_ACCESS_KEY_ID || !config.OSS_ACCESS_KEY_SECRET) {
    throw new Error('OSS_ACCESS_KEY_ID and OSS_ACCESS_KEY_SECRET are required');
  }

  return new AliyunOSSClient(
    new OSS({
      accessKeyId: config.OSS_ACCESS_KEY_ID,
      accessKeySecret: config.OSS_ACCESS_KEY_SECRET,
      bucket: config.OSS_BUCKET,
      region: config.OSS_REGION,
      endpoint: config.OSS_ENDPOINT,
    }) as AliOSSRawClient,
  );
}
