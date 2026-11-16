-- 067 存量只读清单：找出已发布计划日期重叠，以及「正在练」与最近发布不同的 pair。
-- 只读：整份脚本只有一条 SELECT（含只读 CTE），无 DML/DDL、显式锁、临时表或事务控制。
-- 单条查询使用同一语句快照；不修改任何数据，不自动修复结果中的计划。
-- DMS：经 David 授权后，在阿里云 DMS SQLConsole 选择目标 staging 库 public@…:meetpr，
-- 粘贴并选中从 WITH 到末尾分号的完整语句执行；不要拆开 CTE 执行。表名显式限定 public。
-- 结果在一个结果集中，按 issue 区分 A/B。导出时核对 DMS 行数限制，截断结果不能视为完整清单。
-- 顶层列：issue TEXT、trainee_id UUID、coach_id UUID（A 可为 NULL）、details JSONB。
-- A / published_dates_overlap：同一 coach_id / trainee_id 的 published 计划闭区间相交，
-- 每对只列一次。details 含 plan_id/name/start_date/effective_end 及对应 other_* 字段。
-- effective_end = end_date 与后移/扩周后实际最后非休息训练日的较晚者；仅加周无实际日不延长。
-- B / current_differs_from_latest：仅列有 accepted 绑定且两种选择不同的 coach/student pair。
-- details.current_plan 与 details.latest_published_plan 各含：
--   id、name、start_date、end_date（计划原始日期）、effective_end（含实际训练日），
--   completed_training_days、total_training_days、latest_record_at（无记录为 JSON null）。
-- 最近记录取本人处方组/额外组、自加动作及结算的最大时间；自由训练不建立计划锚。
-- 结算行存在即已结算，休息日不计进度；时间排序截断到毫秒，与 node-postgres / JS Date 一致。
-- B 是新旧选择差异，不代表异常；A 是存量交集，不代表每次编辑都会触发日期冲突。
-- 多个 accepted 教练分别列 pair，不冒充学员接口选定的唯一 canonical 教练。
-- plans 无绑定批次 FK，同 pair 重绑前历史仍参与；不输出用户姓名、手机号或凭证，计划名按需展示。
-- 本脚本尚未在真实 PostgreSQL 执行：2026-11-16 本地 initdb 被沙箱共享内存权限拒绝。

WITH published AS (
  SELECT * FROM public.plans WHERE status = 'published'
), batch_order AS (
  -- plan-dates.ts passes each plan's shifts separately to plan-calendar.ts.
  -- Order each batch by its minimum surviving seq within that plan.
  SELECT d.plan_id, s.batch_id, min(s.seq) AS batch_seq
  FROM public.plan_day_shifts s
  JOIN public.plan_days d ON d.id = s.plan_day_id
  JOIN published p ON p.id = d.plan_id
  GROUP BY d.plan_id, s.batch_id
), latest_shift AS (
  SELECT DISTINCT ON (s.plan_day_id) s.plan_day_id, s.shifted_to_date
  FROM public.plan_day_shifts s JOIN public.plan_days d ON d.id = s.plan_day_id
  JOIN batch_order b ON b.plan_id = d.plan_id AND b.batch_id = s.batch_id
  ORDER BY s.plan_day_id, b.batch_seq DESC, s.seq DESC
), day_stats AS (
  SELECT d.plan_id,
    count(*) FILTER (WHERE NOT d.is_rest) AS total,
    count(*) FILTER (WHERE NOT d.is_rest AND c.id IS NOT NULL) AS completed,
    max(coalesce(s.shifted_to_date, p.start_date + (d.week_number - 1) * 7 + d.day_of_week - 1))
      FILTER (WHERE NOT d.is_rest) AS actual_end
  FROM public.plan_days d JOIN published p ON p.id = d.plan_id
  LEFT JOIN latest_shift s ON s.plan_day_id = d.id
  LEFT JOIN public.plan_day_completions c ON c.plan_day_id = d.id
  GROUP BY d.plan_id
), records AS (
  SELECT d.plan_id, l.logged_at AS at
  FROM public.set_logs l JOIN public.plan_exercises e ON e.id = l.plan_exercise_id
  JOIN public.plan_days d ON d.id = e.plan_day_id
  JOIN published p ON p.id = d.plan_id AND p.trainee_id = l.student_id
  UNION ALL
  SELECT d.plan_id, l.logged_at
  FROM public.set_logs l JOIN public.plan_days d ON d.id = l.plan_day_id
  JOIN published p ON p.id = d.plan_id AND p.trainee_id = l.student_id
  UNION ALL
  SELECT d.plan_id, c.completed_at
  FROM public.plan_day_completions c JOIN public.plan_days d ON d.id = c.plan_day_id
  JOIN published p ON p.id = d.plan_id
), last_record AS (
  SELECT plan_id, date_trunc('milliseconds', max(at)) AS latest_record_at FROM records GROUP BY plan_id
), facts AS (
  SELECT p.*, coalesce(d.total, 0) AS total, coalesce(d.completed, 0) AS completed,
    greatest(p.end_date, d.actual_end) AS effective_end, r.latest_record_at
  FROM published p LEFT JOIN day_stats d ON d.plan_id = p.id
  LEFT JOIN last_record r ON r.plan_id = p.id
), anchors AS (
  SELECT *, row_number() OVER (
    PARTITION BY trainee_id, coach_id ORDER BY latest_record_at DESC, date_trunc('milliseconds', created_at) DESC, id DESC
  ) AS rank
  FROM facts WHERE total > 0 AND latest_record_at IS NOT NULL
), latest AS (
  SELECT *, row_number() OVER (
    PARTITION BY trainee_id, coach_id ORDER BY date_trunc('milliseconds', published_at) DESC NULLS LAST,
      date_trunc('milliseconds', created_at) DESC, id DESC
  ) AS rank
  FROM facts
), candidates AS (
  SELECT f.*, row_number() OVER (
    PARTITION BY f.trainee_id, f.coach_id ORDER BY f.start_date, date_trunc('milliseconds', f.created_at), f.id
  ) AS rank
  FROM facts f LEFT JOIN anchors a ON a.trainee_id = f.trainee_id
    AND a.coach_id IS NOT DISTINCT FROM f.coach_id AND a.rank = 1
  WHERE f.total > f.completed AND (a.id IS NULL OR f.start_date > a.start_date)
), chosen AS (
  SELECT l.trainee_id, l.coach_id, l.id AS latest_published_id,
    CASE WHEN a.total > a.completed THEN a.id ELSE coalesce(n.id, l.id) END AS current_plan_id
  FROM latest l LEFT JOIN anchors a ON a.trainee_id = l.trainee_id
    AND a.coach_id IS NOT DISTINCT FROM l.coach_id AND a.rank = 1
  LEFT JOIN candidates n ON n.trainee_id = l.trainee_id
    AND n.coach_id IS NOT DISTINCT FROM l.coach_id AND n.rank = 1
  WHERE l.rank = 1
), report AS (
  SELECT 'published_dates_overlap' AS issue, a.trainee_id, a.coach_id,
    jsonb_build_object(
      'plan_id', a.id, 'name', a.name, 'start_date', a.start_date, 'effective_end', a.effective_end,
      'other_plan_id', b.id, 'other_name', b.name,
      'other_start_date', b.start_date, 'other_effective_end', b.effective_end
    ) AS details
  FROM facts a JOIN facts b ON b.trainee_id = a.trainee_id
    AND b.coach_id IS NOT DISTINCT FROM a.coach_id AND a.id < b.id
  WHERE a.start_date <= b.effective_end AND b.start_date <= a.effective_end
  UNION ALL
  SELECT 'current_differs_from_latest', c.trainee_id, c.coach_id,
    jsonb_build_object(
      'current_plan', jsonb_build_object(
        'id', current.id, 'name', current.name,
        'start_date', current.start_date, 'end_date', current.end_date,
        'effective_end', current.effective_end,
        'completed_training_days', current.completed, 'total_training_days', current.total,
        'latest_record_at', current.latest_record_at
      ),
      'latest_published_plan', jsonb_build_object(
        'id', recent.id, 'name', recent.name,
        'start_date', recent.start_date, 'end_date', recent.end_date,
        'effective_end', recent.effective_end,
        'completed_training_days', recent.completed, 'total_training_days', recent.total,
        'latest_record_at', recent.latest_record_at
      )
    )
  FROM chosen c JOIN facts current ON current.id = c.current_plan_id
  JOIN facts recent ON recent.id = c.latest_published_id
  WHERE c.current_plan_id <> c.latest_published_id
    AND EXISTS (SELECT 1 FROM public.bind_requests b WHERE b.student_id = c.trainee_id
      AND b.coach_id = c.coach_id AND b.status = 'accepted')
)
SELECT * FROM report ORDER BY issue, trainee_id, coach_id, details::text;
