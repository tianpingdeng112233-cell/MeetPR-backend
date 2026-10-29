// Offline PostgreSQL drill. No DATABASE_URL, dotenv, socket or network connection.
// Pass the absolute path to a locally installed PGlite dist/index.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

process.on('uncaughtException', (error) => {
  console.error(error.message);
  process.exit(1);
});
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migrations = fs
  .readdirSync('db/migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
for (const file of migrations) await db.exec(fs.readFileSync(`db/migrations/${file}`, 'utf8'));
console.log(
  `migrations=${migrations.length}; ${(await db.query('SELECT version()')).rows[0].version}`,
);
const sql = fs.readFileSync(
  process.argv[3] ?? 'scripts/oneoff/2026-10-29-regroup-liuxing-plan.sql',
  'utf8',
);
const parts = Object.fromEntries(
  [...sql.matchAll(/^-- SECTION ([A-E])\n([\s\S]*?)(?=^-- SECTION [A-E]\n|$(?![\s\S]))/gm)].map(
    (m) => [m[1], m[2].replaceAll('FILL_PLAN_ID_FROM_A', '30000000-0000-4000-8000-000000000001')],
  ),
);
const run = (part) => db.exec(parts[part]);
const rows = async (query) => (await db.query(query)).rows;

await db.exec(`
INSERT INTO public.users(id,phone,password_hash,role) VALUES
('10000000-0000-4000-8000-000000000001','fixture-coach','not-a-credential','coach'),
('10000000-0000-4000-8000-000000000003','fixture-student','not-a-credential','coached_student');
INSERT INTO public.student_profiles(user_id,display_name)
VALUES ('10000000-0000-4000-8000-000000000003','刘星');
INSERT INTO public.exercises(id,name,exercise_type,main_lift_family,muscle_groups,equipment)
VALUES ('20000000-0000-4000-8000-000000000001','Fixture squat','main_lift','squat',ARRAY['quad'],ARRAY['barbell']);
`);
async function fixture(emptyDays) {
  await db.exec(`
  INSERT INTO public.plans(id,coach_id,trainee_id,name,start_date,end_date,plan_weeks,source,status,published_at,anchor_weekday)
  VALUES ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000003','Fixture 刘星','2026-10-26','2026-12-06',6,'coach','published',now(),1);
  INSERT INTO public.plan_days(plan_id,week_number,day_of_week)
  SELECT '30000000-0000-4000-8000-000000000001', w, d
  FROM generate_series(1,6) w CROSS JOIN unnest(ARRAY[2,3,6,7]) d
  WHERE w > 1 OR d IN (6,7);
  INSERT INTO public.plan_exercises(plan_day_id,exercise_id)
  SELECT id,'20000000-0000-4000-8000-000000000001' FROM public.plan_days;
  INSERT INTO public.plan_sets(plan_exercise_id,set_number,target_reps,intensity_mode,target_value,set_type)
  SELECT id,n,5,'weight',100,'working' FROM public.plan_exercises CROSS JOIN generate_series(1,3) n;
  ${
    emptyDays
      ? `INSERT INTO public.plan_days(plan_id,week_number,day_of_week) VALUES
  ('30000000-0000-4000-8000-000000000001',1,2),('30000000-0000-4000-8000-000000000001',1,3);`
      : ''
  }
  SET search_path TO information_schema;
  `);
}

await fixture(true);
await run('A');
await run('B');
await run('C');
await run('D');
assert.deepEqual(
  await rows(`SELECT start_date::text,end_date::text,plan_weeks,anchor_weekday FROM public.plans`),
  [{ start_date: '2026-10-31', end_date: '2026-12-11', plan_weeks: 6, anchor_weekday: 6 }],
);
assert.deepEqual(
  await rows(`SELECT (p.start_date+(d.week_number-1)*7+d.day_of_week-1)::text AS date
  FROM public.plan_days d JOIN public.plans p ON p.id=d.plan_id WHERE d.week_number=1 ORDER BY date`),
  ['2026-10-31', '2026-11-01', '2026-11-03', '2026-11-04'].map((date) => ({ date })),
);
assert.equal((await rows('SELECT count(*)::int AS n FROM public.plan_days'))[0].n, 22);
assert.equal((await rows('SELECT count(*)::int AS n FROM public.plan_exercises'))[0].n, 22);
assert.equal((await rows('SELECT count(*)::int AS n FROM public.plan_sets'))[0].n, 66);
console.log(
  'with-empty: days 24->22; exercises=22; sets=66; W1=10/31,11/01,11/03,11/04; weeks=6; end=12/11',
);
await run('E');
assert.equal((await rows('SELECT count(*)::int AS n FROM public.plan_days'))[0].n, 24);
assert.equal((await rows('SELECT start_date::text AS d FROM public.plans'))[0].d, '2026-10-26');
console.log('rollback: restored 24 days and start=10/26');

const tree = async () =>
  rows(`SELECT * FROM (SELECT 'plans' AS kind,to_jsonb(t) AS data FROM public.plans t
UNION ALL SELECT 'days',to_jsonb(t) FROM public.plan_days t
UNION ALL SELECT 'exercises',to_jsonb(t) FROM public.plan_exercises t
UNION ALL SELECT 'sets',to_jsonb(t) FROM public.plan_sets t) q ORDER BY kind,data::text`);
async function reset(emptyDays = true) {
  // This database is created in-process above; no user database can be selected.
  for (const table of [
    'messages',
    'video_markers',
    'feedback',
    'attachments',
    'set_logs',
    'plan_day_completions',
    'plan_day_shifts',
    'plan_shift_batches',
    'plan_pending_revisions',
    'training_sessions',
    'session_reviews',
    'student_events',
    'student_signals',
    'notification_outbox',
  ])
    await db.exec(`DELETE FROM public.${table}`);
  await db.exec('DELETE FROM public.plans');
  for (const { name } of await rows(`SELECT tablename AS name FROM pg_catalog.pg_tables
    WHERE schemaname='public' AND tablename LIKE 'rglx_%'`))
    await db.exec(`DROP TABLE public.${name}`);
  await fixture(emptyDays);
}
async function assertAborts(part, pattern) {
  const before = await tree();
  try {
    await run(part);
    assert.fail(`${part} unexpectedly succeeded`);
  } catch (error) {
    assert.match(error.message, pattern);
    console.log(`guard ${part}: ${error.message}`);
  }
  await db.exec('ROLLBACK');
  assert.deepEqual(await tree(), before, 'failed transaction changed the tree');
}
await reset(false);
const original = await tree();
await run('A');
await run('B');
await run('C');
const verification = await run('D');
assert.deepEqual(verification[2].rows, [{ date_mismatches: 0 }]);
assert.deepEqual(verification[3].rows, [{ missing_prescriptions: 0, missing_sets: 0 }]);
assert.deepEqual(
  await rows(
    `SELECT week_number,count(*)::int AS days FROM public.plan_days GROUP BY week_number ORDER BY week_number`,
  ),
  [4, 4, 4, 4, 4, 2].map((days, index) => ({ week_number: index + 1, days })),
);
await run('E');
assert.deepEqual(await tree(), original);
console.log(
  'without-empty: 22->22; weeks day counts=4,4,4,4,4,2; date mismatches=0; exercise/set differences=0; rollback exact',
);

const log = `INSERT INTO public.set_logs(student_id,plan_exercise_id,exercise_id,set_index,weight_kg,reps,logged_date,completed)
SELECT '10000000-0000-4000-8000-000000000003',id,exercise_id,0,100,5,'2026-10-31',false FROM public.plan_exercises LIMIT 1`;
const cases = {
  'training record, incomplete': log,
  'extra set': log.replace(',0,100', ',99,100'),
  'student added': `INSERT INTO public.set_logs(student_id,plan_day_id,exercise_id,set_index,weight_kg,reps,logged_date,adhoc)
    SELECT '10000000-0000-4000-8000-000000000003',id,'20000000-0000-4000-8000-000000000001',0,100,5,'2026-10-31',true FROM public.plan_days LIMIT 1`,
  completion: `INSERT INTO public.plan_day_completions(plan_day_id,student_id,source)
    SELECT id,'10000000-0000-4000-8000-000000000003','manual' FROM public.plan_days LIMIT 1`,
  'legacy shift without parent': `INSERT INTO public.plan_day_shifts(plan_day_id,student_id,shifted_to_date,batch_id)
    SELECT id,'10000000-0000-4000-8000-000000000003','2026-11-02',gen_random_uuid() FROM public.plan_days LIMIT 1`,
  'shift parent without days': `INSERT INTO public.plan_shift_batches(id,plan_id,actor_id,actor_role,anchor_date,offset_days)
    VALUES(gen_random_uuid(),'30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','coach','2026-10-31',1)`,
  'pending revision': `INSERT INTO public.plan_pending_revisions(plan_id,coach_id,version,content_hash,content)
    VALUES('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',1,'fixture','{}')`,
  'session with no logs': `INSERT INTO public.training_sessions(student_id,session_date,status,started_at,last_set_at,plan_day_ids)
    SELECT '10000000-0000-4000-8000-000000000003','2026-10-31','in_progress',now(),now(),ARRAY[id] FROM public.plan_days LIMIT 1`,
  'early content without sets': `INSERT INTO public.plan_exercises(plan_day_id,exercise_id)
    SELECT id,'20000000-0000-4000-8000-000000000001' FROM public.plan_days WHERE week_number=1 AND day_of_week=2`,
};
for (const [name, mutation] of Object.entries(cases)) {
  await reset();
  await db.exec(mutation);
  await run('B');
  process.stdout.write(`${name}: `);
  await assertAborts('C', /STOP: (training|content before)/);
}
await reset();
await run('B');
await db.exec(log);
await assertAborts('C', /related rows changed since backup: set_logs/);
await reset();
await run('B');
await run('C');
await db.exec(log);
await assertAborts('E', /related rows changed since backup: set_logs/);
await db.exec('DELETE FROM public.set_logs');
await run('E');
console.log('rollback after activity removed: exact original restored (synthetic fixture only)');
await reset();
await db.exec(`INSERT INTO public.plans SELECT gen_random_uuid(),coach_id,trainee_id,name,start_date,end_date,
plan_weeks,source,source_template_id,status,created_at,updated_at,kind,block_type,mesocycle_phase,training_max,tm_set_at,
published_at,anchor_weekday FROM public.plans`);
assert.equal((await run('A'))[0].rows[0].candidate_count, 2);
await assertAborts('B', /not the unique/);
await reset();
await run('B');
await assertAborts('B', /already exists/);
// A trigger deliberately damages dates to exercise the final SQL invariant and rollback.
await db.exec(`CREATE FUNCTION public.fixture_damage_date() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.day_of_week=NEW.day_of_week+1; RETURN NEW; END $$;
CREATE TRIGGER fixture_damage_date BEFORE UPDATE ON public.plan_days FOR EACH ROW EXECUTE FUNCTION public.fixture_damage_date()`);
await assertAborts('C', /per-ID date invariant failed/);
await db.exec(
  'DROP TRIGGER fixture_damage_date ON public.plan_days; DROP FUNCTION public.fixture_damage_date()',
);
await reset();
await db.exec(`DELETE FROM public.plan_days WHERE week_number=6`);
await run('B');
await run('C');
assert.deepEqual(await rows(`SELECT plan_weeks,end_date::text FROM public.plans`), [
  { plan_weeks: 5, end_date: '2026-12-04' },
]);
await run('E');
console.log(
  'shorter fixture: actual weeks=5; end=12/04; restored original weeks=6; all drills PASS',
);

await reset();
await db.exec(`
INSERT INTO public.attachments(id,owner_id,kind,oss_key,content_type,size_bytes,status,source_plan_id) VALUES
('60000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','set_video','fixture/video','video/mp4',10,'ready','30000000-0000-4000-8000-000000000001'),
('60000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','chat_image','fixture/annotation','image/png',10,'ready',NULL);
INSERT INTO public.video_markers(video_id,coach_id,time_ms,attachment_id) VALUES
('60000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',1,'60000000-0000-4000-8000-000000000002');
INSERT INTO public.conversations(id,coach_id,student_id) VALUES
('70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003');
INSERT INTO public.messages(conversation_id,seq,sender_id,kind,attachment_id,client_id) VALUES
('70000000-0000-4000-8000-000000000001',1,'10000000-0000-4000-8000-000000000001','image','60000000-0000-4000-8000-000000000002','fixture');
`);
await run('B');
assert.deepEqual(
  await rows(`SELECT table_name,count(*)::int AS n FROM public.rglx_related_20261029
WHERE table_name IN ('attachments','video_markers','messages') GROUP BY table_name ORDER BY table_name`),
  [
    { table_name: 'attachments', n: 2 },
    { table_name: 'messages', n: 1 },
    { table_name: 'video_markers', n: 1 },
  ],
);
await assertAborts('C', /STOP: training/);
console.log(
  'video backup: 1 video + 1 annotation image + 1 marker + 1 image message; C aborts; PASS',
);

await reset(false);
await db.exec(`INSERT INTO public.plans(id,coach_id,trainee_id,name,start_date,end_date,plan_weeks,source,status)
VALUES ('30000000-0000-4000-8000-000000000099','10000000-0000-4000-8000-000000000001',
'10000000-0000-4000-8000-000000000003','Untouched plan','2027-01-01','2027-01-28',4,'coach','draft')`);
const sentinel = await rows(
  `SELECT to_jsonb(p) AS data FROM public.plans p WHERE id='30000000-0000-4000-8000-000000000099'`,
);
await run('B');
await run('C');
assert.deepEqual(
  await rows(
    `SELECT to_jsonb(p) AS data FROM public.plans p WHERE id='30000000-0000-4000-8000-000000000099'`,
  ),
  sentinel,
);
assert.deepEqual(
  await rows(`SELECT (p.start_date+(d.week_number-1)*7+d.day_of_week-1)::text AS date
FROM public.plan_days d JOIN public.plans p ON p.id=d.plan_id WHERE d.week_number=6 ORDER BY date`),
  [{ date: '2026-12-05' }, { date: '2026-12-06' }],
);
await run('E');
assert.deepEqual(
  await rows(
    `SELECT to_jsonb(p) AS data FROM public.plans p WHERE id='30000000-0000-4000-8000-000000000099'`,
  ),
  sentinel,
);
console.log('scope: second plan unchanged through C/E; W6=12/05,12/06; PASS');
for (const [openedDate, shouldAbort] of [
  ['2026-10-27', true],
  ['2026-10-01', false],
]) {
  await reset();
  await db.query(
    `INSERT INTO public.student_signals(student_id,coach_id,signal_type,severity,status,reason,opened_at)
    VALUES ('10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001',
    'missed_training','yellow','expired','Fixture signal',$1::timestamptz)`,
    [`${openedDate}T12:00:00Z`],
  );
  const originalTree = await tree();
  const originalSignals = await rows('SELECT to_jsonb(s) AS data FROM public.student_signals s');
  await run('B');
  if (shouldAbort) {
    await assertAborts('C', /STOP: training/);
  } else {
    await run('C');
    const signalVerification = await run('D');
    assert.equal(
      (await rows('SELECT start_date::text AS date FROM public.plans'))[0].date,
      '2026-10-31',
    );
    assert.equal(signalVerification[0].rows[0].remaining_days, 22);
    assert.deepEqual(signalVerification[2].rows, [{ date_mismatches: 0 }]);
    await run('E');
  }
  assert.equal(
    (
      await rows(`SELECT count(*)::int AS n FROM public.rglx_related_20261029
      WHERE table_name='student_signals'`)
    )[0].n,
    shouldAbort ? 1 : 0,
  );
  assert.deepEqual(await tree(), originalTree);
  assert.deepEqual(
    await rows('SELECT to_jsonb(s) AS data FROM public.student_signals s'),
    originalSignals,
  );
  console.log(
    `signal ${openedDate}: backup=${shouldAbort ? 1 : 0}; ${shouldAbort ? 'C aborts; tree changes=0' : 'C succeeds 24->22; date mismatches=0; E restores 24'}; signal changes=0; PASS`,
  );
}
await db.close();
