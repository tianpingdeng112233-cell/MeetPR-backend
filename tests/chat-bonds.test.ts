import { describe, expect, it } from 'vitest';

import { resolveCanonicalAcceptedBond, resolveCanonicalAcceptedBonds } from '../src/db/bonds';
import { ids, makeContext } from './helpers/studentActions';

describe('resolveCanonicalAcceptedBond', () => {
  it('orders responded_at DESC NULLS LAST before submitted_at and id fallbacks', async () => {
    const ctx = await makeContext();

    await ctx.db
      .updateTable('bind_requests')
      .set({ responded_at: new Date('2026-01-01T00:00:00.000Z') })
      .where('coach_id', '=', ids.coach)
      .execute();
    await ctx.db
      .updateTable('bind_requests')
      .set({
        responded_at: null,
        submitted_at: new Date('2026-12-01T00:00:00.000Z'),
      })
      .where('coach_id', '=', ids.otherCoach)
      .execute();

    expect((await resolveCanonicalAcceptedBond(ctx.db, ids.trainee))?.coach_id).toBe(ids.coach);

    await ctx.db
      .updateTable('bind_requests')
      .set({ responded_at: null, submitted_at: new Date('2026-02-01T00:00:00.000Z') })
      .where('coach_id', '=', ids.coach)
      .execute();
    expect((await resolveCanonicalAcceptedBond(ctx.db, ids.trainee))?.coach_id).toBe(
      ids.otherCoach,
    );

    await ctx.db
      .updateTable('bind_requests')
      .set({ submitted_at: new Date('2026-03-01T00:00:00.000Z') })
      .where('student_id', '=', ids.trainee)
      .execute();
    const rows = await ctx.db
      .selectFrom('bind_requests')
      .select('id')
      .where('student_id', '=', ids.trainee)
      .where('status', '=', 'accepted')
      .execute();
    const expectedId = rows
      .map((row) => row.id)
      .sort()
      .at(-1);

    expect((await resolveCanonicalAcceptedBond(ctx.db, ids.trainee))?.id).toBe(expectedId);
  });

  it('returns undefined without an accepted bond', async () => {
    const ctx = await makeContext();
    await expect(resolveCanonicalAcceptedBond(ctx.db, ids.otherStudent)).resolves.toBeUndefined();
  });

  it('batch-resolves one canonical row per student with the same ordering', async () => {
    const ctx = await makeContext();
    await ctx.db
      .insertInto('bind_requests')
      .values({
        student_id: ids.otherStudent,
        coach_id: ids.otherCoach,
        status: 'accepted',
        responded_at: new Date('2026-03-01T00:00:00.000Z'),
        expired_at: new Date('2027-01-01T00:00:00.000Z'),
      })
      .execute();
    await ctx.db
      .updateTable('bind_requests')
      .set({ responded_at: new Date('2026-02-01T00:00:00.000Z') })
      .where('student_id', '=', ids.trainee)
      .where('coach_id', '=', ids.coach)
      .execute();

    const canonical = await resolveCanonicalAcceptedBonds(ctx.db, [ids.trainee, ids.otherStudent]);
    expect(new Map(canonical.map((row) => [row.student_id, row.coach_id]))).toEqual(
      new Map([
        [ids.trainee, ids.coach],
        [ids.otherStudent, ids.otherCoach],
      ]),
    );
  });
});
