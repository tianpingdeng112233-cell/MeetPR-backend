-- One-off: 刘星, 2026-10-26 -> 2026-10-31. NOT a migration. Never run this whole file.
-- David: paste A, inspect uniqueness; replace ALL FOUR FILL_PLAN_ID_FROM_A literals
-- in B/C/E with the SAME UUID. Paste each complete section separately, including BEGIN/COMMIT.
-- E is OPTIONAL ROLLBACK, not the next step after D! Backups deliberately are not idempotent.
-- No psql variables or session state across sections. All permanent tables use public.
-- Before B: coach/student close this plan on all devices; no edits/training until D completes.
-- Locks briefly block writes on the listed tables; NOWAIT fails instead of queuing behind users.
-- Any SQL error: STOP, issue ROLLBACK; do not continue or drop/overwrite backups.
-- See docs/journal/2026-10-29-regroup-liuxing-plan.md for scope and local evidence.

-- SECTION A
-- Read only. Exactly ONE candidate required. No automatic LIMIT 1 selection.
SELECT count(*) AS candidate_count, CASE WHEN count(*)=1 THEN 'ONE: inspect rows below' ELSE 'STOP: not unique' END AS decision
FROM public.plans p JOIN public.student_profiles sp ON sp.user_id=p.trainee_id
WHERE sp.display_name='刘星' AND p.start_date=DATE '2026-10-26';
SELECT p.id AS plan_id,p.name,p.coach_id,p.trainee_id,p.status,p.kind,p.start_date,p.end_date,p.plan_weeks,p.anchor_weekday,
  d.id AS plan_day_id,d.week_number,d.day_of_week,d.sort_order,
  p.start_date+(d.week_number-1)*7+d.day_of_week-1 AS actual_date,
  (SELECT count(*) FROM public.plan_exercises e WHERE e.plan_day_id=d.id) AS exercise_rows,
  (SELECT count(*) FROM public.plan_day_shifts s WHERE s.plan_day_id=d.id) AS shift_rows
FROM public.plans p JOIN public.student_profiles sp ON sp.user_id=p.trainee_id
LEFT JOIN public.plan_days d ON d.plan_id=p.id
WHERE sp.display_name='刘星' AND p.start_date=DATE '2026-10-26'
ORDER BY p.id,d.week_number,d.day_of_week,d.sort_order,d.id;
-- actual_date is the base date; ANY shift_rows makes C refuse (do not infer dates across shifts).

-- SECTION B
-- Backup only. 9 public tables, dated and collision-failing. Inspect B counts before C.
BEGIN;
SET LOCAL search_path TO public, pg_catalog;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.student_profiles,
  public.plans,
  public.plan_days,
  public.plan_exercises,
  public.plan_sets,
  public.plan_pending_revisions,
  public.plan_day_completions,
  public.plan_day_shifts,
  public.plan_shift_batches,
  public.set_logs,
  public.feedback,
  public.attachments,
  public.video_markers,
  public.messages,
  public.session_reviews,
  public.training_sessions,
  public.student_events,
  public.student_signals,
  public.notification_outbox
IN SHARE ROW EXCLUSIVE MODE NOWAIT;
DO $backup$
DECLARE v_id uuid := 'FILL_PLAN_ID_FROM_A'::uuid;
BEGIN
  IF v_id IS NULL OR (SELECT count(*) FROM public.plans p JOIN public.student_profiles sp
    ON sp.user_id=p.trainee_id WHERE sp.display_name='刘星' AND p.start_date=DATE '2026-10-26') <> 1
    OR NOT EXISTS (SELECT 1 FROM public.plans p JOIN public.student_profiles sp ON sp.user_id=p.trainee_id
      WHERE p.id=v_id AND sp.display_name='刘星' AND p.start_date=DATE '2026-10-26'
      AND p.plan_weeks=6 AND p.end_date=DATE '2026-12-06' AND p.status='published'
      AND p.kind='regular' AND p.coach_id IS NOT NULL) THEN
    RAISE EXCEPTION 'STOP: target is not the unique published six-week 刘星 plan';
  END IF;
  -- New incoming FK paths must be reviewed before this one-off is used on a newer schema.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.contype='f' AND c.confrelid IN ('public.plans'::regclass,'public.plan_days'::regclass,
      'public.plan_exercises'::regclass,'public.plan_sets'::regclass)
    AND c.conrelid NOT IN ('public.plan_days'::regclass,'public.plan_exercises'::regclass,
      'public.plan_sets'::regclass,'public.set_logs'::regclass,'public.feedback'::regclass,
      'public.attachments'::regclass,'public.plan_pending_revisions'::regclass,
      'public.plan_day_completions'::regclass,'public.plan_day_shifts'::regclass,'public.plan_shift_batches'::regclass)) THEN
    RAISE EXCEPTION 'STOP: unknown incoming plan-tree foreign key; review schema first';
  END IF;
END $backup$;
CREATE TABLE public.rglx_plans_20261029 AS SELECT * FROM public.plans WHERE id='FILL_PLAN_ID_FROM_A'::uuid;
CREATE TABLE public.rglx_days_20261029 AS SELECT * FROM public.plan_days WHERE plan_id IN (SELECT id FROM public.rglx_plans_20261029);
CREATE TABLE public.rglx_exercises_20261029 AS SELECT * FROM public.plan_exercises WHERE plan_day_id IN (SELECT id FROM public.rglx_days_20261029);
CREATE TABLE public.rglx_sets_20261029 AS SELECT * FROM public.plan_sets WHERE plan_exercise_id IN (SELECT id FROM public.rglx_exercises_20261029);
CREATE TABLE public.rglx_related_20261029 (table_name text NOT NULL, row_data jsonb NOT NULL);
CREATE TABLE public.rglx_after_plans_20261029 (LIKE public.rglx_plans_20261029);
CREATE TABLE public.rglx_after_days_20261029 (LIKE public.rglx_days_20261029);
CREATE TABLE public.rglx_run_20261029 (plan_id uuid PRIMARY KEY, backed_up_at timestamptz NOT NULL,
  applied_at timestamptz, rolled_back_at timestamptz);
INSERT INTO public.rglx_run_20261029 SELECT id,clock_timestamp(),NULL,NULL FROM public.rglx_plans_20261029;
CREATE TABLE public.rglx_scope_20261029 (ordinal integer PRIMARY KEY, table_name text UNIQUE NOT NULL, predicate text NOT NULL);
INSERT INTO public.rglx_scope_20261029 VALUES
(1, 'plan_pending_revisions', $scope$t.plan_id IN (SELECT id FROM public.rglx_plans_20261029)$scope$),
(2, 'plan_day_completions', $scope$t.plan_day_id IN (SELECT id FROM public.rglx_days_20261029)$scope$),
(3, 'plan_day_shifts', $scope$t.plan_day_id IN (SELECT id FROM public.rglx_days_20261029)$scope$),
(4, 'plan_shift_batches', $scope$t.plan_id IN (SELECT id FROM public.rglx_plans_20261029)$scope$),
(5, 'set_logs', $scope$t.plan_exercise_id IN (SELECT id FROM public.rglx_exercises_20261029) OR t.plan_day_id IN (SELECT id FROM public.rglx_days_20261029)
 OR EXISTS (SELECT 1 FROM public.rglx_plans_20261029 p WHERE t.student_id=p.trainee_id AND t.logged_date BETWEEN p.start_date AND p.end_date+5)$scope$),
(6, 'feedback', $scope$t.plan_exercise_id IN (SELECT id FROM public.rglx_exercises_20261029)
 OR EXISTS (SELECT 1 FROM public.rglx_plans_20261029 p WHERE t.student_id=p.trainee_id AND t.day_date BETWEEN p.start_date AND p.end_date+5) OR t.video_id IN (SELECT a.id FROM public.attachments a WHERE a.source_plan_id IN (SELECT id FROM public.rglx_plans_20261029) OR a.set_log_id IN (SELECT (row_data->>'id')::uuid FROM public.rglx_related_20261029 WHERE table_name='set_logs'))$scope$),
(7, 'attachments', $scope$t.source_plan_id IN (SELECT id FROM public.rglx_plans_20261029)
 OR t.set_log_id IN (SELECT (row_data->>'id')::uuid FROM public.rglx_related_20261029 WHERE table_name='set_logs')
 OR t.id IN (SELECT (row_data->>'video_id')::uuid FROM public.rglx_related_20261029 WHERE table_name='feedback') OR t.id IN (SELECT vm.attachment_id FROM public.video_markers vm JOIN public.attachments a ON a.id=vm.video_id WHERE a.source_plan_id IN (SELECT id FROM public.rglx_plans_20261029) OR a.set_log_id IN (SELECT (row_data->>'id')::uuid FROM public.rglx_related_20261029 WHERE table_name='set_logs') OR a.id IN (SELECT (row_data->>'video_id')::uuid FROM public.rglx_related_20261029 WHERE table_name='feedback'))$scope$),
(8, 'video_markers', $scope$t.video_id IN (SELECT (row_data->>'id')::uuid FROM public.rglx_related_20261029 WHERE table_name='attachments')$scope$),
(9, 'messages', $scope$t.set_ref->>'plan_set_id' IN (SELECT id::text FROM public.rglx_sets_20261029)
 OR t.set_ref->>'set_log_id' IN (SELECT row_data->>'id' FROM public.rglx_related_20261029 WHERE table_name='set_logs')
 OR t.video_id IN (SELECT (row_data->>'id')::uuid FROM public.rglx_related_20261029 WHERE table_name='attachments') OR t.attachment_id IN (SELECT (row_data->>'id')::uuid FROM public.rglx_related_20261029 WHERE table_name='attachments')$scope$),
(10, 'session_reviews', $scope$EXISTS (SELECT 1 FROM public.rglx_plans_20261029 p WHERE t.student_id=p.trainee_id AND t.review_date BETWEEN p.start_date AND p.end_date+5)$scope$),
(11, 'training_sessions', $scope$t.plan_day_ids && ARRAY(SELECT id FROM public.rglx_days_20261029)
 OR EXISTS (SELECT 1 FROM public.rglx_plans_20261029 p WHERE t.student_id=p.trainee_id AND t.session_date BETWEEN p.start_date AND p.end_date+5)$scope$),
(12, 'student_events', $scope$EXISTS (SELECT 1 FROM public.rglx_plans_20261029 p WHERE t.student_id=p.trainee_id AND t.session_date BETWEEN p.start_date AND p.end_date+5)$scope$),
(13, 'student_signals', $scope$t.student_id IN (SELECT trainee_id FROM public.rglx_plans_20261029) AND t.opened_at >= DATE '2026-10-26'$scope$),
(14, 'notification_outbox', $scope$t.aggregate_id IN (SELECT id FROM public.rglx_plans_20261029) OR t.payload->>'plan_id' IN (SELECT id::text FROM public.rglx_plans_20261029)$scope$);
DO $copy$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM public.rglx_scope_20261029 ORDER BY ordinal LOOP
    EXECUTE format('INSERT INTO public.rglx_related_20261029 SELECT %L,to_jsonb(t) FROM public.%I t WHERE %s',
      r.table_name,r.table_name,r.predicate);
  END LOOP;
END $copy$;
COMMIT;
SELECT 'plans' AS table_name,count(*) AS backed_up_rows FROM public.rglx_plans_20261029
UNION ALL SELECT 'plan_days',count(*) FROM public.rglx_days_20261029
UNION ALL SELECT 'plan_exercises',count(*) FROM public.rglx_exercises_20261029
UNION ALL SELECT 'plan_sets',count(*) FROM public.rglx_sets_20261029
UNION ALL SELECT s.table_name,count(r.row_data) FROM public.rglx_scope_20261029 s
LEFT JOIN public.rglx_related_20261029 r USING(table_name) GROUP BY s.table_name;

-- SECTION C
-- Single atomic correction. No child IDs are replaced and no prescription rows are edited.
BEGIN;
SET LOCAL search_path TO public, pg_catalog;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.student_profiles,
  public.plans,
  public.plan_days,
  public.plan_exercises,
  public.plan_sets,
  public.plan_pending_revisions,
  public.plan_day_completions,
  public.plan_day_shifts,
  public.plan_shift_batches,
  public.set_logs,
  public.feedback,
  public.attachments,
  public.video_markers,
  public.messages,
  public.session_reviews,
  public.training_sessions,
  public.student_events,
  public.student_signals,
  public.notification_outbox
IN SHARE ROW EXCLUSIVE MODE NOWAIT;
DO $regroup$
DECLARE v_id uuid := 'FILL_PLAN_ID_FROM_A'::uuid;
  r record; mismatch boolean; new_weeks integer; removed integer;
BEGIN
  IF v_id IS NULL OR (SELECT count(*) FROM public.plans p JOIN public.student_profiles sp
    ON sp.user_id=p.trainee_id WHERE sp.display_name='刘星' AND p.start_date=DATE '2026-10-26') <> 1
    OR NOT EXISTS (SELECT 1 FROM public.plans p JOIN public.student_profiles sp ON sp.user_id=p.trainee_id
      WHERE p.id=v_id AND sp.display_name='刘星' AND p.start_date=DATE '2026-10-26'
      AND p.plan_weeks=6 AND p.end_date=DATE '2026-12-06' AND p.status='published'
      AND p.kind='regular' AND p.coach_id IS NOT NULL) THEN
    RAISE EXCEPTION 'STOP: target is not the unique published six-week 刘星 plan';
  END IF;
  -- New incoming FK paths must be reviewed before this one-off is used on a newer schema.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.contype='f' AND c.confrelid IN ('public.plans'::regclass,'public.plan_days'::regclass,
      'public.plan_exercises'::regclass,'public.plan_sets'::regclass)
    AND c.conrelid NOT IN ('public.plan_days'::regclass,'public.plan_exercises'::regclass,
      'public.plan_sets'::regclass,'public.set_logs'::regclass,'public.feedback'::regclass,
      'public.attachments'::regclass,'public.plan_pending_revisions'::regclass,
      'public.plan_day_completions'::regclass,'public.plan_day_shifts'::regclass,'public.plan_shift_batches'::regclass)) THEN
    RAISE EXCEPTION 'STOP: unknown incoming plan-tree foreign key; review schema first';
  END IF;
  IF (SELECT count(*) FROM public.rglx_plans_20261029) <> 1
    OR NOT EXISTS (SELECT 1 FROM public.rglx_run_20261029 WHERE plan_id=v_id AND applied_at IS NULL AND rolled_back_at IS NULL)
    OR NOT EXISTS (SELECT 1 FROM public.rglx_plans_20261029 WHERE id=v_id)
    OR EXISTS (SELECT 1 FROM public.rglx_after_plans_20261029)
    OR EXISTS (SELECT 1 FROM public.rglx_after_days_20261029) THEN
    RAISE EXCEPTION 'STOP: wrong/missing/already-used backup';
  END IF;
  IF EXISTS ((SELECT to_jsonb(t) FROM public.plans t WHERE t.id IN (SELECT id FROM public.rglx_plans_20261029) EXCEPT SELECT to_jsonb(x) FROM public.rglx_plans_20261029 x)
    UNION ALL (SELECT to_jsonb(x) FROM public.rglx_plans_20261029 x EXCEPT SELECT to_jsonb(t) FROM public.plans t WHERE t.id IN (SELECT id FROM public.rglx_plans_20261029))) THEN
    RAISE EXCEPTION 'STOP: plans differs from backup image';
  END IF;
  IF EXISTS ((SELECT to_jsonb(t) FROM public.plan_days t WHERE t.plan_id IN (SELECT id FROM public.rglx_plans_20261029) EXCEPT SELECT to_jsonb(x) FROM public.rglx_days_20261029 x)
    UNION ALL (SELECT to_jsonb(x) FROM public.rglx_days_20261029 x EXCEPT SELECT to_jsonb(t) FROM public.plan_days t WHERE t.plan_id IN (SELECT id FROM public.rglx_plans_20261029))) THEN
    RAISE EXCEPTION 'STOP: plan_days differs from backup image';
  END IF;
  IF EXISTS ((SELECT to_jsonb(t) FROM public.plan_exercises t WHERE t.plan_day_id IN (SELECT id FROM public.rglx_days_20261029) EXCEPT SELECT to_jsonb(x) FROM public.rglx_exercises_20261029 x)
    UNION ALL (SELECT to_jsonb(x) FROM public.rglx_exercises_20261029 x EXCEPT SELECT to_jsonb(t) FROM public.plan_exercises t WHERE t.plan_day_id IN (SELECT id FROM public.rglx_days_20261029))) THEN
    RAISE EXCEPTION 'STOP: plan_exercises differs from backup image';
  END IF;
  IF EXISTS ((SELECT to_jsonb(t) FROM public.plan_sets t WHERE t.plan_exercise_id IN (SELECT id FROM public.rglx_exercises_20261029) EXCEPT SELECT to_jsonb(x) FROM public.rglx_sets_20261029 x)
    UNION ALL (SELECT to_jsonb(x) FROM public.rglx_sets_20261029 x EXCEPT SELECT to_jsonb(t) FROM public.plan_sets t WHERE t.plan_exercise_id IN (SELECT id FROM public.rglx_exercises_20261029))) THEN
    RAISE EXCEPTION 'STOP: plan_sets differs from backup image';
  END IF;
  FOR r IN SELECT * FROM public.rglx_scope_20261029 ORDER BY ordinal LOOP
    EXECUTE format('SELECT EXISTS ((SELECT to_jsonb(t) FROM public.%I t WHERE (%s) OR to_jsonb(t)->>''id'' IN (SELECT row_data->>''id'' FROM public.rglx_related_20261029 WHERE table_name=%L) EXCEPT SELECT row_data FROM public.rglx_related_20261029 WHERE table_name=%L) UNION ALL (SELECT row_data FROM public.rglx_related_20261029 WHERE table_name=%L EXCEPT SELECT to_jsonb(t) FROM public.%I t WHERE (%s) OR to_jsonb(t)->>''id'' IN (SELECT row_data->>''id'' FROM public.rglx_related_20261029 WHERE table_name=%L)))',
      r.table_name,r.predicate,r.table_name,r.table_name,r.table_name,r.table_name,r.predicate,r.table_name) INTO mismatch;
    IF mismatch THEN RAISE EXCEPTION 'STOP: related rows changed since backup: %',r.table_name; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.rglx_related_20261029 WHERE table_name NOT IN ('notification_outbox')) THEN
    RAISE EXCEPTION 'STOP: training/completion/added/swap/shift/revision/feedback/video/activity exists; inspect B counts';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rglx_exercises_20261029) THEN
    RAISE EXCEPTION 'STOP: no prescription content';
  END IF;
  IF EXISTS (SELECT 1 FROM public.rglx_days_20261029 d JOIN public.rglx_plans_20261029 p ON p.id=d.plan_id
    WHERE d.week_number>p.plan_weeks OR p.start_date+(d.week_number-1)*7+d.day_of_week-1>p.end_date) THEN
    RAISE EXCEPTION 'STOP: days outside original plan bounds';
  END IF;
  IF EXISTS (SELECT 1 FROM public.rglx_days_20261029 d
    JOIN public.rglx_plans_20261029 p ON p.id=d.plan_id
    JOIN public.rglx_exercises_20261029 e ON e.plan_day_id=d.id
    WHERE p.start_date+(d.week_number-1)*7+d.day_of_week-1 < DATE '2026-10-31') THEN
    RAISE EXCEPTION 'STOP: content before new start date (including exercise rows with zero sets)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.rglx_days_20261029 GROUP BY week_number,day_of_week HAVING count(*)>1) THEN
    RAISE EXCEPTION 'STOP: duplicate calendar slots; inspect before regrouping';
  END IF;
  DELETE FROM public.plan_days d USING public.rglx_plans_20261029 p
  WHERE d.plan_id=p.id AND p.start_date+(d.week_number-1)*7+d.day_of_week-1 < DATE '2026-10-31';
  GET DIAGNOSTICS removed = ROW_COUNT;
  UPDATE public.plan_days d SET
    week_number=(p.start_date+(old.week_number-1)*7+old.day_of_week-1-DATE '2026-10-31')/7+1,
    day_of_week=(p.start_date+(old.week_number-1)*7+old.day_of_week-1-DATE '2026-10-31')%7+1
  FROM public.rglx_days_20261029 old JOIN public.rglx_plans_20261029 p ON p.id=old.plan_id
  WHERE d.id=old.id;
  SELECT max(week_number) INTO new_weeks FROM public.plan_days WHERE plan_id=v_id;
  IF new_weeks IS NULL OR new_weeks NOT BETWEEN 1 AND 52 THEN RAISE EXCEPTION 'STOP: invalid resulting weeks'; END IF;
  UPDATE public.plans SET start_date=DATE '2026-10-31',end_date=DATE '2026-10-31'+new_weeks*7-1,
    plan_weeks=new_weeks,anchor_weekday=6,updated_at=clock_timestamp() WHERE id=v_id;
  -- Full-join validates every original surviving ID/date, deleted early ID, and absence of new IDs.
  IF EXISTS (
    SELECT 1 FROM (SELECT d.id,p.start_date+(d.week_number-1)*7+d.day_of_week-1 AS dt
      FROM public.rglx_days_20261029 d JOIN public.rglx_plans_20261029 p ON p.id=d.plan_id) old
    FULL JOIN (SELECT d.id,p.start_date+(d.week_number-1)*7+d.day_of_week-1 AS dt
      FROM public.plan_days d JOIN public.plans p ON p.id=d.plan_id WHERE p.id=v_id) cur USING(id)
    WHERE (old.dt>=DATE '2026-10-31' AND (cur.id IS NULL OR old.dt IS DISTINCT FROM cur.dt))
      OR (old.dt<DATE '2026-10-31' AND cur.id IS NOT NULL) OR old.id IS NULL
  ) THEN RAISE EXCEPTION 'STOP: per-ID date invariant failed'; END IF;
  IF EXISTS ((SELECT to_jsonb(e) FROM public.plan_exercises e WHERE e.plan_day_id IN (SELECT id FROM public.rglx_days_20261029)
    EXCEPT SELECT to_jsonb(e) FROM public.rglx_exercises_20261029 e)
    UNION ALL (SELECT to_jsonb(e) FROM public.rglx_exercises_20261029 e EXCEPT
    SELECT to_jsonb(e) FROM public.plan_exercises e WHERE e.plan_day_id IN (SELECT id FROM public.rglx_days_20261029)))
    OR EXISTS ((SELECT to_jsonb(s) FROM public.plan_sets s WHERE s.plan_exercise_id IN (SELECT id FROM public.rglx_exercises_20261029)
    EXCEPT SELECT to_jsonb(s) FROM public.rglx_sets_20261029 s)
    UNION ALL (SELECT to_jsonb(s) FROM public.rglx_sets_20261029 s EXCEPT
    SELECT to_jsonb(s) FROM public.plan_sets s WHERE s.plan_exercise_id IN (SELECT id FROM public.rglx_exercises_20261029))) THEN
    RAISE EXCEPTION 'STOP: prescription/parent IDs changed';
  END IF;
  INSERT INTO public.rglx_after_plans_20261029 SELECT * FROM public.plans WHERE id=v_id;
  INSERT INTO public.rglx_after_days_20261029 SELECT * FROM public.plan_days WHERE plan_id=v_id;
  UPDATE public.rglx_run_20261029 SET applied_at=clock_timestamp() WHERE plan_id=v_id;
  RAISE NOTICE 'Regrouped: deleted empty days=%, old weeks=6, new weeks=%, end=%',removed,new_weeks,DATE '2026-10-31'+new_weeks*7-1;
END $regroup$;
COMMIT;

-- SECTION D
-- Read only. date_mismatches=0; missing_prescriptions=0; new W1=10/31,11/1,11/3,11/4.
SELECT p.id,p.start_date,p.end_date,p.plan_weeks,p.anchor_weekday,p.status,p.published_at,
  (SELECT count(*) FROM public.plan_days WHERE plan_id=p.id) AS remaining_days,
  (SELECT count(*) FROM public.rglx_days_20261029)-(SELECT count(*) FROM public.plan_days WHERE plan_id=p.id) AS removed_empty_days
FROM public.plans p JOIN public.rglx_run_20261029 r ON r.plan_id=p.id;
SELECT d.id,d.week_number,d.day_of_week,p.start_date+(d.week_number-1)*7+d.day_of_week-1 AS actual_date,
  oldp.start_date+(old.week_number-1)*7+old.day_of_week-1 AS backed_up_date,
  (SELECT count(*) FROM public.plan_exercises e WHERE e.plan_day_id=d.id) AS exercise_rows
FROM public.plan_days d JOIN public.plans p ON p.id=d.plan_id
JOIN public.rglx_days_20261029 old ON old.id=d.id JOIN public.rglx_plans_20261029 oldp ON oldp.id=old.plan_id
ORDER BY d.week_number,d.day_of_week,d.id;
SELECT count(*) AS date_mismatches FROM public.rglx_days_20261029 old
JOIN public.rglx_plans_20261029 op ON op.id=old.plan_id
LEFT JOIN public.plan_days d ON d.id=old.id LEFT JOIN public.plans p ON p.id=d.plan_id
WHERE op.start_date+(old.week_number-1)*7+old.day_of_week-1>=DATE '2026-10-31'
AND (d.id IS NULL OR op.start_date+(old.week_number-1)*7+old.day_of_week-1 IS DISTINCT FROM p.start_date+(d.week_number-1)*7+d.day_of_week-1);
SELECT (SELECT count(*) FROM public.rglx_exercises_20261029 b WHERE NOT EXISTS
  (SELECT 1 FROM public.plan_exercises e WHERE to_jsonb(e)=to_jsonb(b))) AS missing_prescriptions,
  (SELECT count(*) FROM public.rglx_sets_20261029 b WHERE NOT EXISTS
  (SELECT 1 FROM public.plan_sets s WHERE to_jsonb(s)=to_jsonb(b))) AS missing_sets;

-- SECTION E
-- OPTIONAL rollback only. Refuses if anything in scope changed after C, including new training.
-- Restores original plans/day rows; unchanged prescriptions/related rows are verified, not overwritten.
BEGIN;
SET LOCAL search_path TO public, pg_catalog;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.student_profiles,
  public.plans,
  public.plan_days,
  public.plan_exercises,
  public.plan_sets,
  public.plan_pending_revisions,
  public.plan_day_completions,
  public.plan_day_shifts,
  public.plan_shift_batches,
  public.set_logs,
  public.feedback,
  public.attachments,
  public.video_markers,
  public.messages,
  public.session_reviews,
  public.training_sessions,
  public.student_events,
  public.student_signals,
  public.notification_outbox
IN SHARE ROW EXCLUSIVE MODE NOWAIT;
DO $restore$
DECLARE v_id uuid := 'FILL_PLAN_ID_FROM_A'::uuid; r record; mismatch boolean;
BEGIN
  IF (SELECT count(*) FROM public.rglx_plans_20261029)<>1
    OR NOT EXISTS (SELECT 1 FROM public.rglx_plans_20261029 WHERE id=v_id)
    OR NOT EXISTS (SELECT 1 FROM public.rglx_run_20261029 WHERE plan_id=v_id AND applied_at IS NOT NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION 'STOP: backup ID mismatch or correction not applied/already rolled back';
  END IF;
  IF EXISTS ((SELECT to_jsonb(t) FROM public.plans t WHERE t.id IN (SELECT id FROM public.rglx_plans_20261029) EXCEPT SELECT to_jsonb(x) FROM public.rglx_after_plans_20261029 x)
    UNION ALL (SELECT to_jsonb(x) FROM public.rglx_after_plans_20261029 x EXCEPT SELECT to_jsonb(t) FROM public.plans t WHERE t.id IN (SELECT id FROM public.rglx_plans_20261029))) THEN
    RAISE EXCEPTION 'STOP: plans differs from post-change image';
  END IF;
  IF EXISTS ((SELECT to_jsonb(t) FROM public.plan_days t WHERE t.plan_id IN (SELECT id FROM public.rglx_plans_20261029) EXCEPT SELECT to_jsonb(x) FROM public.rglx_after_days_20261029 x)
    UNION ALL (SELECT to_jsonb(x) FROM public.rglx_after_days_20261029 x EXCEPT SELECT to_jsonb(t) FROM public.plan_days t WHERE t.plan_id IN (SELECT id FROM public.rglx_plans_20261029))) THEN
    RAISE EXCEPTION 'STOP: plan_days differs from post-change image';
  END IF;
  IF EXISTS ((SELECT to_jsonb(t) FROM public.plan_exercises t WHERE t.plan_day_id IN (SELECT id FROM public.rglx_days_20261029) EXCEPT SELECT to_jsonb(x) FROM public.rglx_exercises_20261029 x)
    UNION ALL (SELECT to_jsonb(x) FROM public.rglx_exercises_20261029 x EXCEPT SELECT to_jsonb(t) FROM public.plan_exercises t WHERE t.plan_day_id IN (SELECT id FROM public.rglx_days_20261029))) THEN
    RAISE EXCEPTION 'STOP: plan_exercises differs from post-change image';
  END IF;
  IF EXISTS ((SELECT to_jsonb(t) FROM public.plan_sets t WHERE t.plan_exercise_id IN (SELECT id FROM public.rglx_exercises_20261029) EXCEPT SELECT to_jsonb(x) FROM public.rglx_sets_20261029 x)
    UNION ALL (SELECT to_jsonb(x) FROM public.rglx_sets_20261029 x EXCEPT SELECT to_jsonb(t) FROM public.plan_sets t WHERE t.plan_exercise_id IN (SELECT id FROM public.rglx_exercises_20261029))) THEN
    RAISE EXCEPTION 'STOP: plan_sets differs from post-change image';
  END IF;
  FOR r IN SELECT * FROM public.rglx_scope_20261029 ORDER BY ordinal LOOP
    EXECUTE format('SELECT EXISTS ((SELECT to_jsonb(t) FROM public.%I t WHERE (%s) OR to_jsonb(t)->>''id'' IN (SELECT row_data->>''id'' FROM public.rglx_related_20261029 WHERE table_name=%L) EXCEPT SELECT row_data FROM public.rglx_related_20261029 WHERE table_name=%L) UNION ALL (SELECT row_data FROM public.rglx_related_20261029 WHERE table_name=%L EXCEPT SELECT to_jsonb(t) FROM public.%I t WHERE (%s) OR to_jsonb(t)->>''id'' IN (SELECT row_data->>''id'' FROM public.rglx_related_20261029 WHERE table_name=%L)))',
      r.table_name,r.predicate,r.table_name,r.table_name,r.table_name,r.table_name,r.predicate,r.table_name) INTO mismatch;
    IF mismatch THEN RAISE EXCEPTION 'STOP: related rows changed since backup: %',r.table_name; END IF;
  END LOOP;
  UPDATE public.plan_days d SET week_number=b.week_number,day_of_week=b.day_of_week,sort_order=b.sort_order
    FROM public.rglx_days_20261029 b WHERE d.id=b.id;
  INSERT INTO public.plan_days SELECT b.* FROM public.rglx_days_20261029 b
    WHERE NOT EXISTS (SELECT 1 FROM public.plan_days d WHERE d.id=b.id);
  UPDATE public.plans p SET start_date=b.start_date,end_date=b.end_date,plan_weeks=b.plan_weeks,
    anchor_weekday=b.anchor_weekday,updated_at=b.updated_at FROM public.rglx_plans_20261029 b WHERE p.id=b.id;
  IF EXISTS ((SELECT to_jsonb(t) FROM public.plans t WHERE t.id IN (SELECT id FROM public.rglx_plans_20261029) EXCEPT SELECT to_jsonb(x) FROM public.rglx_plans_20261029 x)
    UNION ALL (SELECT to_jsonb(x) FROM public.rglx_plans_20261029 x EXCEPT SELECT to_jsonb(t) FROM public.plans t WHERE t.id IN (SELECT id FROM public.rglx_plans_20261029))) THEN
    RAISE EXCEPTION 'STOP: plans differs from backup image';
  END IF;
  IF EXISTS ((SELECT to_jsonb(t) FROM public.plan_days t WHERE t.plan_id IN (SELECT id FROM public.rglx_plans_20261029) EXCEPT SELECT to_jsonb(x) FROM public.rglx_days_20261029 x)
    UNION ALL (SELECT to_jsonb(x) FROM public.rglx_days_20261029 x EXCEPT SELECT to_jsonb(t) FROM public.plan_days t WHERE t.plan_id IN (SELECT id FROM public.rglx_plans_20261029))) THEN
    RAISE EXCEPTION 'STOP: plan_days differs from backup image';
  END IF;
  IF EXISTS ((SELECT to_jsonb(t) FROM public.plan_exercises t WHERE t.plan_day_id IN (SELECT id FROM public.rglx_days_20261029) EXCEPT SELECT to_jsonb(x) FROM public.rglx_exercises_20261029 x)
    UNION ALL (SELECT to_jsonb(x) FROM public.rglx_exercises_20261029 x EXCEPT SELECT to_jsonb(t) FROM public.plan_exercises t WHERE t.plan_day_id IN (SELECT id FROM public.rglx_days_20261029))) THEN
    RAISE EXCEPTION 'STOP: plan_exercises differs from backup image';
  END IF;
  IF EXISTS ((SELECT to_jsonb(t) FROM public.plan_sets t WHERE t.plan_exercise_id IN (SELECT id FROM public.rglx_exercises_20261029) EXCEPT SELECT to_jsonb(x) FROM public.rglx_sets_20261029 x)
    UNION ALL (SELECT to_jsonb(x) FROM public.rglx_sets_20261029 x EXCEPT SELECT to_jsonb(t) FROM public.plan_sets t WHERE t.plan_exercise_id IN (SELECT id FROM public.rglx_exercises_20261029))) THEN
    RAISE EXCEPTION 'STOP: plan_sets differs from backup image';
  END IF;
  UPDATE public.rglx_run_20261029 SET rolled_back_at=clock_timestamp() WHERE plan_id=v_id;
  RAISE NOTICE 'Restored exact original plan/day rows; prescriptions and related rows unchanged';
END $restore$;
COMMIT;
SELECT p.id,p.start_date,p.end_date,p.plan_weeks,p.anchor_weekday,
 (SELECT count(*) FROM public.plan_days d WHERE d.plan_id=p.id) AS restored_days
FROM public.plans p JOIN public.rglx_run_20261029 r ON r.plan_id=p.id;
