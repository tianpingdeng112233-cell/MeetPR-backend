import type { Config } from '../config';
import type { OssService } from './oss';
import { maybeCreateOssService } from './oss';
import { maybeCreateS3StorageService } from './s3-storage';

type StorageConfig = Pick<
  Config,
  | 'STORAGE_BACKEND'
  | 'OSS_ACCESS_KEY_ID'
  | 'OSS_ACCESS_KEY_SECRET'
  | 'OSS_BUCKET'
  | 'OSS_REGION'
  | 'OSS_ENDPOINT'
  | 'OSS_ACCELERATE_ENDPOINT'
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_BUCKET'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
>;

/**
 * CN-line invariant: STORAGE_BACKEND defaults to 'oss' and MUST keep resolving
 * to the OSS factory so an unset variable is byte-identical to the pre-S3
 * assembly. 's3' is opt-in for the overseas deployment only.
 */
export function selectStorageService(config: StorageConfig): OssService | undefined {
  return config.STORAGE_BACKEND === 's3'
    ? maybeCreateS3StorageService(config)
    : maybeCreateOssService(config);
}
