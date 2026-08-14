import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database, PlanStatus, UserRole } from '../db/types';
import { getPlanWithChildren } from '../routes/plans';
import { normalizeDateOnly } from '../utils/date';

type TimestampValue = Date | string;

interface SafeUserRow {
  id: string;
  display_name: string | null;
  role: UserRole;
  phone: string | null;
  created_at: Date;
}

interface AcceptedBondRow {
  id: string;
  coach_id: string;
  coach_name: string | null;
  coach_role: UserRole;
  student_id: string;
  student_name: string | null;
  student_role: UserRole;
  submitted_at: Date;
  responded_at: Date | null;
}

export type AdminUserRelation =
  | { studentCount: number }
  | { coachId: string; coachName: string | null }
  | null;

export interface AdminUser {
  id: string;
  displayName: string | null;
  role: UserRole;
  phone: string | null;
  createdAt: string;
  relation: AdminUserRelation;
}

function timestamp(value: TimestampValue): string {
  return value instanceof Date ? value.toISOString() : value;
}

function nullableTimestamp(value: TimestampValue | null): string | null {
  return value === null ? null : timestamp(value);
}

function toCount(value: string | number | bigint): number {
  return Number(value);
}

function safeUsersQuery(db: Kysely<Database>) {
  return db
    .selectFrom('users as u')
    .leftJoin('coach_profiles as cp', 'cp.user_id', 'u.id')
    .leftJoin('student_profiles as sp', 'sp.user_id', 'u.id')
    .select([
      'u.id as id',
      'u.role as role',
      'u.phone as phone',
      'u.created_at as created_at',
      sql<string | null>`coalesce(cp.display_name, sp.display_name)`.as('display_name'),
    ]);
}

async function acceptedBonds(db: Kysely<Database>): Promise<AcceptedBondRow[]> {
  return db
    .selectFrom('bind_requests as br')
    .innerJoin('users as coach', 'coach.id', 'br.coach_id')
    .innerJoin('users as student', 'student.id', 'br.student_id')
    .leftJoin('coach_profiles as cp', 'cp.user_id', 'coach.id')
    .leftJoin('student_profiles as sp', 'sp.user_id', 'student.id')
    .select([
      'br.id as id',
      'br.coach_id as coach_id',
      'cp.display_name as coach_name',
      'coach.role as coach_role',
      'br.student_id as student_id',
      'sp.display_name as student_name',
      'student.role as student_role',
      'br.submitted_at as submitted_at',
      'br.responded_at as responded_at',
    ])
    .where('br.status', '=', 'accepted')
    .orderBy('br.responded_at', 'desc')
    .orderBy('br.submitted_at', 'desc')
    .orderBy('br.id', 'desc')
    .execute();
}

interface BondIndex {
  studentsByCoach: Map<string, Set<string>>;
  bondByStudent: Map<string, AcceptedBondRow>;
}

function indexBonds(bonds: AcceptedBondRow[]): BondIndex {
  const studentsByCoach = new Map<string, Set<string>>();
  const bondByStudent = new Map<string, AcceptedBondRow>();
  for (const bond of bonds) {
    let students = studentsByCoach.get(bond.coach_id);
    if (!students) {
      students = new Set();
      studentsByCoach.set(bond.coach_id, students);
    }
    students.add(bond.student_id);
    // Rows arrive newest-response first; keep the first per student to match
    // the previous find() semantics.
    if (!bondByStudent.has(bond.student_id)) bondByStudent.set(bond.student_id, bond);
  }
  return { studentsByCoach, bondByStudent };
}

function userRelation(row: SafeUserRow, bonds: BondIndex): AdminUserRelation {
  if (row.role === 'coach') {
    return { studentCount: bonds.studentsByCoach.get(row.id)?.size ?? 0 };
  }
  if (row.role === 'coached_student') {
    const bond = bonds.bondByStudent.get(row.id);
    return bond ? { coachId: bond.coach_id, coachName: bond.coach_name } : null;
  }
  return null;
}

function toAdminUser(row: SafeUserRow, bonds: BondIndex): AdminUser {
  return {
    id: row.id,
    displayName: row.display_name,
    role: row.role,
    phone: row.phone,
    createdAt: timestamp(row.created_at),
    relation: userRelation(row, bonds),
  };
}

function planSummaryQuery(db: Kysely<Database>) {
  return db
    .selectFrom('plans as p')
    .leftJoin('coach_profiles as cp', 'cp.user_id', 'p.coach_id')
    .leftJoin('student_profiles as sp', 'sp.user_id', 'p.trainee_id')
    .select([
      'p.id as id',
      'p.name as name',
      'p.coach_id as coach_id',
      'cp.display_name as coach_name',
      'p.trainee_id as trainee_id',
      'sp.display_name as student_name',
      'p.status as status',
      'p.plan_weeks as plan_weeks',
      'p.start_date as start_date',
      'p.end_date as end_date',
      'p.created_at as created_at',
      'p.updated_at as updated_at',
    ]);
}

function toAdminPlan(row: {
  id: string;
  name: string;
  coach_id: string | null;
  coach_name: string | null;
  trainee_id: string;
  student_name: string | null;
  status: PlanStatus;
  plan_weeks: number;
  start_date: string | Date;
  end_date: string | Date;
  created_at: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    coachId: row.coach_id,
    coachName: row.coach_name,
    traineeId: row.trainee_id,
    studentName: row.student_name,
    status: row.status,
    weeks: row.plan_weeks,
    startDate: normalizeDateOnly(row.start_date),
    endDate: normalizeDateOnly(row.end_date),
    createdAt: timestamp(row.created_at),
  };
}

export async function getAdminOverview(db: Kysely<Database>) {
  const [roleCounts, activeBondCount, publishedPlanCount, recentUsers, recentPlans] =
    await Promise.all([
      db
        .selectFrom('users')
        .select(['role', sql<string>`count(*)`.as('count')])
        .groupBy('role')
        .execute(),
      db
        .selectFrom('bind_requests')
        .select(sql<string>`count(*)`.as('count'))
        .where('status', '=', 'accepted')
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('plans')
        .select(sql<string>`count(*)`.as('count'))
        .where('status', '=', 'published')
        .executeTakeFirstOrThrow(),
      safeUsersQuery(db)
        .orderBy('u.created_at', 'desc')
        .orderBy('u.id', 'desc')
        .limit(10)
        .execute(),
      planSummaryQuery(db)
        .where('p.status', 'in', ['published', 'paused', 'completed'])
        .orderBy('p.updated_at', 'desc')
        .orderBy('p.id', 'desc')
        .limit(10)
        .execute(),
    ]);

  const countByRole = new Map(roleCounts.map((row) => [row.role, toCount(row.count)]));
  return {
    stats: {
      coaches: countByRole.get('coach') ?? 0,
      coachedStudents: countByRole.get('coached_student') ?? 0,
      selfTrainStudents: countByRole.get('self_train_student') ?? 0,
      activeBonds: toCount(activeBondCount.count),
      publishedPlans: toCount(publishedPlanCount.count),
    },
    recentUsers: recentUsers.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      role: row.role,
      createdAt: timestamp(row.created_at),
    })),
    recentPlans: recentPlans.map((row) => ({
      id: row.id,
      name: row.name,
      coachId: row.coach_id,
      coachName: row.coach_name,
      traineeId: row.trainee_id,
      studentName: row.student_name,
      publishedAt: timestamp(row.updated_at),
    })),
  };
}

export async function listAdminUsers(db: Kysely<Database>): Promise<{ users: AdminUser[] }> {
  const [rows, bonds] = await Promise.all([
    safeUsersQuery(db).orderBy('u.created_at', 'desc').orderBy('u.id', 'desc').execute(),
    acceptedBonds(db),
  ]);
  const index = indexBonds(bonds);
  return { users: rows.map((row) => toAdminUser(row, index)) };
}

export async function getAdminUser(db: Kysely<Database>, userId: string) {
  const [row, bonds] = await Promise.all([
    safeUsersQuery(db).where('u.id', '=', userId).executeTakeFirst(),
    acceptedBonds(db),
  ]);
  if (!row) return null;

  const relations =
    row.role === 'coach'
      ? bonds
          .filter((bond) => bond.coach_id === row.id)
          .map((bond) => ({
            userId: bond.student_id,
            displayName: bond.student_name,
            role: bond.student_role,
            bondAcceptedAt: timestamp(bond.responded_at ?? bond.submitted_at),
          }))
      : row.role === 'coached_student'
        ? bonds
            .filter((bond) => bond.student_id === row.id)
            .slice(0, 1)
            .map((bond) => ({
              userId: bond.coach_id,
              displayName: bond.coach_name,
              role: bond.coach_role,
              bondAcceptedAt: timestamp(bond.responded_at ?? bond.submitted_at),
            }))
        : [];

  const plans =
    row.role === 'coach'
      ? await planSummaryQuery(db)
          .where('p.coach_id', '=', row.id)
          .orderBy('p.created_at', 'desc')
          .orderBy('p.id', 'desc')
          .execute()
      : row.role === 'coached_student' || row.role === 'self_train_student'
        ? await planSummaryQuery(db)
            .where('p.trainee_id', '=', row.id)
            .orderBy('p.created_at', 'desc')
            .orderBy('p.id', 'desc')
            .execute()
        : [];

  return {
    user: toAdminUser(row, indexBonds(bonds)),
    relations,
    plans: plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      status: plan.status,
      weeks: plan.plan_weeks,
      createdAt: timestamp(plan.created_at),
      coachName: plan.coach_name,
      studentName: plan.student_name,
    })),
  };
}

export async function listAdminBindings(db: Kysely<Database>) {
  const rows = await db
    .selectFrom('bind_requests as br')
    .leftJoin('coach_profiles as cp', 'cp.user_id', 'br.coach_id')
    .leftJoin('student_profiles as sp', 'sp.user_id', 'br.student_id')
    .select([
      'br.id as id',
      'br.coach_id as coach_id',
      'cp.display_name as coach_name',
      'br.student_id as student_id',
      'sp.display_name as student_name',
      'br.status as status',
      'br.submitted_at as submitted_at',
      'br.responded_at as responded_at',
    ])
    .orderBy('br.submitted_at', 'desc')
    .orderBy('br.id', 'desc')
    .execute();

  return {
    bindings: rows.map((row) => ({
      id: row.id,
      coachId: row.coach_id,
      coachName: row.coach_name,
      studentId: row.student_id,
      studentName: row.student_name,
      status: row.status,
      submittedAt: timestamp(row.submitted_at),
      respondedAt: nullableTimestamp(row.responded_at),
    })),
  };
}

export async function listAdminPlans(db: Kysely<Database>) {
  const rows = await planSummaryQuery(db)
    .orderBy('p.created_at', 'desc')
    .orderBy('p.id', 'desc')
    .execute();
  return { plans: rows.map(toAdminPlan) };
}

export async function listAdminExerciseUsage(db: Kysely<Database>) {
  const rows = await db
    .selectFrom('exercises as e')
    .leftJoin('plan_exercises as pe', 'pe.exercise_id', 'e.id')
    .leftJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
    .leftJoin('plans as p', 'p.id', 'pd.plan_id')
    .select([
      'e.id as exercise_id',
      'e.name as name',
      'e.exercise_type as exercise_type',
      sql<string>`count(pe.id)`.as('plan_count'),
      sql<string>`count(distinct p.coach_id)`.as('coach_count'),
    ])
    .groupBy(['e.id', 'e.name', 'e.exercise_type'])
    .orderBy('plan_count', 'desc')
    .orderBy('e.name', 'asc')
    .execute();

  return {
    exercises: rows.map((row) => ({
      exercise_id: row.exercise_id,
      name: row.name,
      exercise_type: row.exercise_type,
      plan_count: toCount(row.plan_count),
      coach_count: toCount(row.coach_count),
    })),
  };
}

export async function getAdminPlan(db: Kysely<Database>, planId: string) {
  const plan = await db.selectFrom('plans').selectAll().where('id', '=', planId).executeTakeFirst();
  if (!plan) return null;
  const detail = await getPlanWithChildren(db, plan);

  // The admin cannot resolve coach-private catalog entries via /exercises, so
  // the read-only detail carries display-ready exercise names.
  const exerciseIds = [
    ...new Set(detail.days.flatMap((day) => day.exercises.map((item) => item.exercise_id))),
  ];
  const names = exerciseIds.length
    ? await db
        .selectFrom('exercises')
        .select(['id', 'name'])
        .where('id', 'in', exerciseIds)
        .execute()
    : [];
  const nameById = new Map(names.map((row) => [row.id, row.name]));
  return {
    ...detail,
    days: detail.days.map((day) => ({
      ...day,
      exercises: day.exercises.map((item) => ({
        ...item,
        exercise_name: nameById.get(item.exercise_id) ?? item.exercise_id,
      })),
    })),
  };
}
