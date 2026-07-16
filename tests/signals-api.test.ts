import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { SignalSeverity, SignalStatus, SignalType } from '../src/db/types';
import { timestamp } from '../src/handlers/serialization';
import { normalizeDateOnly, shanghaiTrainingDay, utcDate, utcDateOnly } from '../src/utils/date';
import { auth, ids, makeContext, type TestContext } from './helpers/studentActions';

const signalIds = {
  redOld: '81000000-0000-4000-8000-000000000001',
  redNew: '81000000-0000-4000-8000-000000000002',
  yellow: '81000000-0000-4000-8000-000000000003',
  green: '81000000-0000-4000-8000-000000000004',
  acked: '81000000-0000-4000-8000-000000000005',
  otherCoach: '81000000-0000-4000-8000-000000000006',
};

interface SignalFixture {
  id: string;
  studentId?: string;
  coachId?: string;
  signalType?: SignalType;
  severity?: SignalSeverity;
  status?: SignalStatus;
  reason?: string;
  payload?: Record<string, unknown>;
  openedAt?: Date;
  expiresAt?: Date | null;
}

async function insertSignal(ctx: TestContext, fixture: SignalFixture): Promise<void> {
  await ctx.db
    .insertInto('student_signals')
    .values({
      id: fixture.id,
      student_id: fixture.studentId ?? ids.trainee,
      coach_id: fixture.coachId ?? ids.coach,
      signal_type: fixture.signalType ?? 'missed_training',
      severity: fixture.severity ?? 'red',
      status: fixture.status ?? 'open',
      reason: fixture.reason ?? '连续缺练',
      payload: JSON.stringify(fixture.payload ?? { consecutive_count: 3 }),
      opened_at: fixture.openedAt ?? new Date('2026-07-10T08:00:00.000Z'),
      expires_at:
        fixture.expiresAt === undefined ? new Date('2026-07-17T08:00:00.000Z') : fixture.expiresAt,
    })
    .execute();
}

async function insertEvent(
  ctx: TestContext,
  fixture: {
    id: string;
    studentId?: string;
    coachId?: string | null;
    eventType?: 'session_completed' | 'session_partial' | 'pr_e1rm';
    sessionDate: string;
    occurredAt: Date;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await ctx.db
    .insertInto('student_events')
    .values({
      id: fixture.id,
      student_id: fixture.studentId ?? ids.trainee,
      coach_id: fixture.coachId === undefined ? ids.coach : fixture.coachId,
      event_type: fixture.eventType ?? 'session_completed',
      session_date: fixture.sessionDate,
      occurred_at: fixture.occurredAt,
      payload: JSON.stringify(fixture.payload),
      dedup_key: `test:${fixture.id}`,
    })
    .execute();
}

describe('GET /coach/signals', () => {
  it('returns only the coach open signals in severity then newest-first order', async () => {
    const ctx = await makeContext();
    await insertSignal(ctx, {
      id: signalIds.redOld,
      openedAt: new Date('2026-07-10T08:00:00.000Z'),
      reason: 'red old',
    });
    await insertSignal(ctx, {
      id: signalIds.redNew,
      studentId: ids.otherStudent,
      openedAt: new Date('2026-07-11T08:00:00.000Z'),
      reason: 'red new',
    });
    await insertSignal(ctx, {
      id: signalIds.yellow,
      studentId: ids.selfTrainStudent,
      severity: 'yellow',
      openedAt: new Date('2026-07-12T08:00:00.000Z'),
      expiresAt: null,
      reason: 'yellow',
    });
    await insertSignal(ctx, {
      id: signalIds.green,
      signalType: 'pr_congrats',
      severity: 'green',
      openedAt: new Date('2026-07-13T08:00:00.000Z'),
      payload: { family: 'squat', e1rm: 180 },
      reason: 'green',
    });
    await insertSignal(ctx, {
      id: signalIds.acked,
      studentId: ids.otherStudent,
      signalType: 'pr_congrats',
      severity: 'green',
      status: 'acked',
    });
    await insertSignal(ctx, {
      id: signalIds.otherCoach,
      coachId: ids.otherCoach,
      signalType: 'pr_congrats',
      severity: 'green',
    });

    const response = await request(ctx.app).get('/coach/signals').set(auth(ctx.coachToken));

    expect(response.status).toBe(200);
    expect(response.body.signals.map((signal: { id: string }) => signal.id)).toEqual([
      signalIds.redNew,
      signalIds.redOld,
      signalIds.yellow,
      signalIds.green,
    ]);
    expect(response.body.signals[0]).toEqual({
      id: signalIds.redNew,
      student_id: ids.otherStudent,
      student_name: 'Other Student',
      signal_type: 'missed_training',
      severity: 'red',
      status: 'open',
      reason: 'red new',
      payload: { consecutive_count: 3 },
      opened_at: timestamp(new Date('2026-07-11T08:00:00.000Z')),
      expires_at: timestamp(new Date('2026-07-17T08:00:00.000Z')),
    });
    expect(response.body.signals[2].expires_at).toBeNull();

    const acked = await request(ctx.app)
      .get('/coach/signals?status=acked')
      .set(auth(ctx.coachToken));
    expect(acked.status).toBe(200);
    expect(acked.body.signals.map((signal: { id: string }) => signal.id)).toEqual([
      signalIds.acked,
    ]);
  });

  it('validates status and rejects a student role', async () => {
    const ctx = await makeContext();

    const invalid = await request(ctx.app)
      .get('/coach/signals?status=closed')
      .set(auth(ctx.coachToken));
    const student = await request(ctx.app).get('/coach/signals').set(auth(ctx.traineeToken));

    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('VALIDATION_ERROR');
    expect(student.status).toBe(403);
    expect(student.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
  });

  it('never drops a signal for a student without a profile row, and ack still works', async () => {
    const ctx = await makeContext();
    const profileless = '10000000-0000-4000-8000-000000000099';
    await ctx.db
      .insertInto('users')
      .values({
        id: profileless,
        phone: '+8613800009999',
        password_hash: 'x',
        role: 'coached_student',
      })
      .execute();
    const signalId = '81000000-0000-4000-8000-000000000007';
    await insertSignal(ctx, { id: signalId, studentId: profileless });

    const listed = await request(ctx.app).get('/coach/signals').set(auth(ctx.coachToken));
    expect(listed.status).toBe(200);
    const row = (listed.body as { signals: { id: string; student_name: string }[] }).signals.find(
      (signal) => signal.id === signalId,
    );
    expect(row).toBeDefined();
    expect(row?.student_name).toBe('');

    const acked = await request(ctx.app)
      .post(`/coach/signals/${signalId}/ack`)
      .set(auth(ctx.coachToken));
    expect(acked.status).toBe(200);
    expect(acked.body).toMatchObject({ id: signalId, status: 'acked', student_name: '' });
  });
});

describe('POST /coach/signals/:id/ack', () => {
  it('acks an owned open signal in a transaction after locking its user row', async () => {
    const statements: string[] = [];
    const ctx = await makeContext(undefined, {
      afterQuery: (query) => {
        statements.push(query.toLowerCase());
        return Promise.resolve();
      },
    });
    const openedAt = new Date('2026-07-10T08:00:00.000Z');
    const expiresAt = new Date('2026-07-17T08:00:00.000Z');
    await insertSignal(ctx, {
      id: signalIds.redOld,
      openedAt,
      expiresAt,
      payload: { missed_dates: ['2026-07-08', '2026-07-09', '2026-07-10'] },
    });
    statements.length = 0;

    const response = await request(ctx.app)
      .post(`/coach/signals/${signalIds.redOld}/ack`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: signalIds.redOld,
      student_id: ids.trainee,
      student_name: 'Trainee One',
      signal_type: 'missed_training',
      severity: 'red',
      status: 'acked',
      reason: '连续缺练',
      payload: { missed_dates: ['2026-07-08', '2026-07-09', '2026-07-10'] },
      opened_at: timestamp(openedAt),
      expires_at: timestamp(expiresAt),
    });

    const stored = await ctx.db
      .selectFrom('student_signals')
      .select(['status', 'acked_at', 'updated_at'])
      .where('id', '=', signalIds.redOld)
      .executeTakeFirstOrThrow();
    expect(stored.status).toBe('acked');
    expect(stored.acked_at).toBeInstanceOf(Date);
    expect(stored.updated_at).toEqual(stored.acked_at);

    const lockIndex = statements.findIndex(
      (statement) => statement.includes('from "users"') && statement.includes('for update'),
    );
    const updateIndex = statements.findIndex((statement) =>
      statement.startsWith('update "student_signals"'),
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThan(lockIndex);
  });

  it('hides another coach signal and rejects repeated or non-open ack', async () => {
    const ctx = await makeContext();
    await insertSignal(ctx, { id: signalIds.redOld });
    await insertSignal(ctx, {
      id: signalIds.otherCoach,
      coachId: ids.otherCoach,
      signalType: 'pr_congrats',
      severity: 'green',
    });
    await insertSignal(ctx, {
      id: signalIds.acked,
      studentId: ids.otherStudent,
      status: 'auto_resolved',
    });

    const hidden = await request(ctx.app)
      .post(`/coach/signals/${signalIds.otherCoach}/ack`)
      .set(auth(ctx.coachToken));
    const first = await request(ctx.app)
      .post(`/coach/signals/${signalIds.redOld}/ack`)
      .set(auth(ctx.coachToken));
    const repeated = await request(ctx.app)
      .post(`/coach/signals/${signalIds.redOld}/ack`)
      .set(auth(ctx.coachToken));
    const resolved = await request(ctx.app)
      .post(`/coach/signals/${signalIds.acked}/ack`)
      .set(auth(ctx.coachToken));

    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({ error: 'SIGNAL_NOT_FOUND' });
    expect(first.status).toBe(200);
    expect(repeated.status).toBe(409);
    expect(repeated.body).toEqual({ error: 'SIGNAL_NOT_OPEN' });
    expect(resolved.status).toBe(409);
    expect(resolved.body).toEqual({ error: 'SIGNAL_NOT_OPEN' });
  });
});

describe('GET /coach/students/:studentId/events', () => {
  it('returns the bonded student timeline in occurred_at descending order', async () => {
    const ctx = await makeContext();
    const olderAt = new Date('2026-07-05T08:00:00.000Z');
    const newerAt = new Date('2026-07-06T09:30:00.000Z');
    await insertEvent(ctx, {
      id: '82000000-0000-4000-8000-000000000001',
      sessionDate: '2026-07-05',
      occurredAt: olderAt,
      payload: { duration_seconds: 1200 },
    });
    await insertEvent(ctx, {
      id: '82000000-0000-4000-8000-000000000002',
      coachId: ids.otherCoach,
      eventType: 'pr_e1rm',
      sessionDate: '2026-07-06',
      occurredAt: newerAt,
      payload: { family: 'squat', e1rm: 181.5 },
    });
    await insertEvent(ctx, {
      id: '82000000-0000-4000-8000-000000000003',
      sessionDate: '2026-06-30',
      occurredAt: new Date('2026-06-30T08:00:00.000Z'),
      payload: {},
    });
    await insertEvent(ctx, {
      id: '82000000-0000-4000-8000-000000000004',
      studentId: ids.otherStudent,
      sessionDate: '2026-07-06',
      occurredAt: new Date('2026-07-06T10:00:00.000Z'),
      payload: {},
    });

    const response = await request(ctx.app)
      .get(`/coach/students/${ids.trainee}/events?from=2026-07-01&to=2026-07-10`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      events: [
        {
          id: '82000000-0000-4000-8000-000000000002',
          event_type: 'pr_e1rm',
          session_date: normalizeDateOnly('2026-07-06'),
          occurred_at: timestamp(newerAt),
          payload: { family: 'squat', e1rm: 181.5 },
        },
        {
          id: '82000000-0000-4000-8000-000000000001',
          event_type: 'session_completed',
          session_date: normalizeDateOnly('2026-07-05'),
          occurred_at: timestamp(olderAt),
          payload: { duration_seconds: 1200 },
        },
      ],
    });
  });

  it('defaults to the latest 28 gym days and requires an accepted bond', async () => {
    const ctx = await makeContext();
    const today = shanghaiTrainingDay();
    const oldestIncluded = utcDateOnly(new Date(utcDate(today).getTime() - 27 * 86_400_000));
    const outside = utcDateOnly(new Date(utcDate(today).getTime() - 28 * 86_400_000));
    await insertEvent(ctx, {
      id: '82000000-0000-4000-8000-000000000005',
      sessionDate: oldestIncluded,
      occurredAt: new Date(`${oldestIncluded}T08:00:00.000Z`),
      payload: {},
    });
    await insertEvent(ctx, {
      id: '82000000-0000-4000-8000-000000000006',
      sessionDate: outside,
      occurredAt: new Date(`${outside}T08:00:00.000Z`),
      payload: {},
    });

    const defaultRange = await request(ctx.app)
      .get(`/coach/students/${ids.trainee}/events`)
      .set(auth(ctx.coachToken));
    const unbound = await request(ctx.app)
      .get(`/coach/students/${ids.otherStudent}/events`)
      .set(auth(ctx.coachToken));

    expect(defaultRange.status).toBe(200);
    expect(defaultRange.body.events.map((event: { id: string }) => event.id)).toEqual([
      '82000000-0000-4000-8000-000000000005',
    ]);
    expect(unbound.status).toBe(403);
    expect(unbound.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
  });

  it.each([
    ['from', '2026-02-30'],
    ['to', '2026/07/10'],
  ])('validates the %s date', async (key, value) => {
    const ctx = await makeContext();
    const response = await request(ctx.app)
      .get(`/coach/students/${ids.trainee}/events?${key}=${value}`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects an inverted date range', async () => {
    const ctx = await makeContext();
    const response = await request(ctx.app)
      .get(`/coach/students/${ids.trainee}/events?from=2026-07-11&to=2026-07-10`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
  });
});

describe('GET /students/me/session', () => {
  it('returns null without a session and validates date', async () => {
    const ctx = await makeContext();

    const empty = await request(ctx.app)
      .get('/students/me/session?date=2026-07-10')
      .set(auth(ctx.traineeToken));
    const invalid = await request(ctx.app)
      .get('/students/me/session?date=2026-02-30')
      .set(auth(ctx.traineeToken));

    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ session: null });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('VALIDATION_ERROR');
  });

  it('uses the current gym day and serializes a self-train student session', async () => {
    const ctx = await makeContext();
    const today = shanghaiTrainingDay();
    const startedAt = new Date('2026-07-10T08:00:00.250Z');
    const lastSetAt = new Date('2026-07-10T09:02:03.999Z');
    const completedAt = new Date('2026-07-10T09:02:04.000Z');
    await ctx.db
      .insertInto('training_sessions')
      .values({
        student_id: ids.selfTrainStudent,
        session_date: today,
        status: 'completed',
        started_at: startedAt,
        last_set_at: lastSetAt,
        completed_at: completedAt,
      })
      .execute();

    const response = await request(ctx.app)
      .get('/students/me/session')
      .set(auth(ctx.selfTrainStudentToken));
    const asCoach = await request(ctx.app).get('/students/me/session').set(auth(ctx.coachToken));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      session: {
        status: 'completed',
        started_at: timestamp(startedAt),
        last_set_at: timestamp(lastSetAt),
        completed_at: timestamp(completedAt),
        duration_seconds: 3723,
      },
    });
    expect(asCoach.status).toBe(403);
    expect(asCoach.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
  });
});
