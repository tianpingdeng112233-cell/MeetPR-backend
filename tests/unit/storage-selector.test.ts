import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config';
import { selectStorageService } from '../../src/services/storage-selector';

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  JWT_ACCESS_SECRET: 'selector-access-secret-min-32-characters',
  JWT_REFRESH_SECRET: 'selector-refresh-secret-min-32-characters',
};

const ossEnv = {
  OSS_ACCESS_KEY_ID: 'oss-key',
  OSS_ACCESS_KEY_SECRET: 'oss-secret',
  OSS_BUCKET: 'oss-bucket',
  OSS_REGION: 'oss-cn-hangzhou',
};

const s3Env = {
  S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
  S3_REGION: 'auto',
  S3_BUCKET: 's3-bucket',
  S3_ACCESS_KEY_ID: 's3-key',
  S3_SECRET_ACCESS_KEY: 's3-secret',
};

// CN red line: an unset STORAGE_BACKEND must keep the exact pre-S3 assembly.
describe('storage backend selection (server assembly)', () => {
  it('defaults to the OSS factory when STORAGE_BACKEND is unset', () => {
    const service = selectStorageService(loadConfig({ ...base, ...ossEnv, ...s3Env }));
    expect(service).toBeDefined();
    // The OSS implementation is the only one that can enable acceleration.
    expect(service?.accelerationEnabled).toBe(false);
    const s3Only = selectStorageService(loadConfig({ ...base, ...s3Env }));
    expect(s3Only).toBeUndefined();
  });

  it('selects the S3 factory when STORAGE_BACKEND=s3', () => {
    const service = selectStorageService(loadConfig({ ...base, ...s3Env, STORAGE_BACKEND: 's3' }));
    expect(service).toBeDefined();
    const ossOnly = selectStorageService(loadConfig({ ...base, ...ossEnv, STORAGE_BACKEND: 's3' }));
    expect(ossOnly).toBeUndefined();
  });

  it('keeps OSS acceleration reachable only through the OSS backend', () => {
    const oss = selectStorageService(
      loadConfig({
        ...base,
        ...ossEnv,
        OSS_ACCELERATE_ENDPOINT: 'https://oss-accelerate.aliyuncs.com',
      }),
    );
    expect(oss?.accelerationEnabled).toBe(true);
    const s3 = selectStorageService(
      loadConfig({
        ...base,
        ...s3Env,
        STORAGE_BACKEND: 's3',
        OSS_ACCELERATE_ENDPOINT: 'https://oss-accelerate.aliyuncs.com',
      }),
    );
    expect(s3?.accelerationEnabled).toBe(false);
  });
});
