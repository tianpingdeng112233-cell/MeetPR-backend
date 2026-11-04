import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/types';
import { effectivePlanDays } from '../domain/plan-calendar';
import { normalizeDateOnly, trainingDay } from '../utils/date';
import { DEFAULT_TIME_ZONE } from '../utils/timezone';
import { coachSetVideoProvenancePredicate } from './set-video-access';
import { timestamp } from './serialization';

export interface CoachStudentEvaluation {
  id: string;
  expected_end_at: string;
  overdue: boolean;
}

export interface CoachStudentSummary {
  alias: string | null;
  service_until: string | null;
  pending_video_count: number;
  bond_status: 'active' | 'ended';
  ended_at: string | null;
  today: { state: 'completed' | 'scheduled' | 'rest'; completed_at: string | null } | null;
  id: string;
  display_name: string;
  profile: {
    user_id: string;
    display_name: string;
    created_at: string;
  };
  // 'in_evaluation' while the pair has an uncompleted evaluation period;
  // iOS derives the remaining-time badge from evaluation.expected_end_at.
  status: 'active' | 'in_evaluation';
  evaluation: CoachStudentEvaluation | null;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  return groups;
}

export async function listCoachStudents(
  db: Kysely<Database>,
  coachId: string,
  includeEnded = false,
): Promise<CoachStudentSummary[]> {
  // student_profiles is LEFT-joined: nothing at the DB level guarantees an
  // accepted bond has a profile row (only the bind-request flow bootstraps
  // one), and an INNER JOIN would silently drop such students from the roster.
  const rows = await db
    .selectFrom('bind_requests as br')
    .innerJoin('users as u', 'u.id', 'br.student_id')
    .leftJoin('student_profiles as sp', 'sp.user_id', 'u.id')
    .leftJoin('coach_student_aliases as alias', (join) =>
      join.onRef('alias.student_id', '=', 'br.student_id').on('alias.coach_id', '=', coachId),
    )
    .leftJoin('evaluation_periods as ep', (join) =>
      join
        .onRef('ep.student_id', '=', 'br.student_id')
        .on('ep.coach_id', '=', coachId)
        .on('ep.completed_at', 'is', null),
    )
    .select([
      'u.id as id',
      'u.timezone as timezone',
      'alias.alias as alias',
      'br.status as bond_status',
      'br.ended_at as ended_at',
      'br.service_until as service_until',
      'br.submitted_at as submitted_at',
      'u.created_at as user_created_at',
      'sp.display_name as display_name',
      'sp.created_at as profile_created_at',
      'ep.id as evaluation_id',
      'ep.expected_end_at as evaluation_expected_end_at',
    ])
    .where('br.coach_id', '=', coachId)
    .where('br.status', 'in', includeEnded ? ['accepted', 'ended'] : ['accepted'])
    .orderBy('u.created_at', 'desc')
    .execute();

  // A pair may have several historical ended rows and a newer active bond.
  const byStudent = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const current = byStudent.get(row.id);
    if (
      !current ||
      (row.bond_status === 'accepted' && current.bond_status !== 'accepted') ||
      (row.bond_status === current.bond_status &&
        (row.ended_at ?? row.submitted_at) > (current.ended_at ?? current.submitted_at))
    ) {
      byStudent.set(row.id, row);
    }
  }
  if (byStudent.size === 0) return [];
  const studentIds = [...byStudent.keys()];
  const now = new Date();
  const completionWindowStart = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const [plans, days, shifts, completions, videos] = await Promise.all([
    db
      .selectFrom('plans')
      .select(['id', 'trainee_id', 'start_date'])
      .where('status', '=', 'published')
      .where('coach_id', '=', coachId)
      .where('trainee_id', 'in', studentIds)
      .execute(),
    db
      .selectFrom('plan_days as pd')
      .innerJoin('plans as p', 'p.id', 'pd.plan_id')
      .leftJoin('plan_day_completions as completed', (join) =>
        join
          .onRef('completed.plan_day_id', '=', 'pd.id')
          .onRef('completed.student_id', '=', 'p.trainee_id'),
      )
      .select([
        'pd.id',
        'pd.plan_id',
        'pd.week_number',
        'pd.day_of_week',
        'completed.id as completion_id',
      ])
      .where('p.status', '=', 'published')
      .where('p.coach_id', '=', coachId)
      .where('p.trainee_id', 'in', studentIds)
      .execute(),
    db
      .selectFrom('plan_day_shifts as shift')
      .innerJoin('plan_days as pd', 'pd.id', 'shift.plan_day_id')
      .innerJoin('plans as p', 'p.id', 'pd.plan_id')
      .selectAll('shift')
      .select('pd.plan_id')
      .where('p.status', '=', 'published')
      .where('p.coach_id', '=', coachId)
      .where('p.trainee_id', 'in', studentIds)
      .execute(),
    db
      .selectFrom('plan_day_completions as c')
      .innerJoin('plan_days as pd', 'pd.id', 'c.plan_day_id')
      .innerJoin('plans as p', 'p.id', 'pd.plan_id')
      .select(['c.student_id', 'c.plan_day_id', 'c.completed_at'])
      .where('p.coach_id', '=', coachId)
      .where('c.student_id', 'in', studentIds)
      .where('c.completed_at', '>=', completionWindowStart)
      .whereRef('p.trainee_id', '=', 'c.student_id')
      .execute(),
    db
      .selectFrom('attachments')
      .select('owner_id')
      .select((eb) => eb.fn.count<string | number>('id').as('count'))
      .where('owner_id', 'in', studentIds)
      .where('kind', '=', 'set_video')
      .where('status', '=', 'ready')
      .where('coach_viewed_at', 'is', null)
      .where(coachSetVideoProvenancePredicate(coachId))
      .groupBy('owner_id')
      .execute(),
  ]);
  const videoCounts = new Map(videos.map((video) => [video.owner_id, Number(video.count)]));
  const plansByStudent = groupBy(plans, (plan) => plan.trainee_id);
  const daysByPlan = groupBy(days, (day) => day.plan_id);
  const shiftsByPlan = groupBy(
    shifts.map((shift) => ({ ...shift, seq: Number(shift.seq) })),
    (shift) => shift.plan_id,
  );
  const completionsByStudent = groupBy(completions, (completion) => completion.student_id);
  return [...byStudent.values()].map((row): CoachStudentSummary => {
    const timezone = row.timezone || DEFAULT_TIME_ZONE;
    const today = trainingDay(now, timezone);
    const completed = (completionsByStudent.get(row.id) ?? []).reduce<Date | null>(
      (earliest, completion) => {
        if (trainingDay(completion.completed_at, timezone) !== today) return earliest;
        return earliest === null || completion.completed_at < earliest
          ? completion.completed_at
          : earliest;
      },
      null,
    );
    const scheduled = (plansByStudent.get(row.id) ?? []).some((plan) =>
      effectivePlanDays(plan, daysByPlan.get(plan.id) ?? [], shiftsByPlan.get(plan.id) ?? []).some(
        // This join marker also covers completions older than the today window.
        ({ day, effectiveDate }) => effectiveDate === today && day.completion_id === null,
      ),
    );

    // Read-time derived flag, same rule as toEvaluationPeriod (spec 005 D7):
    // past expected_end_at stays in progress, marked overdue.
    const evaluation: CoachStudentEvaluation | null =
      row.evaluation_id !== null && row.evaluation_expected_end_at !== null
        ? {
            id: row.evaluation_id,
            expected_end_at: timestamp(row.evaluation_expected_end_at),
            overdue: new Date(row.evaluation_expected_end_at) < new Date(),
          }
        : null;
    // Profile-less fallback mirrors the signals API ruling (spec 018 card 5):
    // empty display_name, keep the profile envelope non-null for live clients.
    const displayName = row.display_name ?? '';
    return {
      id: row.id,
      alias: row.alias,
      service_until:
        row.bond_status === 'accepted' && row.service_until !== null
          ? normalizeDateOnly(row.service_until)
          : null,
      pending_video_count: videoCounts.get(row.id) ?? 0,
      bond_status: row.bond_status === 'accepted' ? 'active' : 'ended',
      ended_at:
        row.bond_status === 'ended' && row.ended_at !== null ? timestamp(row.ended_at) : null,
      today:
        row.bond_status === 'ended'
          ? null
          : {
              state: completed ? 'completed' : scheduled ? 'scheduled' : 'rest',
              completed_at: completed ? timestamp(completed) : null,
            },
      display_name: displayName,
      profile: {
        user_id: row.id,
        display_name: displayName,
        created_at: timestamp(row.profile_created_at ?? row.user_created_at),
      },
      status: evaluation === null ? ('active' as const) : ('in_evaluation' as const),
      evaluation,
    };
  });
}

/** Update only the current accepted binding, including when unbind races this write. */
export async function setCoachStudentServiceTerm(
  db: Kysely<Database>,
  coachId: string,
  studentId: string,
  serviceUntil: string | null,
): Promise<{ service_until: string | null } | null> {
  const updated = await db
    .updateTable('bind_requests')
    .set({ service_until: serviceUntil })
    .where('coach_id', '=', coachId)
    .where('student_id', '=', studentId)
    .where('status', '=', 'accepted')
    .returning('service_until')
    .executeTakeFirst();
  if (!updated) return null;
  return {
    service_until: updated.service_until === null ? null : normalizeDateOnly(updated.service_until),
  };
}

/** Only active coaches can change their own private student alias. */
export async function renameCoachStudent(
  db: Kysely<Database>,
  coachId: string,
  studentId: string,
  alias: string | null,
): Promise<CoachStudentSummary | null> {
  return db.transaction().execute(async (trx) => {
    const bond = await trx
      .selectFrom('bind_requests')
      .select('id')
      .where('coach_id', '=', coachId)
      .where('student_id', '=', studentId)
      .where('status', '=', 'accepted')
      .forUpdate()
      .executeTakeFirst();
    if (!bond) return null;
    if (!alias) {
      await trx
        .deleteFrom('coach_student_aliases')
        .where('coach_id', '=', coachId)
        .where('student_id', '=', studentId)
        .execute();
    } else {
      await trx
        .insertInto('coach_student_aliases')
        .values({ coach_id: coachId, student_id: studentId, alias })
        .onConflict((oc) =>
          oc
            .columns(['coach_id', 'student_id'])
            .doUpdateSet({ alias, updated_at: sql<Date>`now()` }),
        )
        .execute();
    }
    const students = await listCoachStudents(trx, coachId);
    return students.find((student) => student.id === studentId) ?? null;
  });
}

/** Conditional transition is also the concurrent/repeated-unbind gate. */
export async function unbindCoachStudent(db: Kysely<Database>, coachId: string, studentId: string) {
  return db.transaction().execute(async (trx) => {
    const ended = await trx
      .updateTable('bind_requests')
      .set({ status: 'ended', ended_at: sql<Date>`now()` })
      .where('coach_id', '=', coachId)
      .where('student_id', '=', studentId)
      .where('status', '=', 'accepted')
      .returning(['id', 'student_id', 'ended_at'])
      .executeTakeFirst();
    if (!ended) return undefined;

    await trx
      .updateTable('evaluation_periods')
      .set({ completed_at: ended.ended_at, completion_type: 'cancelled' })
      .where('coach_id', '=', coachId)
      .where('student_id', '=', studentId)
      .where('completed_at', 'is', null)
      .execute();
    return ended;
  });
}
