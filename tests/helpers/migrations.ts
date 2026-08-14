import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { DataType, newDb } from 'pg-mem';

export function makeMigrationDb(options?: Parameters<typeof newDb>[0]) {
  const mem = newDb(options);
  mem.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    impure: true,
    implementation: randomUUID,
  });
  mem.public.registerFunction({
    name: 'length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (value: string) => value.length,
  });
  mem.public.registerFunction({
    name: 'trim',
    args: [DataType.text],
    returns: DataType.text,
    implementation: (value: string) => value.trim(),
  });
  mem.public.registerFunction({
    name: 'clock_timestamp',
    returns: DataType.timestamptz,
    impure: true,
    implementation: () => new Date(),
  });
  // pg-mem has no built-in array_length; needed by 0013 CHECK constraints.
  mem.public.registerFunction({
    name: 'array_length',
    args: [mem.public.getType(DataType.text).asArray(), DataType.integer],
    returns: DataType.integer,
    implementation: (value: string[] | null, _dimension: number) =>
      value === null ? null : value.length,
  });
  return mem;
}

export function runMigration(mem: ReturnType<typeof newDb>, path: string): void {
  mem.public.none(fs.readFileSync(path, 'utf8'));
}

export function createBaseUsers(mem: ReturnType<typeof newDb>): void {
  runMigration(mem, 'db/migrations/0001-init-users.sql');
  mem.public.none(`
    INSERT INTO users (id, phone, password_hash, role) VALUES
      ('10000000-0000-4000-8000-000000000001', '+8613800010001', 'hash', 'coach'),
      ('10000000-0000-4000-8000-000000000002', '+8613800010002', 'hash', 'coach'),
      ('10000000-0000-4000-8000-000000000003', '+8613800010003', 'hash', 'coached_student');
  `);
}

export function createPlanSchema(mem: ReturnType<typeof newDb>): void {
  mem.public.none(`
    CREATE TABLE exercises (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      name_en TEXT,
      exercise_type TEXT NOT NULL,
      main_lift_family TEXT,
      is_competition_lift BOOLEAN NOT NULL DEFAULT FALSE,
      muscle_groups TEXT[] NOT NULL,
      equipment TEXT[] NOT NULL,
      movement_pattern TEXT[] NOT NULL DEFAULT '{}',
      created_by_coach_id UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      coach_id UUID REFERENCES users(id) ON DELETE RESTRICT,
      trainee_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      plan_weeks SMALLINT NOT NULL,
      source TEXT NOT NULL,
      source_template_id UUID,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE plan_days (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      day_of_week SMALLINT NOT NULL,
      week_number SMALLINT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0
    );

    CREATE TABLE plan_exercises (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_day_id UUID NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
      exercise_id UUID NOT NULL REFERENCES exercises(id) ON DELETE RESTRICT,
      is_main_lift BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INT NOT NULL DEFAULT 0,
      notes TEXT
    );

    INSERT INTO exercises (
      id, name, exercise_type, main_lift_family, is_competition_lift,
      muscle_groups, equipment, movement_pattern
    ) VALUES (
      '20000000-0000-4000-8000-000000000001',
      'Competition Squat',
      'main_lift',
      'squat',
      TRUE,
      ARRAY['quad']::TEXT[],
      ARRAY['barbell']::TEXT[],
      ARRAY[]::TEXT[]
    );

    INSERT INTO plans (
      id, coach_id, trainee_id, name, start_date, end_date,
      plan_weeks, source, status
    ) VALUES (
      '30000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000003',
      'Published Block',
      '2026-05-01',
      '2026-05-28',
      4,
      'coach',
      'published'
    );

    INSERT INTO plan_days (
      id, plan_id, day_of_week, week_number, sort_order
    ) VALUES (
      '40000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      1,
      1,
      0
    );

    INSERT INTO plan_exercises (
      id, plan_day_id, exercise_id, is_main_lift, sort_order
    ) VALUES (
      '50000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      TRUE,
      0
    );
  `);
}
