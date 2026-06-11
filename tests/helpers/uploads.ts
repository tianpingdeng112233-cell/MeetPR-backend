import request from 'supertest';

import type { CompletedPart, OssService } from '../../src/services/oss';
import { auth, makeContext, type TestContext } from './studentActions';

export interface FakeOssCalls {
  initiate: { key: string; contentType: string }[];
  signParts: { key: string; uploadId: string; partCount: number; expiresSeconds: number }[];
  complete: { key: string; uploadId: string; parts: CompletedPart[] }[];
  abort: { key: string; uploadId: string }[];
  signGet: { key: string; expiresSeconds: number }[];
}

export interface FakeOss {
  service: OssService;
  calls: FakeOssCalls;
}

export interface FakeOssOptions {
  completeError?: Error;
  abortError?: Error;
}

export function makeFakeOss(options: FakeOssOptions = {}): FakeOss {
  const calls: FakeOssCalls = {
    initiate: [],
    signParts: [],
    complete: [],
    abort: [],
    signGet: [],
  };
  let uploadCounter = 0;

  const service: OssService = {
    initiateMultipartUpload(key, contentType) {
      calls.initiate.push({ key, contentType });
      uploadCounter += 1;
      return Promise.resolve(`fake-upload-${String(uploadCounter)}`);
    },
    signPartUrls(key, uploadId, partCount, expiresSeconds) {
      calls.signParts.push({ key, uploadId, partCount, expiresSeconds });
      return Promise.resolve(
        Array.from({ length: partCount }, (_, index) => ({
          part_number: index + 1,
          url: `https://fake-oss.invalid/${key}?partNumber=${String(index + 1)}&uploadId=${uploadId}&expires=${String(expiresSeconds)}`,
        })),
      );
    },
    completeMultipartUpload(key, uploadId, parts) {
      calls.complete.push({ key, uploadId, parts });
      if (options.completeError) return Promise.reject(options.completeError);
      return Promise.resolve();
    },
    abortMultipartUpload(key, uploadId) {
      calls.abort.push({ key, uploadId });
      if (options.abortError) return Promise.reject(options.abortError);
      return Promise.resolve();
    },
    signGetUrl(key, expiresSeconds) {
      calls.signGet.push({ key, expiresSeconds });
      return Promise.resolve(
        `https://fake-oss.invalid/${key}?expires=${String(expiresSeconds)}&sig=get`,
      );
    },
  };

  return { service, calls };
}

export interface UploadsContext extends TestContext {
  oss: FakeOss;
}

export async function makeUploadsContext(options: FakeOssOptions = {}): Promise<UploadsContext> {
  const oss = makeFakeOss(options);
  const ctx = await makeContext(undefined, { oss: oss.service });
  return { ...ctx, oss };
}

export const validInitiateBody = {
  kind: 'set_video',
  content_type: 'video/mp4',
  size_bytes: 50 * 1024 * 1024,
  part_count: 3,
  filename: 'squat-day1.mp4',
};

/** POST /uploads/initiate with sensible defaults; returns the supertest response. */
export async function initiateUpload(
  ctx: UploadsContext,
  token: string,
  overrides: Record<string, unknown> = {},
) {
  return request(ctx.app)
    .post('/uploads/initiate')
    .set(auth(token))
    .send({ ...validInitiateBody, ...overrides });
}

/** Initiate + complete a 1-part upload, returning the ready attachment id. */
export async function createReadyAttachment(
  ctx: UploadsContext,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const initiated = await initiateUpload(ctx, token, { part_count: 1, ...overrides });
  if (initiated.status !== 201) {
    throw new Error(`initiate failed: ${String(initiated.status)}`);
  }
  const attachmentId = (initiated.body as { attachment_id: string }).attachment_id;

  const completed = await request(ctx.app)
    .post(`/uploads/${attachmentId}/complete`)
    .set(auth(token))
    .send({ parts: [{ part_number: 1, etag: 'etag-1' }] });
  if (completed.status !== 200) {
    throw new Error(`complete failed: ${String(completed.status)}`);
  }

  return attachmentId;
}
