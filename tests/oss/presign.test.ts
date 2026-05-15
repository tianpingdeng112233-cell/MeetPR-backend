import { describe, expect, it } from 'vitest';

import { signUrl } from '../../src/oss/presign';
import { FakeOSSClient, validVideoKey } from '../helpers/video';

describe('OSS presign helper', () => {
  it('uses 1h TTL by default and preserves method/subresources', () => {
    const oss = new FakeOSSClient();
    const url = signUrl(oss, {
      method: 'PUT',
      key: validVideoKey(),
      subResource: { uploadId: 'upload-1', partNumber: 7 },
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get('Expires')).toBe('3600');
    expect(parsed.searchParams.get('method')).toBe('PUT');
    expect(parsed.searchParams.get('uploadId')).toBe('upload-1');
    expect(parsed.searchParams.get('partNumber')).toBe('7');
  });

  it('respects caller TTL and GET method', () => {
    const oss = new FakeOSSClient();
    const url = signUrl(oss, { method: 'GET', key: validVideoKey(), expires: 120 });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('Expires')).toBe('120');
    expect(parsed.searchParams.get('method')).toBe('GET');
  });
});
