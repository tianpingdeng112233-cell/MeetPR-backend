import { describe, expect, it } from 'vitest';
import { buildOverviewAlerts, type OverviewAlertsInput } from '../../src/domain/overview-alerts';

const now = new Date('2026-10-22T12:00:00Z');
function first<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('Expected fixture/result row');
  return row;
}
function fixture(): OverviewAlertsInput {
  return {
    now,
    students: [{ id: 'student', timezone: 'Asia/Shanghai' }],
    views: [],
    plans: [
      {
        id: 'plan',
        trainee_id: 'student',
        name: 'Block',
        status: 'published',
        start_date: '2026-10-21',
        end_date: '2026-10-25',
      },
    ],
    days: [{ id: 'day', plan_id: 'plan', week_number: 1, day_of_week: 1 }],
    shifts: [],
    sets: [
      {
        plan_exercise_id: 'exercise',
        plan_day_id: 'day',
        exercise_id: 'squat',
        set_number: 1,
        load_mode: 'rpe',
        target_rpe: '8.0',
        rpe_high: null,
      },
    ],
    logs: [
      {
        student_id: 'student',
        plan_exercise_id: 'exercise',
        set_index: 0,
        rpe: '9.0',
        coach_rpe: null,
        completed: true,
        failed: false,
        logged_date: '2026-10-21',
        logged_at: new Date('2026-10-21T12:00:00Z'),
      },
    ],
    completions: [
      { student_id: 'student', plan_day_id: 'day', completed_at: new Date('2026-10-21T13:00:00Z') },
    ],
  };
}
function items(input: OverviewAlertsInput) {
  return buildOverviewAlerts(input).training.flatMap((student) => student.items);
}

describe('overview alert policy (SPEC 054 §3–7)', () => {
  it.each([
    ['2026-10-25', 3, true],
    ['2026-10-26', 4, false],
    ['2026-10-08', -14, true],
    ['2026-10-07', -15, false],
  ] as const)(
    'plan ending %s has days_left %i and visibility %s',
    (end_date, days_left, visible) => {
      const input = fixture();
      first(input.plans).end_date = end_date;
      const result = buildOverviewAlerts(input).plan_ending;
      expect(result).toEqual(
        visible
          ? [{ student_id: 'student', plan_id: 'plan', plan_name: 'Block', end_date, days_left }]
          : [],
      );
    },
  );
  it.each(['published', 'draft'] as const)('a following %s plan controls plan ending', (status) => {
    const input = fixture();
    input.plans.push({
      ...first(input.plans),
      id: 'next',
      status,
      start_date: '2026-10-26',
      end_date: '2026-11-22',
    });
    expect(buildOverviewAlerts(input).plan_ending).toHaveLength(status === 'published' ? 0 : 1);
  });
  it('plan viewed does not dismiss plan ending', () => {
    const input = fixture();
    input.views = [{ student_id: 'student', seen_at: now }];
    expect(buildOverviewAlerts(input).plan_ending).toHaveLength(1);
    expect(items(input)).toEqual([]);
  });
  it.each([
    ['9.0', null, true],
    ['8.5', null, false],
    ['9.5', '8.5', false],
    ['8.0', '9.0', true],
    ['9.0', '0.0', false],
    [null, null, false],
  ] as const)('RPE %s overridden by %s: over=%s', (rpe, coach_rpe, over) => {
    const input = fixture();
    Object.assign(first(input.logs), { rpe, coach_rpe });
    expect(items(input).filter((item) => item.type === 'rpe_over')).toHaveLength(over ? 1 : 0);
  });
  it.each([
    ['rpe_range', '8.0', true],
    ['rpe_range', null, false],
    ['pct', null, false],
    ['weight', null, false],
    [null, null, false],
  ] as const)('load mode %s with high %s: over=%s', (load_mode, rpe_high, over) => {
    const input = fixture();
    Object.assign(first(input.sets), { load_mode, rpe_high });
    expect(items(input).filter((item) => item.type === 'rpe_over')).toHaveLength(over ? 1 : 0);
  });
  it('does not infer a missing RPE target from legacy intensity fields', () => {
    const input = fixture();
    first(input.sets).target_rpe = null;
    expect(items(input)).toEqual([]);
  });
  it('serializes zero-based set identity and decimal RPE strings', () => {
    expect(items(fixture())).toEqual([
      {
        type: 'rpe_over',
        date: '2026-10-21',
        plan_day_id: 'day',
        plan_exercise_id: 'exercise',
        exercise_id: 'squat',
        set_index: 0,
        target_rpe: '8.0',
        actual_rpe: '9.0',
      },
    ]);
  });
  it('missing prescribed logs on completed days produce missing', () => {
    const input = fixture();
    input.logs = [];
    expect(items(input)).toEqual([
      {
        type: 'incomplete',
        date: '2026-10-21',
        plan_day_id: 'day',
        plan_exercise_id: 'exercise',
        exercise_id: 'squat',
        set_index: 0,
        reason: 'missing',
      },
    ]);
  });
  it.each([
    [false, false, 'missing'],
    [false, true, 'failed'],
    [true, true, 'failed'],
    [true, false, null],
  ] as const)('completed=%s failed=%s produces %s', (completed, failed, reason) => {
    const input = fixture();
    Object.assign(first(input.logs), { completed, failed, rpe: null });
    expect(items(input)).toEqual(
      reason === null ? [] : [expect.objectContaining({ type: 'incomplete', reason })],
    );
  });
  it('does not mark unfinished training days incomplete', () => {
    const input = fixture();
    input.completions = [];
    input.logs = [];
    expect(items(input).filter((item) => item.type === 'incomplete')).toEqual([]);
  });
  it('ignores extra sets and student-added exercises, without filling missing prescription', () => {
    const input = fixture();
    input.logs = [
      { ...first(input.logs), set_index: 1, failed: true },
      { ...first(input.logs), plan_exercise_id: null, failed: true },
    ];
    expect(items(input)).toEqual([
      expect.objectContaining({ type: 'incomplete', set_index: 0, reason: 'missing' }),
    ]);
  });
  it('yesterday is behind only when unfinished and published', () => {
    const input = fixture();
    input.completions = [];
    input.logs = [];
    expect(items(input)).toEqual([
      { type: 'behind', recommended_date: '2026-10-21', plan_day_id: 'day', week_number: 1 },
    ]);
    first(input.plans).status = 'draft';
    expect(items(input)).toEqual([]);
  });
  it('completed days are not behind', () => {
    const input = fixture();
    input.logs = [];
    expect(items(input).filter((item) => item.type === 'behind')).toEqual([]);
  });
  it('uses the latest shift batch, not the original recommendation', () => {
    const input = fixture();
    input.completions = [];
    input.logs = [];
    input.shifts = [
      {
        id: 'shift',
        seq: 1,
        batch_id: 'batch',
        plan_day_id: 'day',
        shifted_to_date: '2026-10-23',
        created_at: now,
      },
    ];
    expect(items(input)).toEqual([]);
  });
  it('excludes eight-day-old logs, completions and recommendations', () => {
    const input = fixture();
    first(input.logs).logged_date = '2026-10-14';
    first(input.logs).completed = false;
    first(input.completions).completed_at = new Date('2026-10-14T12:00:00Z');
    first(input.plans).start_date = '2026-10-14';
    expect(items(input)).toEqual([]);
    input.completions = [];
    expect(items(input)).toEqual([]);
  });
  it('uses seven training dates including today and excludes future logs', () => {
    const input = fixture();
    first(input.logs).logged_date = '2026-10-16';
    expect(items(input)).toHaveLength(1);
    first(input.logs).logged_date = '2026-10-15';
    expect(items(input)).toEqual([]);
    first(input.logs).logged_date = '2026-10-23';
    expect(items(input)).toEqual([]);
  });
  it('only events strictly after seen_at survive, using log and completion instants', () => {
    const input = fixture();
    input.views = [{ student_id: 'student', seen_at: new Date('2026-10-21T12:00:00Z') }];
    expect(items(input)).toEqual([]);
    first(input.logs).logged_at = new Date('2026-10-21T12:00:01Z');
    expect(items(input)).toHaveLength(1);
    input.logs = [];
    expect(items(input)).toEqual([expect.objectContaining({ type: 'incomplete' })]);
    first(input.views).seen_at = new Date('2026-10-21T13:00:00Z');
    expect(items(input)).toEqual([]);
  });
  it('does not reopen a seen completion when an incomplete log is written later', () => {
    const input = fixture();
    input.views = [{ student_id: 'student', seen_at: new Date('2026-10-21T14:00:00Z') }];
    Object.assign(first(input.logs), {
      completed: false,
      failed: true,
      rpe: null,
      logged_at: new Date('2026-10-21T15:00:00Z'),
    });
    expect(items(input)).toEqual([]);
  });
  it('behind compares recommended date against the seen training day', () => {
    const input = fixture();
    input.logs = [];
    input.completions = [];
    input.views = [{ student_id: 'student', seen_at: new Date('2026-10-20T18:00:00Z') }]; // Shanghai 02:00 -> Oct 20
    expect(items(input)).toHaveLength(1);
    first(input.views).seen_at = new Date('2026-10-20T20:00:00Z'); // Shanghai 04:00 -> Oct 21
    expect(items(input)).toEqual([]);
  });
  it('uses each student timezone and the 04:00 cutoff', () => {
    const input = fixture();
    input.now = new Date('2026-10-21T19:59:59Z');
    expect(buildOverviewAlerts(input).plan_ending).toEqual([]); // Shanghai training day Oct 21, four days left
    input.now = new Date('2026-10-21T20:00:00Z');
    expect(buildOverviewAlerts(input).plan_ending).toHaveLength(1);
    first(input.students).timezone = 'America/Los_Angeles';
    expect(buildOverviewAlerts(input).plan_ending).toEqual([]);
  });
  it('sorts items by date and students by latest_at, omitting empty students', () => {
    const input = fixture();
    input.completions = [];
    first(input.logs).logged_date = '2026-10-22';
    first(input.logs).logged_at = now;
    input.students.push(
      { id: 'other', timezone: 'Asia/Shanghai' },
      { id: 'empty', timezone: 'Asia/Shanghai' },
    );
    input.plans.push({ ...first(input.plans), id: 'other-plan', trainee_id: 'other' });
    input.days.push({ ...first(input.days), id: 'other-day', plan_id: 'other-plan' });
    const result = buildOverviewAlerts(input);
    expect(result.training.map((row) => row.student_id)).toEqual(['student', 'other']);
    expect(first(result.training).latest_at).toBe(now.toISOString());
    expect(first(result.training).items.map((item) => item.type)).toEqual(['rpe_over', 'behind']);
    expect(result.generated_at).toBe(now.toISOString());
  });
});
