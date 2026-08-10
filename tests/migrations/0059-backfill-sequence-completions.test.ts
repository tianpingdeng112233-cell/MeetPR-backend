import { describe, expect, it } from 'vitest';

import {
  createBaseUsers,
  createPlanSchema,
  makeMigrationDb,
  runMigration,
} from '../helpers/migrations';

const coachId = '10000000-0000-4000-8000-000000000001';
const studentId = '10000000-0000-4000-8000-000000000003';

// Seeded by createPlanSchema: published plan starting 2026-05-01 with W1D1.
const mayPlanId = '30000000-0000-4000-8000-000000000001';
const dayPastId = '40000000-0000-4000-8000-000000000001';

const augPlanId = '30000000-0000-4000-8000-000000000011';
const draftPlanId = '30000000-0000-4000-8000-000000000012';
const completedPlanId = '30000000-0000-4000-8000-000000000013';
const pausedPlanId = '30000000-0000-4000-8000-000000000014';
const dayShiftFutureId = '40000000-0000-4000-8000-000000000002';
const dayShiftPastId = '40000000-0000-4000-8000-000000000003';
const dayManualId = '40000000-0000-4000-8000-000000000004';
const dayAugPastId = '40000000-0000-4000-8000-000000000011';
const dayAugCutoffId = '40000000-0000-4000-8000-000000000012';
const dayDraftId = '40000000-0000-4000-8000-000000000013';
const dayCompletedId = '40000000-0000-4000-8000-000000000014';
const dayPausedId = '40000000-0000-4000-8000-000000000015';
const dayTieBreakId = '40000000-0000-4000-8000-000000000016';

function setup() {
  const mem = makeMigrationDb();
  createBaseUsers(mem);
  createPlanSchema(mem);
  // pg-mem cannot replay 0038's DROP CONSTRAINT, so create plan_day_shifts
  // directly in its post-0038 shape (same shortcut createPlanSchema takes).
  mem.public.none(`
    CREATE TABLE plan_day_shifts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_day_id UUID NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES users(id),
      shifted_to_date DATE NOT NULL,
      batch_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  runMigration(mem, 'db/migrations/0057-sequence-progression.sql');

  mem.public.none(`
    INSERT INTO plans (
      id, coach_id, trainee_id, name, start_date, end_date,
      plan_weeks, source, status
    ) VALUES
      ('${augPlanId}', '${coachId}', '${studentId}', 'August Block',
       '2026-08-07', '2026-09-03', 4, 'coach', 'published'),
      ('${draftPlanId}', '${coachId}', '${studentId}', 'Draft Block',
       '2026-05-01', '2026-05-28', 4, 'coach', 'draft'),
      ('${completedPlanId}', '${coachId}', '${studentId}', 'Completed Block',
       '2026-04-01', '2026-04-28', 4, 'coach', 'completed'),
      ('${pausedPlanId}', '${coachId}', '${studentId}', 'Paused Block',
       '2026-05-01', '2026-05-28', 4, 'coach', 'paused');

    INSERT INTO plan_days (id, plan_id, day_of_week, week_number, sort_order) VALUES
      ('${dayShiftFutureId}', '${mayPlanId}', 2, 1, 0),
      ('${dayShiftPastId}', '${mayPlanId}', 3, 1, 0),
      ('${dayManualId}', '${mayPlanId}', 4, 1, 0),
      ('${dayTieBreakId}', '${mayPlanId}', 5, 1, 0),
      ('${dayAugPastId}', '${augPlanId}', 1, 1, 0),
      ('${dayAugCutoffId}', '${augPlanId}', 3, 1, 0),
      ('${dayDraftId}', '${draftPlanId}', 1, 1, 0),
      ('${dayCompletedId}', '${completedPlanId}', 1, 1, 0),
      ('${dayPausedId}', '${pausedPlanId}', 1, 1, 0);

    -- Old-regime shifts: latest row (created_at desc, id tiebreak) wins.
    INSERT INTO plan_day_shifts (
      id, plan_day_id, student_id, shifted_to_date, batch_id, created_at
    ) VALUES
      -- W1D2 (positional 5/2) pushed to the cutoff day itself: must survive.
      ('60000000-0000-4000-8000-000000000001', '${dayShiftFutureId}', '${studentId}',
       '2026-08-09', '70000000-0000-4000-8000-000000000001', '2026-07-01T00:00:00Z'),
      -- W1D3: first pushed past the cutoff, then a later batch pulled it back.
      ('60000000-0000-4000-8000-000000000002', '${dayShiftPastId}', '${studentId}',
       '2026-08-20', '70000000-0000-4000-8000-000000000002', '2026-07-01T00:00:00Z'),
      ('60000000-0000-4000-8000-000000000003', '${dayShiftPastId}', '${studentId}',
       '2026-08-01', '70000000-0000-4000-8000-000000000003', '2026-07-05T00:00:00Z'),
      -- W1D5: identical created_at — the higher UUID must win (id tiebreak).
      ('60000000-0000-4000-8000-000000000004', '${dayTieBreakId}', '${studentId}',
       '2026-08-25', '70000000-0000-4000-8000-000000000004', '2026-07-06T00:00:00Z'),
      ('60000000-0000-4000-8000-000000000005', '${dayTieBreakId}', '${studentId}',
       '2026-07-20', '70000000-0000-4000-8000-000000000005', '2026-07-06T00:00:00Z');

    -- Real settlement made before the backfill runs: must stay untouched.
    INSERT INTO plan_day_completions (plan_day_id, student_id, source, completed_at)
    VALUES ('${dayManualId}', '${studentId}', 'manual', '2026-08-10T04:08:00Z');
  `);
  runMigration(mem, 'db/migrations/0059-backfill-sequence-completions.sql');
  return mem;
}

function completionsByDay(mem: ReturnType<typeof makeMigrationDb>) {
  const rows = mem.public.many(
    `SELECT plan_day_id, student_id, source, completed_at FROM plan_day_completions`,
  ) as {
    plan_day_id: string;
    student_id: string;
    source: string;
    completed_at: Date;
  }[];
  return new Map(rows.map((row) => [row.plan_day_id, row]));
}

describe('migration 0059 backfill sequence completions', () => {
  it('backfills days whose old-regime effective date is before 2026-08-09', () => {
    const mem = setup();
    const byDay = completionsByDay(mem);

    const past = byDay.get(dayPastId);
    expect(past).toMatchObject({ student_id: studentId, source: 'backfill' });
    expect(past?.completed_at.toISOString()).toBe('2026-05-01T00:00:00.000Z');

    const augPast = byDay.get(dayAugPastId);
    expect(augPast).toMatchObject({ source: 'backfill' });
    expect(augPast?.completed_at.toISOString()).toBe('2026-08-07T00:00:00.000Z');

    // Completed plans are part of the cursor-domain backfill too.
    const completed = byDay.get(dayCompletedId);
    expect(completed).toMatchObject({ source: 'backfill' });
    expect(completed?.completed_at.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('leaves days at or after the cutoff incomplete, including shifted ones', () => {
    const mem = setup();
    const byDay = completionsByDay(mem);

    // Positional 8/9 — the boundary day stays as the cursor.
    expect(byDay.has(dayAugCutoffId)).toBe(false);
    // Positional 5/2 but shifted to 8/9 — the shift overlay must win.
    expect(byDay.has(dayShiftFutureId)).toBe(false);
    // Draft/paused plans never enter the cursor domain.
    expect(byDay.has(dayDraftId)).toBe(false);
    expect(byDay.has(dayPausedId)).toBe(false);
  });

  it('resolves the latest shift batch and stamps its date on the completion', () => {
    const mem = setup();
    const row = completionsByDay(mem).get(dayShiftPastId);
    expect(row).toMatchObject({ source: 'backfill' });
    expect(row?.completed_at.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('breaks created_at ties by id, matching latestShiftByDay()', () => {
    const mem = setup();
    const row = completionsByDay(mem).get(dayTieBreakId);
    // Higher-id row points at 7/20 (< cutoff); if the tiebreak regressed to the
    // lower id, the 8/25 shift would win and no completion would exist at all.
    expect(row).toMatchObject({ source: 'backfill' });
    expect(row?.completed_at.toISOString()).toBe('2026-07-20T00:00:00.000Z');
  });

  it('never overwrites an existing completion', () => {
    const mem = setup();
    const row = completionsByDay(mem).get(dayManualId);
    expect(row).toMatchObject({ source: 'manual' });
    expect(row?.completed_at.toISOString()).toBe('2026-08-10T04:08:00.000Z');
  });

  it('is idempotent when replayed', () => {
    const mem = setup();
    runMigration(mem, 'db/migrations/0059-backfill-sequence-completions.sql');
    const rows = mem.public.many(`SELECT plan_day_id FROM plan_day_completions`);
    expect(rows).toHaveLength(6);
  });
});
