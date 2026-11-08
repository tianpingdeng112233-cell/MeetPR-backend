-- DMS 专用一次性脚本. 只逐段粘贴, 不运行整个文件. S4 仅用于备用恢复.
-- 执行期间教练和学员停止本计划的编辑与训练, 关闭旧编辑页面.
-- 任意错误或非预期输出立即停止, 保留所有备份, 不删除或覆盖备份.
-- 不依赖会话状态. 单条修改语句自身原子执行, 多条备份不构成同一快照.
-- 原始 20 天全部保留. 预期 5 周, 最后训练日 12/02, 区间结束 12/04.

-- SECTION S0
-- 只读一行. 首次执行所有列为 0. backup_* 为 1 时先核对已有备份.
-- 旧版遗留的五张辅助表只探测, 本版不读取或写入它们.
WITH target AS MATERIALIZED (
  SELECT * FROM public.plans WHERE id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid
), days AS MATERIALIZED (
  SELECT * FROM public.plan_days WHERE plan_id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid
), exercises AS MATERIALIZED (
  SELECT * FROM public.plan_exercises WHERE plan_day_id IN (SELECT id FROM days)
), prescriptions AS MATERIALIZED (
  SELECT * FROM public.plan_sets WHERE plan_exercise_id IN (SELECT id FROM exercises)
),
risks AS MATERIALIZED (
  SELECT
    (SELECT count(*) FROM public.set_logs t WHERE t.plan_day_id IN (SELECT id FROM days) OR t.plan_exercise_id IN (SELECT id FROM exercises) OR (t.student_id IN (SELECT trainee_id FROM target) AND t.logged_date BETWEEN DATE '2026-10-26' AND DATE '2026-12-11')) AS set_logs,
    (SELECT count(*) FROM public.plan_day_completions t WHERE t.plan_day_id IN (SELECT id FROM days)) AS plan_day_completions,
    (SELECT count(*) FROM public.plan_day_shifts t WHERE t.plan_day_id IN (SELECT id FROM days)) AS plan_day_shifts,
    (SELECT count(*) FROM public.plan_shift_batches t WHERE t.plan_id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid) AS plan_shift_batches,
    (SELECT count(*) FROM public.plan_pending_revisions t WHERE t.plan_id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid) AS plan_pending_revisions,
    (SELECT count(*) FROM public.feedback t WHERE t.plan_exercise_id IN (SELECT id FROM exercises) OR (t.student_id IN (SELECT trainee_id FROM target) AND t.day_date BETWEEN DATE '2026-10-26' AND DATE '2026-12-11')) AS feedback,
    (SELECT count(*) FROM public.training_sessions t WHERE t.plan_day_ids && ARRAY(SELECT id FROM days) OR (t.student_id IN (SELECT trainee_id FROM target) AND t.session_date BETWEEN DATE '2026-10-26' AND DATE '2026-12-11')) AS training_sessions,
    (SELECT count(*) FROM public.student_events t WHERE t.student_id IN (SELECT trainee_id FROM target) AND t.session_date BETWEEN DATE '2026-10-26' AND DATE '2026-12-11') AS student_events,
    (SELECT count(*) FROM public.session_reviews t WHERE t.student_id IN (SELECT trainee_id FROM target) AND t.review_date BETWEEN DATE '2026-10-26' AND DATE '2026-12-11') AS session_reviews,
    (SELECT count(*) FROM public.student_signals t WHERE t.student_id IN (SELECT trainee_id FROM target) AND t.opened_at>=DATE '2026-10-26') AS student_signals
)
SELECT
  (to_regclass('public.rglx_plans_20261029') IS NOT NULL)::int AS backup_plans,
  (to_regclass('public.rglx_days_20261029') IS NOT NULL)::int AS backup_days,
  (to_regclass('public.rglx_exercises_20261029') IS NOT NULL)::int AS backup_exercises,
  (to_regclass('public.rglx_sets_20261029') IS NOT NULL)::int AS backup_sets,
  (to_regclass('public.rglx_related_20261029') IS NOT NULL)::int AS backup_related,
  (to_regclass('public.rglx_after_plans_20261029') IS NOT NULL)::int AS backup_after_plans,
  (to_regclass('public.rglx_after_days_20261029') IS NOT NULL)::int AS backup_after_days,
  (to_regclass('public.rglx_run_20261029') IS NOT NULL)::int AS backup_run,
  (to_regclass('public.rglx_scope_20261029') IS NOT NULL)::int AS backup_scope,
  (1-(SELECT count(*) FROM target)) AS target_missing,
  r.*
FROM risks r;

-- SECTION S1
-- 四条分别粘贴. 成功创建行数依次应为 1,20,E,T.
-- E/T 以现场实际动作为准, 不假定与本地演练相同.
-- 表已存在会报错. 停在该条, 用 S1b 对应查询检查, 绝不覆盖.
-- 部分已存在时只执行缺失表的创建语句, 每条成功后核对.
CREATE TABLE public.rglx_plans_20261029 AS
SELECT * FROM public.plans WHERE id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid;
CREATE TABLE public.rglx_days_20261029 AS
SELECT * FROM public.plan_days WHERE plan_id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid;
CREATE TABLE public.rglx_exercises_20261029 AS
SELECT e.* FROM public.plan_exercises e JOIN public.plan_days d ON d.id=e.plan_day_id
WHERE d.plan_id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid;
CREATE TABLE public.rglx_sets_20261029 AS
SELECT s.* FROM public.plan_sets s JOIN public.plan_exercises e ON e.id=s.plan_exercise_id
JOIN public.plan_days d ON d.id=e.plan_day_id WHERE d.plan_id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid;

-- SECTION S1b
-- 四条只读查询分别核对, 只粘贴 S0 显示已存在的表对应查询.
-- 全部应为 backup_rows=current_rows, 后两者均大于 0. 前两者分别为 1 和 20.
-- 表缺失则查询报错但不改任何数据. 同行数并不足以放行, S2 另核对全行内容.
WITH target AS MATERIALIZED (
  SELECT * FROM public.plans WHERE id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid
), days AS MATERIALIZED (
  SELECT * FROM public.plan_days WHERE plan_id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid
), exercises AS MATERIALIZED (
  SELECT * FROM public.plan_exercises WHERE plan_day_id IN (SELECT id FROM days)
), prescriptions AS MATERIALIZED (
  SELECT * FROM public.plan_sets WHERE plan_exercise_id IN (SELECT id FROM exercises)
)
SELECT 'plans' AS table_name,(SELECT count(*) FROM public.rglx_plans_20261029) AS backup_rows,
  (SELECT count(*) FROM target) AS current_rows;
WITH target AS MATERIALIZED (
  SELECT * FROM public.plans WHERE id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid
), days AS MATERIALIZED (
  SELECT * FROM public.plan_days WHERE plan_id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid
), exercises AS MATERIALIZED (
  SELECT * FROM public.plan_exercises WHERE plan_day_id IN (SELECT id FROM days)
), prescriptions AS MATERIALIZED (
  SELECT * FROM public.plan_sets WHERE plan_exercise_id IN (SELECT id FROM exercises)
)
SELECT 'days' AS table_name,(SELECT count(*) FROM public.rglx_days_20261029) AS backup_rows,
  (SELECT count(*) FROM days) AS current_rows;
WITH target AS MATERIALIZED (
  SELECT * FROM public.plans WHERE id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid
), days AS MATERIALIZED (
  SELECT * FROM public.plan_days WHERE plan_id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid
), exercises AS MATERIALIZED (
  SELECT * FROM public.plan_exercises WHERE plan_day_id IN (SELECT id FROM days)
), prescriptions AS MATERIALIZED (
  SELECT * FROM public.plan_sets WHERE plan_exercise_id IN (SELECT id FROM exercises)
)
SELECT 'exercises' AS table_name,(SELECT count(*) FROM public.rglx_exercises_20261029) AS backup_rows,
  (SELECT count(*) FROM exercises) AS current_rows;
WITH target AS MATERIALIZED (
  SELECT * FROM public.plans WHERE id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid
), days AS MATERIALIZED (
  SELECT * FROM public.plan_days WHERE plan_id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid
), exercises AS MATERIALIZED (
  SELECT * FROM public.plan_exercises WHERE plan_day_id IN (SELECT id FROM days)
), prescriptions AS MATERIALIZED (
  SELECT * FROM public.plan_sets WHERE plan_exercise_id IN (SELECT id FROM exercises)
)
SELECT 'sets' AS table_name,(SELECT count(*) FROM public.rglx_sets_20261029) AS backup_rows,
  (SELECT count(*) FROM prescriptions) AS current_rows;

-- SECTION S2
-- 单条修改. 缺表在解析时即报错. 其它守卫失败会报含 STOP 的整数转换错误.
-- 预期一行: start_date=10/31,end_date=12/04,plan_weeks=5,status=published,
-- changed_days=20,date_mismatches=0,deleted_days=0,guard_ok=1. 不可重复执行.
WITH target AS MATERIALIZED (
  SELECT * FROM public.plans WHERE id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid
), days AS MATERIALIZED (
  SELECT * FROM public.plan_days WHERE plan_id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid
), exercises AS MATERIALIZED (
  SELECT * FROM public.plan_exercises WHERE plan_day_id IN (SELECT id FROM days)
), prescriptions AS MATERIALIZED (
  SELECT * FROM public.plan_sets WHERE plan_exercise_id IN (SELECT id FROM exercises)
),
risks AS MATERIALIZED (
  SELECT
    (SELECT count(*) FROM public.set_logs t WHERE t.plan_day_id IN (SELECT id FROM days) OR t.plan_exercise_id IN (SELECT id FROM exercises) OR (t.student_id IN (SELECT trainee_id FROM target) AND t.logged_date BETWEEN DATE '2026-10-26' AND DATE '2026-12-11')) AS set_logs,
    (SELECT count(*) FROM public.plan_day_completions t WHERE t.plan_day_id IN (SELECT id FROM days)) AS plan_day_completions,
    (SELECT count(*) FROM public.plan_day_shifts t WHERE t.plan_day_id IN (SELECT id FROM days)) AS plan_day_shifts,
    (SELECT count(*) FROM public.plan_shift_batches t WHERE t.plan_id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid) AS plan_shift_batches,
    (SELECT count(*) FROM public.plan_pending_revisions t WHERE t.plan_id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid) AS plan_pending_revisions,
    (SELECT count(*) FROM public.feedback t WHERE t.plan_exercise_id IN (SELECT id FROM exercises) OR (t.student_id IN (SELECT trainee_id FROM target) AND t.day_date BETWEEN DATE '2026-10-26' AND DATE '2026-12-11')) AS feedback,
    (SELECT count(*) FROM public.training_sessions t WHERE t.plan_day_ids && ARRAY(SELECT id FROM days) OR (t.student_id IN (SELECT trainee_id FROM target) AND t.session_date BETWEEN DATE '2026-10-26' AND DATE '2026-12-11')) AS training_sessions,
    (SELECT count(*) FROM public.student_events t WHERE t.student_id IN (SELECT trainee_id FROM target) AND t.session_date BETWEEN DATE '2026-10-26' AND DATE '2026-12-11') AS student_events,
    (SELECT count(*) FROM public.session_reviews t WHERE t.student_id IN (SELECT trainee_id FROM target) AND t.review_date BETWEEN DATE '2026-10-26' AND DATE '2026-12-11') AS session_reviews,
    (SELECT count(*) FROM public.student_signals t WHERE t.student_id IN (SELECT trainee_id FROM target) AND t.opened_at>=DATE '2026-10-26') AS student_signals
),
original_plan AS MATERIALIZED (SELECT * FROM public.rglx_plans_20261029),
original_days AS MATERIALIZED (SELECT * FROM public.rglx_days_20261029),
positions AS MATERIALIZED (
  SELECT d.id,d.plan_id,p.start_date+(d.week_number-1)*7+d.day_of_week-1 AS actual_date,
    (p.start_date+(d.week_number-1)*7+d.day_of_week-1-DATE '2026-10-31')/7+1 AS new_week,
    (p.start_date+(d.week_number-1)*7+d.day_of_week-1-DATE '2026-10-31')%7+1 AS new_day
  FROM original_days d JOIN original_plan p ON p.id=d.plan_id
),
guard AS MATERIALIZED (
  SELECT CAST(CASE WHEN (SELECT count(*) FROM original_plan)=1
    AND EXISTS (SELECT 1 FROM original_plan WHERE id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid
      AND status='published' AND kind='regular' AND start_date=DATE '2026-10-26'
      AND end_date=DATE '2026-12-06' AND plan_weeks=6)
    AND (SELECT count(*) FROM original_days)=20
    AND (SELECT count(*) FROM positions)=20
    AND (SELECT count(DISTINCT actual_date) FROM positions)=20
    AND NOT EXISTS (SELECT 1 FROM positions WHERE actual_date<DATE '2026-10-31' OR actual_date>DATE '2026-12-02')
    AND (SELECT max(new_week) FROM positions)=5
    AND (SELECT max(actual_date) FROM positions)=DATE '2026-12-02'
    AND NOT EXISTS (SELECT 1 FROM days d WHERE NOT EXISTS (SELECT 1 FROM exercises e WHERE e.plan_day_id=d.id))
    AND (SELECT count(*) FROM prescriptions)>0
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index
      WHERE indrelid='public.plan_days'::regclass AND indisunique AND NOT indisprimary)
    AND r.set_logs=0 AND r.plan_day_completions=0 AND r.plan_day_shifts=0 AND r.plan_shift_batches=0 AND r.plan_pending_revisions=0 AND r.feedback=0 AND r.training_sessions=0 AND r.student_events=0 AND r.session_reviews=0 AND r.student_signals=0
    AND NOT EXISTS (
      (SELECT to_jsonb(t) FROM target t EXCEPT ALL SELECT to_jsonb(b) FROM original_plan b)
      UNION ALL
      (SELECT to_jsonb(b) FROM original_plan b EXCEPT ALL SELECT to_jsonb(t) FROM target t)
    )
    AND NOT EXISTS (
      (SELECT to_jsonb(t) FROM days t EXCEPT ALL SELECT to_jsonb(b) FROM original_days b)
      UNION ALL
      (SELECT to_jsonb(b) FROM original_days b EXCEPT ALL SELECT to_jsonb(t) FROM days t)
    )
    AND NOT EXISTS (
      (SELECT to_jsonb(t) FROM exercises t EXCEPT ALL SELECT to_jsonb(b) FROM public.rglx_exercises_20261029 b)
      UNION ALL
      (SELECT to_jsonb(b) FROM public.rglx_exercises_20261029 b EXCEPT ALL SELECT to_jsonb(t) FROM exercises t)
    )
    AND NOT EXISTS (
      (SELECT to_jsonb(t) FROM prescriptions t EXCEPT ALL SELECT to_jsonb(b) FROM public.rglx_sets_20261029 b)
      UNION ALL
      (SELECT to_jsonb(b) FROM public.rglx_sets_20261029 b EXCEPT ALL SELECT to_jsonb(t) FROM prescriptions t)
    )
    THEN '1' ELSE 'STOP: S2 state, backup, risk or schema mismatch' END AS integer) AS ok
  FROM risks r
),
changed_days AS (
  UPDATE public.plan_days d
  SET
    week_number=x.new_week,day_of_week=x.new_day
  FROM positions x CROSS JOIN guard g
  WHERE d.id=x.id AND g.ok=1
  RETURNING d.id,d.week_number,d.day_of_week
),
changed_plan AS (
  UPDATE public.plans p
  SET
    start_date=DATE '2026-10-31',plan_weeks=(SELECT max(new_week) FROM positions),
    end_date=DATE '2026-10-31'+(SELECT max(new_week) FROM positions)*7-1,
    anchor_weekday=6,updated_at=now()
  FROM guard g
  WHERE p.id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid AND g.ok=1 AND (SELECT count(*) FROM changed_days)=20
  RETURNING p.start_date,p.end_date,p.plan_weeks,p.status
)
SELECT g.ok AS guard_ok,p.start_date::text,p.end_date::text,p.plan_weeks,p.status,
  (SELECT count(*) FROM changed_days) AS changed_days,0 AS deleted_days,
  (SELECT count(*) FROM positions x FULL JOIN changed_days d USING(id)
    WHERE x.id IS NULL OR d.id IS NULL
      OR x.actual_date IS DISTINCT FROM DATE '2026-10-31'+(d.week_number-1)*7+d.day_of_week-1) AS date_mismatches
FROM guard g LEFT JOIN changed_plan p ON true;

-- SECTION S3
-- 只读一行: 10/31,12/04,5,published,20,三个差异均 0. 每周均 4 天.
-- W1=10/31,11/01,11/03,11/04. W5=11/28,11/29,12/01,12/02.
WITH target AS MATERIALIZED (
  SELECT * FROM public.plans WHERE id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid
), days AS MATERIALIZED (
  SELECT * FROM public.plan_days WHERE plan_id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid
), exercises AS MATERIALIZED (
  SELECT * FROM public.plan_exercises WHERE plan_day_id IN (SELECT id FROM days)
), prescriptions AS MATERIALIZED (
  SELECT * FROM public.plan_sets WHERE plan_exercise_id IN (SELECT id FROM exercises)
),
original_dates AS (
  SELECT d.id,p.start_date+(d.week_number-1)*7+d.day_of_week-1 AS actual_date
  FROM public.rglx_days_20261029 d JOIN public.rglx_plans_20261029 p ON p.id=d.plan_id
), current_dates AS (
  SELECT d.id,d.week_number,p.start_date+(d.week_number-1)*7+d.day_of_week-1 AS actual_date
  FROM days d JOIN target p ON p.id=d.plan_id
), weeks AS (
  SELECT week_number,string_agg(actual_date::text,',' ORDER BY actual_date) AS dates
  FROM current_dates GROUP BY week_number
)
SELECT p.start_date::text,p.end_date::text,p.plan_weeks,p.anchor_weekday,p.status,
  (SELECT count(*) FROM days) AS days,
  (SELECT count(*) FROM original_dates o FULL JOIN current_dates c USING(id)
    WHERE o.id IS NULL OR c.id IS NULL OR o.actual_date IS DISTINCT FROM c.actual_date) AS date_mismatches,
  (SELECT count(*) FROM public.rglx_exercises_20261029 b WHERE NOT EXISTS
    (SELECT 1 FROM exercises e WHERE to_jsonb(e)=to_jsonb(b))) AS missing_exercises,
  (SELECT count(*) FROM public.rglx_sets_20261029 b WHERE NOT EXISTS
    (SELECT 1 FROM prescriptions s WHERE to_jsonb(s)=to_jsonb(b))) AS missing_sets,
  (SELECT string_agg('W'||week_number||'='||dates,' | ' ORDER BY week_number) FROM weeks) AS week_dates
FROM target p;

-- SECTION S4
-- 仅备用恢复, 不是 S3 后的常规下一步. 单条语句, 缺表/状态偏离/新增训练均报错.
-- 核对修改后的全行内容, plans.updated_at 除外, 该时间没有另存后图.
-- 预期 guard_ok=1,start_date=10/26,end_date=12/06,plan_weeks=6,restored_days=20.
-- anchor_weekday 与 updated_at 精确恢复备份值. 恢复后 S3 日期差仍 0.
WITH target AS MATERIALIZED (
  SELECT * FROM public.plans WHERE id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid
), days AS MATERIALIZED (
  SELECT * FROM public.plan_days WHERE plan_id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid
), exercises AS MATERIALIZED (
  SELECT * FROM public.plan_exercises WHERE plan_day_id IN (SELECT id FROM days)
), prescriptions AS MATERIALIZED (
  SELECT * FROM public.plan_sets WHERE plan_exercise_id IN (SELECT id FROM exercises)
),
risks AS MATERIALIZED (
  SELECT
    (SELECT count(*) FROM public.set_logs t WHERE t.plan_day_id IN (SELECT id FROM days) OR t.plan_exercise_id IN (SELECT id FROM exercises) OR (t.student_id IN (SELECT trainee_id FROM target) AND t.logged_date BETWEEN DATE '2026-10-26' AND DATE '2026-12-11')) AS set_logs,
    (SELECT count(*) FROM public.plan_day_completions t WHERE t.plan_day_id IN (SELECT id FROM days)) AS plan_day_completions,
    (SELECT count(*) FROM public.plan_day_shifts t WHERE t.plan_day_id IN (SELECT id FROM days)) AS plan_day_shifts,
    (SELECT count(*) FROM public.plan_shift_batches t WHERE t.plan_id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid) AS plan_shift_batches,
    (SELECT count(*) FROM public.plan_pending_revisions t WHERE t.plan_id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid) AS plan_pending_revisions,
    (SELECT count(*) FROM public.feedback t WHERE t.plan_exercise_id IN (SELECT id FROM exercises) OR (t.student_id IN (SELECT trainee_id FROM target) AND t.day_date BETWEEN DATE '2026-10-26' AND DATE '2026-12-11')) AS feedback,
    (SELECT count(*) FROM public.training_sessions t WHERE t.plan_day_ids && ARRAY(SELECT id FROM days) OR (t.student_id IN (SELECT trainee_id FROM target) AND t.session_date BETWEEN DATE '2026-10-26' AND DATE '2026-12-11')) AS training_sessions,
    (SELECT count(*) FROM public.student_events t WHERE t.student_id IN (SELECT trainee_id FROM target) AND t.session_date BETWEEN DATE '2026-10-26' AND DATE '2026-12-11') AS student_events,
    (SELECT count(*) FROM public.session_reviews t WHERE t.student_id IN (SELECT trainee_id FROM target) AND t.review_date BETWEEN DATE '2026-10-26' AND DATE '2026-12-11') AS session_reviews,
    (SELECT count(*) FROM public.student_signals t WHERE t.student_id IN (SELECT trainee_id FROM target) AND t.opened_at>=DATE '2026-10-26') AS student_signals
),
original_plan AS MATERIALIZED (SELECT * FROM public.rglx_plans_20261029),
original_days AS MATERIALIZED (SELECT * FROM public.rglx_days_20261029),
positions AS MATERIALIZED (
  SELECT d.id,d.plan_id,p.start_date+(d.week_number-1)*7+d.day_of_week-1 AS actual_date,
    (p.start_date+(d.week_number-1)*7+d.day_of_week-1-DATE '2026-10-31')/7+1 AS new_week,
    (p.start_date+(d.week_number-1)*7+d.day_of_week-1-DATE '2026-10-31')%7+1 AS new_day
  FROM original_days d JOIN original_plan p ON p.id=d.plan_id
),
guard AS MATERIALIZED (
  SELECT CAST(CASE WHEN (SELECT count(*) FROM original_plan)=1
    AND EXISTS (SELECT 1 FROM original_plan WHERE id='02db605c-d113-47ef-9303-1bcabf7b431d'::uuid
      AND status='published' AND kind='regular' AND start_date=DATE '2026-10-26'
      AND end_date=DATE '2026-12-06' AND plan_weeks=6)
    AND (SELECT count(*) FROM original_days)=20
    AND (SELECT count(*) FROM positions)=20
    AND (SELECT count(DISTINCT actual_date) FROM positions)=20
    AND NOT EXISTS (SELECT 1 FROM positions WHERE actual_date<DATE '2026-10-31' OR actual_date>DATE '2026-12-02')
    AND (SELECT max(new_week) FROM positions)=5
    AND (SELECT max(actual_date) FROM positions)=DATE '2026-12-02'
    AND NOT EXISTS (SELECT 1 FROM days d WHERE NOT EXISTS (SELECT 1 FROM exercises e WHERE e.plan_day_id=d.id))
    AND (SELECT count(*) FROM prescriptions)>0
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index
      WHERE indrelid='public.plan_days'::regclass AND indisunique AND NOT indisprimary)
    AND r.set_logs=0 AND r.plan_day_completions=0 AND r.plan_day_shifts=0 AND r.plan_shift_batches=0 AND r.plan_pending_revisions=0 AND r.feedback=0 AND r.training_sessions=0 AND r.student_events=0 AND r.session_reviews=0 AND r.student_signals=0
    AND NOT EXISTS (
      (SELECT to_jsonb(t) FROM exercises t EXCEPT ALL SELECT to_jsonb(b) FROM public.rglx_exercises_20261029 b)
      UNION ALL
      (SELECT to_jsonb(b) FROM public.rglx_exercises_20261029 b EXCEPT ALL SELECT to_jsonb(t) FROM exercises t)
    )
    AND NOT EXISTS (
      (SELECT to_jsonb(t) FROM prescriptions t EXCEPT ALL SELECT to_jsonb(b) FROM public.rglx_sets_20261029 b)
      UNION ALL
      (SELECT to_jsonb(b) FROM public.rglx_sets_20261029 b EXCEPT ALL SELECT to_jsonb(t) FROM prescriptions t)
    )
    AND (SELECT count(*) FROM target)=1 AND (SELECT count(*) FROM days)=20
    AND EXISTS (SELECT 1 FROM target p JOIN original_plan b USING(id)
      WHERE to_jsonb(p)-'updated_at' =
        (to_jsonb(b)-'updated_at') || jsonb_build_object('start_date',DATE '2026-10-31',
        'end_date',DATE '2026-12-04','plan_weeks',5,'anchor_weekday',6))
    AND NOT EXISTS (
      SELECT 1 FROM days d FULL JOIN (
        SELECT b.id,to_jsonb(b)||jsonb_build_object('week_number',x.new_week,'day_of_week',x.new_day) AS expected
        FROM original_days b JOIN positions x USING(id)
      ) e ON e.id=d.id WHERE d.id IS NULL OR e.id IS NULL OR to_jsonb(d) IS DISTINCT FROM e.expected
    )
    THEN '1' ELSE 'STOP: S4 state, backup, risk or schema mismatch' END AS integer) AS ok
  FROM risks r
),
restored_days AS (
  UPDATE public.plan_days d
  SET
    week_number=b.week_number,day_of_week=b.day_of_week
  FROM original_days b CROSS JOIN guard g
  WHERE d.id=b.id AND g.ok=1
  RETURNING d.id
),
restored_plan AS (
  UPDATE public.plans p
  SET
    start_date=b.start_date,end_date=b.end_date,plan_weeks=b.plan_weeks,
    anchor_weekday=b.anchor_weekday,updated_at=b.updated_at
  FROM original_plan b CROSS JOIN guard g
  WHERE p.id=b.id AND g.ok=1 AND (SELECT count(*) FROM restored_days)=20
  RETURNING p.start_date,p.end_date,p.plan_weeks,p.anchor_weekday,p.updated_at
)
SELECT g.ok AS guard_ok,p.start_date::text,p.end_date::text,p.plan_weeks,p.anchor_weekday,p.updated_at,
  (SELECT count(*) FROM restored_days) AS restored_days
FROM guard g LEFT JOIN restored_plan p ON true;
