// Offline only: execute the delivered SQL one semicolon-delimited statement at a time.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const sql = fs.readFileSync('scripts/oneoff/2026-10-29-regroup-liuxing-plan-dms.sql', 'utf8');
assert.doesNotMatch(sql, /\$|DO |BEGIN|COMMIT|SET |LOCK /i);
const sections = Object.fromEntries(
  [...sql.matchAll(/^-- SECTION (S\d[b]?)\n([\s\S]*?)(?=^-- SECTION |$(?![\s\S]))/gm)].map((m) => [
    m[1],
    m[2].split(';').filter((s) => s.replace(/--[^\n]*/g, '').trim()),
  ]),
);
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const rows = async (query) => (await db.query(query)).rows;
async function run(section) {
  const results = [];
  for (const statement of sections[section]) results.push(await db.query(statement));
  return results;
}
const migrations = fs
  .readdirSync('db/migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
for (const file of migrations) await db.exec(fs.readFileSync(`db/migrations/${file}`, 'utf8'));
console.log(`migrations=${migrations.length}; ${(await rows('SELECT version()'))[0].version}`);
await db.exec(`
INSERT INTO public.users(id,phone,password_hash,role) VALUES
('10000000-0000-4000-8000-000000000001','fixture-coach','not-a-credential','coach'),
('10000000-0000-4000-8000-000000000003','fixture-student','not-a-credential','coached_student');
INSERT INTO public.exercises(id,name,exercise_type,main_lift_family,muscle_groups,equipment)
VALUES ('20000000-0000-4000-8000-000000000001','Fixture squat','main_lift','squat',ARRAY['quad'],ARRAY['barbell']);
INSERT INTO public.plans(id,coach_id,trainee_id,name,start_date,end_date,plan_weeks,source,status,published_at,anchor_weekday)
VALUES ('02db605c-d113-47ef-9303-1bcabf7b431d','10000000-0000-4000-8000-000000000001',
'10000000-0000-4000-8000-000000000003','Fixture 刘星','2026-10-26','2026-12-06',6,'coach','published',now(),1);
INSERT INTO public.plan_days(plan_id,week_number,day_of_week)
SELECT '02db605c-d113-47ef-9303-1bcabf7b431d',w,d
FROM generate_series(1,6) w CROSS JOIN unnest(ARRAY[2,3,6,7]) d
WHERE (w>1 OR d IN (6,7)) AND (w<6 OR d IN (2,3));
INSERT INTO public.plan_exercises(plan_day_id,exercise_id)
SELECT id,'20000000-0000-4000-8000-000000000001' FROM public.plan_days;
INSERT INTO public.plan_sets(plan_exercise_id,set_number,target_reps,intensity_mode,target_value,set_type)
SELECT id,n,5,'weight',100,'working' FROM public.plan_exercises CROSS JOIN generate_series(1,3) n;
SET search_path TO information_schema;
`);

for (const [section, count] of Object.entries({ S0: 1, S1: 4, S1b: 4, S2: 1, S3: 1, S4: 1 })) {
  assert.equal(sections[section].length, count, section);
}
const tree = () =>
  rows(`SELECT * FROM (
  SELECT 'plans' AS kind,to_jsonb(t) AS data FROM public.plans t
  UNION ALL SELECT 'days',to_jsonb(t) FROM public.plan_days t
  UNION ALL SELECT 'exercises',to_jsonb(t) FROM public.plan_exercises t
  UNION ALL SELECT 'sets',to_jsonb(t) FROM public.plan_sets t
) q ORDER BY kind,data::text`);
let rejected = 0;
async function aborts(section, pattern = /STOP/) {
  const before = await tree();
  await assert.rejects(run(section), pattern);
  assert.deepEqual(await tree(), before, `${section}: failed statement changed the tree`);
  rejected++;
}
const original = await tree();
assert.ok(Object.values((await run('S0'))[0].rows[0]).every((value) => value === 0));
assert.deepEqual(
  await rows(`SELECT (p.start_date+(d.week_number-1)*7+d.day_of_week-1)::text AS date
FROM public.plan_days d JOIN public.plans p ON p.id=d.plan_id WHERE d.week_number=6 ORDER BY date`),
  [{ date: '2026-12-01' }, { date: '2026-12-02' }],
);
assert.deepEqual(
  await rows(`SELECT i.indexrelid::regclass::text AS name,c.condeferrable
FROM pg_catalog.pg_index i LEFT JOIN pg_catalog.pg_constraint c ON c.conindid=i.indexrelid AND c.contype IN ('p','u')
WHERE i.indrelid='public.plan_days'::regclass AND i.indisunique`),
  [{ name: 'public.plan_days_pkey', condeferrable: false }],
);
await run('S1');
assert.deepEqual(
  (await run('S1b')).map((r) => r.rows[0]),
  [
    { table_name: 'plans', backup_rows: 1, current_rows: 1 },
    { table_name: 'days', backup_rows: 20, current_rows: 20 },
    { table_name: 'exercises', backup_rows: 20, current_rows: 20 },
    { table_name: 'sets', backup_rows: 60, current_rows: 60 },
  ],
);
assert.deepEqual((await run('S2'))[0].rows, [
  {
    guard_ok: 1,
    start_date: '2026-10-31',
    end_date: '2026-12-04',
    plan_weeks: 5,
    status: 'published',
    changed_days: 20,
    deleted_days: 0,
    date_mismatches: 0,
  },
]);
const verified = (await run('S3'))[0].rows[0];
assert.deepEqual(verified, {
  start_date: '2026-10-31',
  end_date: '2026-12-04',
  plan_weeks: 5,
  anchor_weekday: 6,
  status: 'published',
  days: 20,
  date_mismatches: 0,
  missing_exercises: 0,
  missing_sets: 0,
  week_dates:
    'W1=2026-10-31,2026-11-01,2026-11-03,2026-11-04 | W2=2026-11-07,2026-11-08,2026-11-10,2026-11-11 | W3=2026-11-14,2026-11-15,2026-11-17,2026-11-18 | W4=2026-11-21,2026-11-22,2026-11-24,2026-11-25 | W5=2026-11-28,2026-11-29,2026-12-01,2026-12-02',
});
assert.deepEqual(
  (await tree()).filter((r) => ['exercises', 'sets'].includes(r.kind)),
  original.filter((r) => ['exercises', 'sets'].includes(r.kind)),
);
console.log(`S0 all zero; S1 1/20/20/60; S2/S3 ${JSON.stringify(verified)}`);
await aborts('S2'); // Already applied, including exact same re-execution.
const restored = (await run('S4'))[0].rows[0];
assert.equal(restored.restored_days, 20);
assert.equal(restored.start_date, '2026-10-26');
assert.equal(restored.end_date, '2026-12-06');
assert.equal(restored.plan_weeks, 6);
assert.deepEqual(await tree(), original);
await aborts('S4'); // Already restored.
console.log('S4 exact original restored, including anchor_weekday/updated_at; tree differences=0');

// These mutations are synthetic and apply only to the in-process PGlite database.
const student = "'10000000-0000-4000-8000-000000000003'";
const coach = "'10000000-0000-4000-8000-000000000001'";
const exercise = "'20000000-0000-4000-8000-000000000001'";
const plan = "'02db605c-d113-47ef-9303-1bcabf7b431d'";
const cases = [
  [
    'set_logs',
    `INSERT INTO public.set_logs(student_id,plan_exercise_id,exercise_id,set_index,weight_kg,reps,logged_date,completed)
    SELECT ${student},id,exercise_id,0,100,5,'2027-01-01',false FROM public.plan_exercises LIMIT 1`,
  ],
  [
    'set_logs',
    `INSERT INTO public.set_logs(student_id,plan_day_id,exercise_id,set_index,weight_kg,reps,logged_date,adhoc)
    SELECT ${student},id,${exercise},0,100,5,'2027-01-01',true FROM public.plan_days LIMIT 1`,
  ],
  [
    'set_logs',
    `INSERT INTO public.set_logs(student_id,exercise_id,set_index,weight_kg,reps,logged_date,adhoc)
    VALUES (${student},${exercise},0,100,5,'2026-12-11',true)`,
  ],
  [
    'plan_day_completions',
    `INSERT INTO public.plan_day_completions(plan_day_id,student_id,source)
    SELECT id,${student},'manual' FROM public.plan_days LIMIT 1`,
  ],
  [
    'plan_day_shifts',
    `INSERT INTO public.plan_day_shifts(plan_day_id,student_id,shifted_to_date,batch_id)
    SELECT id,${student},'2026-11-02',gen_random_uuid() FROM public.plan_days LIMIT 1`,
  ],
  [
    'plan_shift_batches',
    `INSERT INTO public.plan_shift_batches(id,plan_id,actor_id,actor_role,anchor_date,offset_days)
    VALUES(gen_random_uuid(),${plan},${coach},'coach','2026-10-31',1)`,
  ],
  [
    'plan_pending_revisions',
    `INSERT INTO public.plan_pending_revisions(plan_id,coach_id,version,content_hash,content)
    VALUES(${plan},${coach},1,'fixture','{}')`,
  ],
  [
    'feedback',
    `INSERT INTO public.feedback(coach_id,student_id,plan_exercise_id,day_date,text)
    SELECT ${coach},${student},id,'2027-01-01','Fixture' FROM public.plan_exercises LIMIT 1`,
  ],
  [
    'feedback',
    `INSERT INTO public.feedback(coach_id,student_id,day_date,text)
    VALUES(${coach},${student},'2026-10-26','Fixture')`,
  ],
  [
    'training_sessions',
    `INSERT INTO public.training_sessions(student_id,session_date,status,started_at,last_set_at,plan_day_ids)
    SELECT ${student},'2027-01-01','in_progress',now(),now(),ARRAY[id] FROM public.plan_days LIMIT 1`,
  ],
  [
    'training_sessions',
    `INSERT INTO public.training_sessions(student_id,session_date,status,started_at,last_set_at)
    VALUES(${student},'2026-12-11','in_progress',now(),now())`,
  ],
  [
    'student_events',
    `INSERT INTO public.student_events(student_id,event_type,session_date,occurred_at,dedup_key)
    VALUES(${student},'session_partial','2026-10-26',now(),'fixture')`,
  ],
  [
    'session_reviews',
    `INSERT INTO public.session_reviews(student_id,review_date,feeling)
    VALUES(${student},'2026-12-11','Fixture')`,
  ],
  [
    'student_signals',
    `INSERT INTO public.student_signals(student_id,coach_id,signal_type,severity,status,reason,opened_at)
    VALUES(${student},${coach},'missed_training','yellow','expired','Fixture','2026-10-26')`,
  ],
];
for (const [table, insert] of cases) {
  await db.query(insert);
  assert.equal((await run('S0'))[0].rows[0][table], 1);
  await aborts('S2');
  await db.query(`DELETE FROM public.${table}`);
  await run('S2');
  await db.query(insert);
  await aborts('S4');
  await db.query(`DELETE FROM public.${table}`);
  await run('S4');
  assert.deepEqual(await tree(), original);
}
console.log(
  `risk paths=${cases.length}; S0 detects each; S2/S4 each reject; failed tree differences=0`,
);
await db.query(cases.at(-1)[1].replace('2026-10-26', '2026-10-01'));
assert.equal((await run('S0'))[0].rows[0].student_signals, 0);
await run('S2');
await run('S4');
assert.equal((await rows('SELECT count(*) AS n FROM public.student_signals'))[0].n, 1);
await db.query('DELETE FROM public.student_signals');

for (const mutation of [
  "UPDATE public.plans SET status='paused'",
  "UPDATE public.plans SET start_date='2026-10-27'",
  "UPDATE public.plans SET end_date='2026-12-05'",
  'UPDATE public.plans SET plan_weeks=5',
  "UPDATE public.plans SET name='Changed after backup'",
  "UPDATE public.plan_exercises SET notes='Changed after backup'",
  'UPDATE public.plan_sets SET target_reps=6',
]) {
  await db.query(mutation);
  await aborts('S2');
  await db.exec(`UPDATE public.plans p SET status=b.status,start_date=b.start_date,end_date=b.end_date,
    plan_weeks=b.plan_weeks,name=b.name FROM public.rglx_plans_20261029 b WHERE p.id=b.id;
    UPDATE public.plan_exercises e SET notes=b.notes FROM public.rglx_exercises_20261029 b WHERE e.id=b.id;
    UPDATE public.plan_sets s SET target_reps=b.target_reps FROM public.rglx_sets_20261029 b WHERE s.id=b.id;`);
}
// Missing target/empty update inputs must still evaluate the guard and report an error.
await db.query('DELETE FROM public.plans');
await aborts('S2');
await aborts('S4');
await db.exec(`INSERT INTO public.plans SELECT * FROM public.rglx_plans_20261029;
  INSERT INTO public.plan_days SELECT * FROM public.rglx_days_20261029;
  INSERT INTO public.plan_exercises SELECT * FROM public.rglx_exercises_20261029;
  INSERT INTO public.plan_sets SELECT * FROM public.rglx_sets_20261029;`);
// Empty backup inputs exercise the same optimizer hazard without touching foreign keys.
await db.query('ALTER TABLE public.rglx_days_20261029 RENAME TO fixture_saved_days');
await db.query(
  'CREATE TABLE public.rglx_days_20261029 AS SELECT * FROM public.plan_days WHERE false',
);
await aborts('S2');
await db.exec(
  'DROP TABLE public.rglx_days_20261029; ALTER TABLE public.fixture_saved_days RENAME TO rglx_days_20261029',
);
// Early content with the same row counts must be refused, even if backups also match it.
await db.exec(`UPDATE public.plan_days SET day_of_week=2 WHERE week_number=1 AND day_of_week=6;
  UPDATE public.rglx_days_20261029 SET day_of_week=2 WHERE week_number=1 AND day_of_week=6;`);
await aborts('S2');
await db.exec(`UPDATE public.plan_days SET day_of_week=6 WHERE week_number=1 AND day_of_week=2;
  UPDATE public.rglx_days_20261029 SET day_of_week=6 WHERE week_number=1 AND day_of_week=2;`);
await db.query(
  'CREATE UNIQUE INDEX fixture_slot_unique ON public.plan_days(plan_id,week_number,day_of_week,sort_order)',
);
await aborts('S2');
await db.query('DROP INDEX public.fixture_slot_unique');

// All sixteen possible partial-backup states left by a split/failed earlier run.
const tables = ['plans', 'days', 'exercises', 'sets'];
for (let mask = 0; mask < 16; mask++) {
  for (const name of tables) await db.query(`DROP TABLE IF EXISTS public.rglx_${name}_20261029`);
  for (let i = 0; i < 4; i++) if (mask & (1 << i)) await db.query(sections.S1[i]);
  const probe = (await run('S0'))[0].rows[0];
  for (let i = 0; i < 4; i++) assert.equal(probe[`backup_${tables[i]}`], (mask >> i) & 1);
  if (mask !== 15) {
    await aborts('S2', /does not exist/);
    await aborts('S4', /does not exist/);
  }
  for (let i = 0; i < 4; i++) {
    if (mask & (1 << i)) {
      const before = await rows(
        `SELECT to_jsonb(b) AS data FROM public.rglx_${tables[i]}_20261029 b ORDER BY b.id`,
      );
      await assert.rejects(db.query(sections.S1[i]), /already exists/);
      assert.deepEqual(
        await rows(
          `SELECT to_jsonb(b) AS data FROM public.rglx_${tables[i]}_20261029 b ORDER BY b.id`,
        ),
        before,
      );
    } else await db.query(sections.S1[i]);
  }
  await run('S1b');
  await run('S2');
  await run('S4');
  assert.deepEqual(await tree(), original);
}
console.log(
  `backup presence combinations=16; existing backups never overwritten; guard failures=${rejected}; failed tree differences=0`,
);
console.log('semicolon statements=12; forbidden strings=0; all DMS drills PASS');
await db.close();
