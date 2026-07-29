import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, makeContext } from './helpers/studentActions';

/**
 * The catalogue is the payload that matters: the student app pulls every row on
 * the critical path of its first paint. Seed enough of it to clear the
 * middleware's default 1KB threshold, then assert what actually goes on the wire.
 */
const BULK_COUNT = 40;

async function seedBulkCatalogue(
  db: Awaited<ReturnType<typeof makeContext>>['db'],
  count = BULK_COUNT,
): Promise<void> {
  await db
    .insertInto('exercises')
    .values(
      Array.from({ length: count }, (_, index) => ({
        id: randomUUID(),
        name: `Bulk Accessory Movement Number ${String(index)}`,
        exercise_type: 'accessory' as const,
        is_competition_lift: false,
        muscle_groups: ['quad', 'glute', 'hamstring'],
        equipment: ['barbell', 'machine'],
        movement_pattern: ['squat'],
      })),
    )
    .execute();
}

function bulkRowCount(body: { exercises: { name: string }[] }): number {
  return body.exercises.filter((row) => row.name.startsWith('Bulk Accessory Movement Number '))
    .length;
}

function requireETag(headers: Record<string, unknown>): string {
  const etag: unknown = headers.etag;
  if (typeof etag !== 'string') {
    throw new Error('expected the catalogue response to carry an ETag');
  }
  return etag;
}

describe('response compression', () => {
  it('compresses a sizeable catalogue response for a client that accepts gzip', async () => {
    const ctx = await makeContext();
    await seedBulkCatalogue(ctx.db);

    const res = await request(ctx.app)
      .get('/exercises')
      .set(auth(ctx.traineeToken))
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    // Caches must key on the negotiated encoding, not just the URL.
    expect(res.headers.vary).toMatch(/accept-encoding/i);
    // supertest transparently inflates, so the body must survive the round trip.
    expect(bulkRowCount(res.body)).toBe(BULK_COUNT);
  });

  it('negotiates brotli when the client prefers it', async () => {
    // compression@1.8 negotiates br ahead of gzip, so a browser sending the
    // usual Accept-Encoding gets br. Both encodings must round-trip intact.
    const ctx = await makeContext();
    await seedBulkCatalogue(ctx.db);

    const res = await request(ctx.app)
      .get('/exercises')
      .set(auth(ctx.traineeToken))
      .set('Accept-Encoding', 'br, gzip');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('br');
    expect(bulkRowCount(res.body)).toBe(BULK_COUNT);
  });

  it('leaves the entity body uncompressed for an identity-only client', async () => {
    // Hard rule 8: a shipped client that cannot inflate must keep working. The
    // entity body and response shape are unchanged — the response as a whole is
    // not byte-for-byte identical, since a Vary: Accept-Encoding header is added.
    const ctx = await makeContext();
    await seedBulkCatalogue(ctx.db);

    const res = await request(ctx.app)
      .get('/exercises')
      .set(auth(ctx.traineeToken))
      .set('Accept-Encoding', 'identity');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(bulkRowCount(res.body)).toBe(BULK_COUNT);
  });

  it('leaves a small response uncompressed', async () => {
    // Below the 1KB threshold compression is pure overhead, so the middleware
    // must stay out of the way. /health is the smallest real response we serve.
    const ctx = await makeContext();

    const res = await request(ctx.app).get('/health').set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});

describe('ETag survives compression', () => {
  // The iOS catalogue cache revalidates with If-None-Match. If compression
  // rewrote the ETag — or made it vary by encoding — that conditional request
  // would never hit and half the client-side win would evaporate.
  it('keeps one weak validator across encodings and answers 304 either way', async () => {
    const ctx = await makeContext();
    await seedBulkCatalogue(ctx.db);

    const identity = await request(ctx.app)
      .get('/exercises')
      .set(auth(ctx.traineeToken))
      .set('Accept-Encoding', 'identity');
    const gzipped = await request(ctx.app)
      .get('/exercises')
      .set(auth(ctx.traineeToken))
      .set('Accept-Encoding', 'gzip');

    const identityETag = requireETag(identity.headers);
    const gzipETag = requireETag(gzipped.headers);

    // Express derives the ETag from the pre-compression body, so the validator
    // is one value regardless of how the bytes were encoded on the way out.
    expect(gzipETag).toBe(identityETag);
    // A weak validator is what makes cross-encoding If-None-Match legitimate.
    expect(identityETag.startsWith('W/')).toBe(true);

    // The validator obtained over identity must revalidate over gzip...
    const gzipRevalidated = await request(ctx.app)
      .get('/exercises')
      .set(auth(ctx.traineeToken))
      .set('Accept-Encoding', 'gzip')
      .set('If-None-Match', identityETag);
    expect(gzipRevalidated.status).toBe(304);

    // ...and the one obtained over gzip must revalidate over identity.
    const identityRevalidated = await request(ctx.app)
      .get('/exercises')
      .set(auth(ctx.traineeToken))
      .set('Accept-Encoding', 'identity')
      .set('If-None-Match', gzipETag);
    expect(identityRevalidated.status).toBe(304);
  });
});
