import type { OSSClient, PresignOptions } from './client';

export const DEFAULT_PRESIGN_TTL_SECONDS = 3600;

export interface SignUrlParams extends Omit<PresignOptions, 'expires'> {
  key: string;
  expires?: number;
}

export function signUrl(oss: Pick<OSSClient, 'signature'>, params: SignUrlParams): string {
  const options: PresignOptions = {
    method: params.method,
    expires: params.expires ?? DEFAULT_PRESIGN_TTL_SECONDS,
  };
  if (params.subResource) options.subResource = params.subResource;
  if (params.contentType) options.contentType = params.contentType;
  return oss.signature(params.key, options);
}
