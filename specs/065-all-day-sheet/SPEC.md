# SPEC 065 — 训练页「全天一览」后端：组重量可空、动作留言、同序预填建议

- **状态**: Ready（2026-11-10 /grill 两轮后 David「确认」）
- **产品正典**: `meetpr-rn` / `MeetPR` 仓 `specs/107-all-day-sheet/SPEC.md`（学员端与教练 App）；网页 `meetpr-plan-web` `specs/025-exercise-note/SPEC.md`。本文件只定后端。
- **级别 / 节奏**: T2（迁移 + 新接口 + 聊天契约扩展），P1。与 107、025 **同一批上线**：后端先部署 staging，客户端联调通过后一起放行。
- **migration 号开工当天现场取**（本文用 `NNNN` 占位；11/10 已知最新 0084）。

## 已拍板（不重议）

1. 学员长按「完成今天」时，没填重量的组也要存下来，重量为空（不是 0、不是不存）。
2. 「问教练」改为动作级留言：学员针对某天某个动作发文字，消息带动作引用；不附视频。
3. 只写了 RPE 的组，客户端预填「以前同一动作、同 RPE、同次数、且当天排在同一位置的那一组」的实际重量，由后端算好给出。
4. 不新增「学员确认过」字段；「按计划」由客户端比对实际与处方得出，后端不存。

## 1. 组记录重量可空

- 迁移 `NNNN-set-log-weight-nullable.sql`：`ALTER TABLE set_logs ALTER COLUMN weight_kg DROP NOT NULL;`。不改存量数据。
- 写路径（建 / 改组记录、批量补记、完成今日训练里的批量写）：`weight_kg` 允许 `null`；其余校验不变（次数、RPE 规则照旧）。
- 读路径兼容（交付红线：旧版 App 的 zod / Codable 把 `weight_kg` 当非空字符串，收到 `null` 会解析失败）：
  - 新客户端在请求头带 `X-MeetPR-Caps: set-weight-nullable`（107 两端都加）。带了的照实返回 `null`。
  - 没带的旧客户端：凡是返回组记录的接口，把 `null` 序列化为 `"0"`。只在序列化层做，不写库。
  - 覆盖所有返回 `set_logs` 行的接口（学员历史、计划详情内嵌记录、教练学员详情、聊天 `set_ref` 快照、导出）；用一个共享序列化函数，接口逐个接入。
- 服务端用到组重量的计算（e1RM / PR / 活动台账里按重量的统计）：`weight_kg IS NULL` 的组不参与，等同于不存在；不得报错。
- `set_ref` 快照的 `weight_kg` 本来就可空，不变。

## 2. 动作留言（`exercise_ref`）

- 迁移：`messages` 加 `exercise_ref JSONB NULL`；约束 `exercise_ref IS NULL OR kind = 'text'`；`set_ref` 与 `exercise_ref` 互斥（同一条消息至多一个）；`exercise_ref` 存在时 `video_id` 必须为空。
- `ExerciseRefV1`（strict 校验，形状对齐 `SetRefV1` 的写法）：
  ```json
  { "v": 1, "exercise_name": "暂停卧推", "day_date": "2026-11-10",
    "plan_day_id": "<uuid|null>", "plan_exercise_id": "<uuid|null>", "exercise_id": "<uuid>" }
  ```
  自加动作时 `plan_exercise_id` 为 `null`、`plan_day_id` 为那天的计划日。
- 写路径（`POST /conversations/:id/messages`）：接受 `exercise_ref`；方向强制同 029：只有学员本人能发；`plan_day_id` / `plan_exercise_id` 非空时必须属于这位学员的计划，否则 400。
- **正文首行**：服务端由 `exercise_ref` 重算预期首行并比对，格式 `[动作留言] {exercise_name} · {M/D}`（英文 `[Exercise note] {name} · {M/D}`，按 `X-MeetPR-Locale`），第二行起是学员原文。不一致 → 400 `VALIDATION_ERROR`，不落库改写。旧版教练 App 只认 `body`，因此能读懂。
- 读路径：消息列表、实时推送、会话预览照常带出 `exercise_ref`（旧客户端忽略未知字段）。推送文案沿用普通文字消息。

## 3. 同序预填建议接口

- `GET /students/:studentId/plan-days/:planDayId/weight-suggestions`，学员本人或已绑定教练可读。
- 对这一天里「处方强度为 RPE、且没写重量」的每个计划组，返回一条建议：
  ```json
  { "suggestions": [ { "plan_set_id": "<uuid>", "weight_kg": "102.5",
      "source_set_log_id": "<uuid>", "source_logged_date": "2026-11-03" } ] }
  ```
  找不到的组不返回。
- 匹配规则（全部满足，取 `logged_at` 最近的一条）：
  1. 同一学员、同一 `exercise_id`；
  2. 该记录 `completed = true`、`failed = false`、`assumed = false`、`adhoc = false`、`weight_kg IS NOT NULL`；
  3. 该记录的 `reps` 等于本组 `target_reps`，`rpe` 等于本组目标 RPE（数值相等）；
  4. **同序位**：该记录所属计划动作在它那一天里的位置（按 `sort_order` 排序后的第几个，1 起）等于本组所属计划动作在今天的位置；
  5. `logged_date` 早于今天（gym-day 口径，沿用现有）。
- 不跨学员、不看别的教练的计划以外的数据以外再加限制；跨计划（上一份计划）允许。

## 4. 不改的

- 完成今日训练、撤销、视频上传 / 送达、活动台账结算规则不变（只受第 1 节的空重量影响）。
- `assumed` 语义不变（仍只给导入历史用）。

## 验收清单

1. 迁移在 staging 应用后，存量 `set_logs` 行数与重量值不变；`weight_kg` 可写 `null`。
2. 带 `X-MeetPR-Caps: set-weight-nullable` 的请求读到 `null`；不带的读到 `"0"`；两种请求下学员历史、计划详情、教练学员详情、导出都不报错。
3. 有空重量组的学员，e1RM / PR 计算与之前一致（空重量组不计入），活动台账照常结算这一天。
4. 学员发 `exercise_ref` 消息：首行正确时 201；首行不符 400；教练发 400；同时带 `set_ref` 400；带 `video_id` 400；`plan_exercise_id` 不属于该学员 400。
5. 教练端拉消息列表能拿到 `exercise_ref`；不认识该字段的旧客户端照常显示正文。
6. 建议接口：构造「同动作 + 同 RPE + 同次数 + 同序位」「同动作但序位不同」「同序位但次数不同」三组历史，只有第一种被返回；最近的一条优先；失败组、导入组、自加组不被选中；非本人非绑定教练 403。
7. 部署 staging 后按台账规范登记迁移号与 sha。

## 测试 seam

- 迁移与兼容序列化：在现有 `set_logs` 读写 handler 测试里加「null 写入 / 带与不带 caps 头读取」两条，先红后绿；序列化函数单测覆盖全部接入点的样例行。
- 动作留言：沿用 029 `POST /conversations/:id/messages` 的 handler 测试文件，按验收 4 列用例。
- 建议接口：新 handler 测试，用 pg-mem 夹具构造验收 6 的三组历史。
- 产出一份契约样例 `specs/065-all-day-sheet/contract-samples.json`（组记录含空重量、`exercise_ref` 消息、建议接口响应），给两端 App 与网页做 fixture。

## Out of Scope

- 「学员确认过」状态字段、存量默认 RPE 数据回改。
- 动作留言附视频、教练对动作留言的专门回复类型。
- 休息计时相关任何后端改动。
- 网页端展示（见 025）、App 端展示（见 107）。
