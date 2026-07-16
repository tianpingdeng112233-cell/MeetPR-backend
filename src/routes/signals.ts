import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';

import { hasAcceptedBond } from '../db/bonds';
import {
  SIGNAL_STATUSES,
  type Database,
  type StudentEventsTable,
  type StudentSignalsTable,
} from '../db/types';
import { timestamp } from '../handlers/serialization';
import type { Logger } from '../logger';
import { requireRole } from '../middleware/auth';
import {
  isIsoCalendarDate,
  isoCalendarDateSchemaMessage,
  normalizeDateOnly,
  shanghaiTrainingDay,
  utcDate,
  utcDateOnly,
} from '../utils/date';
import { route, validationEnvelope } from './http';

interface SignalsRouterDeps {
  db: Kysely<Database>;
  logger: Logger;
}

type SignalRow = Pick<
  Selectable<StudentSignalsTable>,
  | 'id'
  | 'student_id'
  | 'signal_type'
  | 'severity'
  | 'status'
  | 'reason'
  | 'payload'
  | 'opened_at'
  | 'expires_at'
> & { student_name: string };

type EventRow = Pick<
  Selectable<StudentEventsTable>,
  'id' | 'event_type' | 'session_date' | 'occurred_at' | 'payload'
>;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EVENT_DAYS = 28;

const DateSchema = z
  .string()
  .refine(isIsoCalendarDate, { message: isoCalendarDateSchemaMessage() });
const SignalIdParamsSchema = z.object({ id: z.string().uuid() });
const StudentIdParamsSchema = z.object({ studentId: z.string().uuid() });
const SignalsQuerySchema = z
  .object({
    status: z.enum(SIGNAL_STATUSES).default('open'),
  })
  .strict();
const EventsQuerySchema = z
  .object({
    from: DateSchema.optional(),
    to: DateSchema.optional(),
  })
  .strict();
const SessionQuerySchema = z
  .object({
    date: DateSchema.optional(),
  })
  .strict();

function payload(value: Record<string, unknown> | string): unknown {
  return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
}

function signalResponse(row: SignalRow) {
  return {
    id: row.id,
    student_id: row.student_id,
    student_name: row.student_name,
    signal_type: row.signal_type,
    severity: row.severity,
    status: row.status,
    reason: row.reason,
    payload: payload(row.payload),
    opened_at: timestamp(row.opened_at),
    expires_at: row.expires_at === null ? null : timestamp(row.expires_at),
  };
}

function eventResponse(row: EventRow) {
  return {
    id: row.id,
    event_type: row.event_type,
    session_date: normalizeDateOnly(row.session_date),
    occurred_at: timestamp(row.occurred_at),
    payload: payload(row.payload),
  };
}

function defaultEventRange(query: z.infer<typeof EventsQuerySchema>): {
  from: string;
  to: string;
} {
  const to = query.to ?? shanghaiTrainingDay();
  const from =
    query.from ?? utcDateOnly(new Date(utcDate(to).getTime() - (DEFAULT_EVENT_DAYS - 1) * DAY_MS));
  return { from, to };
}

type AckResult =
  | { type: 'not-found' }
  | { type: 'not-open' }
  | { type: 'success'; signal: ReturnType<typeof signalResponse>; studentId: string };

export function coachSignalsRouter(deps: SignalsRouterDeps): ExpressRouter {
  const router = Router();

  router.get(
    '/signals',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const query = SignalsQuerySchema.safeParse(req.query);
      if (!query.success) {
        res.status(400).json(validationEnvelope(query.error));
        return;
      }

      const rows = await deps.db
        .selectFrom('student_signals as ss')
        // LEFT JOIN: a profile row is not a database-level requirement, and a
        // signal (especially a red one) must never be silently dropped for a
        // profile-less student (§6 promises every signal).
        .leftJoin('student_profiles as sp', 'sp.user_id', 'ss.student_id')
        .select([
          'ss.id as id',
          'ss.student_id as student_id',
          sql<string>`COALESCE(${sql.ref('sp.display_name')}, '')`.as('student_name'),
          'ss.signal_type as signal_type',
          'ss.severity as severity',
          'ss.status as status',
          'ss.reason as reason',
          'ss.payload as payload',
          'ss.opened_at as opened_at',
          'ss.expires_at as expires_at',
        ])
        .where('ss.coach_id', '=', req.user.id)
        .where('ss.status', '=', query.data.status)
        .orderBy(
          sql<number>`CASE ${sql.ref('ss.severity')}
            WHEN 'red' THEN 0
            WHEN 'yellow' THEN 1
            ELSE 2
          END`,
        )
        .orderBy('ss.opened_at', 'desc')
        .execute();

      res.status(200).json({ signals: rows.map(signalResponse) });
    }),
  );

  router.post(
    '/signals/:id/ack',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = SignalIdParamsSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const coachId = req.user.id;
      const result = await deps.db.transaction().execute(async (trx): Promise<AckResult> => {
        const located = await trx
          .selectFrom('student_signals')
          .select('student_id')
          .where('id', '=', params.data.id)
          .where('coach_id', '=', coachId)
          .executeTakeFirst();
        if (!located) return { type: 'not-found' };

        // LOCK CONTRACT: every student_signals writer locks the owning student
        // before writing. Re-read the signal after acquiring the lock so a
        // concurrent ack/settlement cannot make the status check stale.
        const lockedStudent = await trx
          .selectFrom('users')
          .select('id')
          .where('id', '=', located.student_id)
          .forUpdate()
          .executeTakeFirst();
        if (!lockedStudent) return { type: 'not-found' };

        const current = await trx
          .selectFrom('student_signals')
          .select('status')
          .where('id', '=', params.data.id)
          .where('coach_id', '=', coachId)
          .executeTakeFirst();
        if (!current) return { type: 'not-found' };
        if (current.status !== 'open') return { type: 'not-open' };

        const now = new Date();
        const updated = await trx
          .updateTable('student_signals')
          .set({ status: 'acked', acked_at: now, updated_at: now })
          .where('id', '=', params.data.id)
          .where('coach_id', '=', coachId)
          .where('status', '=', 'open')
          .returning([
            'id',
            'student_id',
            'signal_type',
            'severity',
            'status',
            'reason',
            'payload',
            'opened_at',
            'expires_at',
          ])
          .executeTakeFirst();
        if (!updated) return { type: 'not-open' };

        const profile = await trx
          .selectFrom('student_profiles')
          .select('display_name')
          .where('user_id', '=', updated.student_id)
          .executeTakeFirst();

        return {
          type: 'success',
          signal: signalResponse({ ...updated, student_name: profile?.display_name ?? '' }),
          studentId: updated.student_id,
        };
      });

      if (result.type === 'not-found') {
        res.status(404).json({ error: 'SIGNAL_NOT_FOUND' });
        return;
      }
      if (result.type === 'not-open') {
        res.status(409).json({ error: 'SIGNAL_NOT_OPEN' });
        return;
      }

      deps.logger.info(
        { coachId, signalId: params.data.id, studentId: result.studentId },
        'student_signal_acked',
      );
      res.status(200).json(result.signal);
    }),
  );

  router.get(
    '/students/:studentId/events',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = StudentIdParamsSchema.safeParse(req.params);
      const query = EventsQuerySchema.safeParse(req.query);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!query.success) {
        res.status(400).json(validationEnvelope(query.error));
        return;
      }

      const range = defaultEventRange(query.data);
      if (range.to < range.from) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          issues: [{ path: ['to'], message: 'to must be on or after from' }],
        });
        return;
      }

      if (!(await hasAcceptedBond(deps.db, req.user.id, params.data.studentId))) {
        res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
        return;
      }

      const rows = await deps.db
        .selectFrom('student_events')
        .select(['id', 'event_type', 'session_date', 'occurred_at', 'payload'])
        .where('student_id', '=', params.data.studentId)
        .where('session_date', '>=', range.from)
        .where('session_date', '<=', range.to)
        .orderBy('occurred_at', 'desc')
        .execute();

      res.status(200).json({ events: rows.map(eventResponse) });
    }),
  );

  return router;
}

export function studentSignalsRouter(deps: Pick<SignalsRouterDeps, 'db'>): ExpressRouter {
  const router = Router();

  router.get(
    '/me/session',
    requireRole('coached_student', 'self_train_student'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const query = SessionQuerySchema.safeParse(req.query);
      if (!query.success) {
        res.status(400).json(validationEnvelope(query.error));
        return;
      }

      const sessionDate = query.data.date ?? shanghaiTrainingDay();
      const row = await deps.db
        .selectFrom('training_sessions')
        .select(['status', 'started_at', 'last_set_at', 'completed_at'])
        .where('student_id', '=', req.user.id)
        .where('session_date', '=', sessionDate)
        .executeTakeFirst();

      if (!row) {
        res.status(200).json({ session: null });
        return;
      }

      const durationSeconds = Math.max(
        0,
        Math.floor((row.last_set_at.getTime() - row.started_at.getTime()) / 1000),
      );
      res.status(200).json({
        session: {
          status: row.status,
          started_at: timestamp(row.started_at),
          last_set_at: timestamp(row.last_set_at),
          completed_at: row.completed_at === null ? null : timestamp(row.completed_at),
          duration_seconds: durationSeconds,
        },
      });
    }),
  );

  return router;
}
