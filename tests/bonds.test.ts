import { describe, expect, it } from 'vitest';
import { hasAcceptedBond, hasCoachReadAccess } from '../src/db/bonds';
import { ids, makeContext } from './helpers/studentActions';

describe('coach bond permissions', () => {
  it.each(['accepted', 'ended', 'pending', 'cancelled', 'rejected', 'expired'] as const)(
    'allows historical reads but only active writes for %s',
    async (status) => {
      const ctx = await makeContext();
      await ctx.db
        .updateTable('bind_requests')
        .set({ status })
        .where('coach_id', '=', ids.coach)
        .where('student_id', '=', ids.trainee)
        .execute();
      expect(await hasCoachReadAccess(ctx.db, ids.coach, ids.trainee)).toBe(
        status === 'accepted' || status === 'ended',
      );
      expect(await hasAcceptedBond(ctx.db, ids.coach, ids.trainee)).toBe(status === 'accepted');
      expect(await hasCoachReadAccess(ctx.db, ids.coach, ids.otherStudent)).toBe(false);
      await ctx.db.destroy();
    },
  );
});
