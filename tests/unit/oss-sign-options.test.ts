import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../../src/db/types';
import { requesterOssSignOptions } from '../../src/handlers/oss-sign-options';
import type { OssService } from '../../src/services/oss';

function fakeDb(executeTakeFirst: () => Promise<{ phone: string | null } | undefined>) {
  const selectFrom = vi.fn(() => ({
    select: () => ({ where: () => ({ executeTakeFirst }) }),
  }));
  return { db: { selectFrom } as unknown as Kysely<Database>, selectFrom };
}

function fakeOss(accelerationEnabled: boolean): OssService {
  return { accelerationEnabled } as OssService;
}

describe('requesterOssSignOptions', () => {
  it('skips the lookup entirely when no OSS service is configured', async () => {
    const { db, selectFrom } = fakeDb(() => Promise.resolve({ phone: null }));

    await expect(requesterOssSignOptions(db, undefined, 'user-1')).resolves.toEqual({
      useAccelerateEndpoint: false,
    });
    expect(selectFrom).not.toHaveBeenCalled();
  });

  it('skips the lookup entirely when acceleration is disabled', async () => {
    const { db, selectFrom } = fakeDb(() => Promise.resolve({ phone: null }));

    await expect(requesterOssSignOptions(db, fakeOss(false), 'user-1')).resolves.toEqual({
      useAccelerateEndpoint: false,
    });
    expect(selectFrom).not.toHaveBeenCalled();
  });

  it('accelerates for a phoneless (Global track) requester', async () => {
    const { db } = fakeDb(() => Promise.resolve({ phone: null }));

    await expect(requesterOssSignOptions(db, fakeOss(true), 'user-1')).resolves.toEqual({
      useAccelerateEndpoint: true,
    });
  });

  it('keeps the default host for a requester with a phone number', async () => {
    const { db } = fakeDb(() => Promise.resolve({ phone: '13800000000' }));

    await expect(requesterOssSignOptions(db, fakeOss(true), 'user-1')).resolves.toEqual({
      useAccelerateEndpoint: false,
    });
  });

  it('returns null when the user row no longer exists (caller answers 401)', async () => {
    const { db } = fakeDb(() => Promise.resolve(undefined));

    await expect(requesterOssSignOptions(db, fakeOss(true), 'user-1')).resolves.toBeNull();
  });

  it('degrades to default-host signing when the lookup itself fails', async () => {
    const { db } = fakeDb(() => Promise.reject(new Error('connection reset')));
    const logger = { warn: vi.fn() };

    await expect(requesterOssSignOptions(db, fakeOss(true), 'user-1', logger)).resolves.toEqual({
      useAccelerateEndpoint: false,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      'oss_accelerate_lookup_failed',
    );
  });
});
