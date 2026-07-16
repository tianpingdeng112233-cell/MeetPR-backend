# 018 — 学员动态账本（student activity ledger，驾驶舱信号环 W0）

- **状态**: Draft
- **来源**: CEO plan `~/.gstack/projects/meetpr/ceo-plans/2026-07-16-coach-cockpit-signal-loop.md`（W0，David 2026-07-16 全拍板）。T2 / P1。
- **权威口径**: 分类学与红线全文沿用 CEO plan；PR 口径 = iOS spec 050（`050-e1rm-single-source`）；gym-day 04:00 截断 = backend spec 017。
- **迁移**: `0041-init-activity-ledger.sql`（0039 归 PR #59 缺号，永不复用）。
- **明确不做（W1+）**: 推送发送、outbox 消费 worker、APNs、iOS UI、web 看板接入。本 spec 只保证 W1 能一条查询读出「昨天 X 练完 · Y 缺练 · Z 破 PR」。

## 0. 分类学（全文用词）

- **事实事件**（记录即真、零误报、append-only、无生命周期）：`session_completed` / `session_partial` / `pr_e1rm`。只进账本，不占信号配额。
- **派生信号**（推断、会误报、有生命周期）：W0 第一批仅 `missed_training`（红）。`pr_congrats`（绿）是喜报行：进待办、自动过期、不需 ack（ack 端点对它生效但不要求，供 W1「划掉」复用）。
- 数据源 = 业务表（set_logs / plans / plan_day_shifts / bind_requests / evaluation_periods），**严禁**读 0029 埋点 `events` 表。

## 1. 数据模型（迁移 0041 + `src/db/types.ts` 手工增补）

### 1.1 `training_sessions` — 训练会话三态，计时正典

| 列                      | 类型                                                         | 说明                                   |
| ----------------------- | ------------------------------------------------------------ | -------------------------------------- |
| id                      | UUID PK `gen_random_uuid()`                                  |                                        |
| student_id              | UUID NOT NULL → users ON DELETE CASCADE                      |                                        |
| session_date            | DATE NOT NULL                                                | gym-day 口径（= set_logs.logged_date） |
| status                  | TEXT NOT NULL CHECK in (`in_progress`,`completed`,`partial`) |                                        |
| started_at              | TIMESTAMPTZ NOT NULL                                         | 窗口内第一组 logged_at                 |
| last_set_at             | TIMESTAMPTZ NOT NULL                                         | 窗口内最后一组 logged_at               |
| completed_at            | TIMESTAMPTZ NULL                                             | 置 completed 时刻                      |
| plan_day_ids            | UUID[] NOT NULL DEFAULT '{}'                                 | 本会话触达的 plan_day（完成判定输入）  |
| created_at / updated_at | TIMESTAMPTZ                                                  |                                        |

- `UNIQUE(student_id, session_date)`；索引 `(student_id, session_date DESC)`。
- **计时窗口**：只统计 `logged_at ∈ [session_date 04:00, 次日 04:00)`（Asia/Shanghai）的组；窗口外补录/编辑不动计时（防 upsert 把 `logged_at` 刷成 now 后污染历史时长）。时长 = `last_set_at - started_at`；partial 按最后一组提交时刻，不按归档时刻。
- **状态机**：首组 → `in_progress`；触达的 plan_day 全部 plan_sets 都有该生该日 set_log（completed 或 failed 均算已交）→ `completed`（终态，不回退）；`in_progress` 且距 `last_set_at` 超 4h → sweep 归档 `partial`；`partial` 后同 gym-day 再来新组 → 重开重算（可直达 completed）。
- **纯 adhoc / 无计划会话**（plan_day_ids 空）：照常计时；无完成判定，超时归档为 `completed`（不产生"部分完成"语义；对信号零影响——无计划本就豁免缺练）。〔David 2026-07-16 过目认可〕
- **回填**：0041 内 INSERT…SELECT 从存量 set_logs 派生（按 student+logged_date 聚合，`assumed=true` 的 imported-history 行排除；完成判定按上述规则一次性算出，算不出完成的落 partial）。幂等（`ON CONFLICT DO NOTHING`）。

### 1.2 `student_events` — 事实事件账本（append-only）

| 列           | 类型                                                                     | 说明                                       |
| ------------ | ------------------------------------------------------------------------ | ------------------------------------------ |
| id           | UUID PK                                                                  |                                            |
| student_id   | UUID NOT NULL → users CASCADE                                            |                                            |
| coach_id     | UUID NULL → users SET NULL                                               | 归因（多教练具名刚需）；无绑定教练则 NULL  |
| event_type   | TEXT NOT NULL CHECK in (`session_completed`,`session_partial`,`pr_e1rm`) |                                            |
| session_date | DATE NOT NULL                                                            | gym-day                                    |
| occurred_at  | TIMESTAMPTZ NOT NULL                                                     |                                            |
| payload      | JSONB NOT NULL DEFAULT '{}'                                              | 见 §1.4；助理层 V2+ 扩展只进这里，不预设列 |
| dedup_key    | TEXT NOT NULL                                                            | 幂等键，见下                               |
| created_at   | TIMESTAMPTZ                                                              |                                            |

- `UNIQUE(dedup_key)`：`session_completed`/`session_partial` = `"{type}:{student}:{date}"`（一会话一终局事件；partial 重开后达成 completed，补写 completed 事件，partial 事件保留——账本 append-only 不删账）；`pr_e1rm` = `"pr:{student}:{family}:{set_log_id}"`（同组 upsert 重放不双计）。
- 索引 `(coach_id, session_date DESC)`（W1 每日聚合查询主路径）、`(student_id, occurred_at DESC)`（学员时间线）。

### 1.3 `student_signals` — 派生信号 + 喜报行（一条一行，可查可修）

| 列                                  | 类型                                                              | 说明                                                                 |
| ----------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| id                                  | UUID PK                                                           |                                                                      |
| student_id / coach_id               | UUID NOT NULL → users CASCADE                                     | 信号必有归属教练                                                     |
| signal_type                         | TEXT NOT NULL CHECK in (`missed_training`,`pr_congrats`)          |                                                                      |
| severity                            | TEXT NOT NULL CHECK in (`red`,`yellow`,`green`)                   | yellow W0 无生产者，enum 先留                                        |
| status                              | TEXT NOT NULL CHECK in (`open`,`acked`,`auto_resolved`,`expired`) |                                                                      |
| reason                              | TEXT NOT NULL                                                     | **留因人话**（红线 #5），如「周一至周三无打卡（已连续 3 个训练日）」 |
| payload                             | JSONB NOT NULL DEFAULT '{}'                                       | 判定证据（日期列表 / e1RM 值等），申诉可查                           |
| opened_at                           | TIMESTAMPTZ NOT NULL                                              |                                                                      |
| acked_at / resolved_at / expires_at | TIMESTAMPTZ NULL                                                  | expires_at = opened_at + 7d（常量）                                  |
| created_at / updated_at             | TIMESTAMPTZ                                                       |                                                                      |

- 部分唯一索引 `(student_id, coach_id, signal_type) WHERE status='open'`：同类信号同师徒对最多一条 open——连续缺练天数增长时**更新**该行 reason/payload，不逐日刷屏。
- 索引 `(coach_id, status, opened_at DESC)`（驾驶舱信号流主查询）。

### 1.4 payload 形状（W1 合同，zod 校验后写入）

- `pr_e1rm`: `{ set_log_id, exercise_id, family, e1rm, previous_best, logged_date }`
- `session_completed/partial`: `{ session_id, plan_day_ids, duration_seconds, sets_logged }`
- `missed_training`: `{ missed_dates: [YYYY-MM-DD...], consecutive_count, plan_id }`

## 2. 事件时钩子（set-log 旁路）

挂载点：`src/routes/sets.ts` 两个形态 handler 写入成功后、响应前，同请求内调用 `recordSetLogActivity(db, …)`（新模块 `src/handlers/activity-ledger.ts`）。

- **旁路纪律**：钩子整体 try/catch，失败只 `logger.warn`，**绝不**改变打卡响应的状态码与 shape（活客户端兼容，硬规则 #8）；adhoc 写入路径保持既有非事务设计，钩子不强行包事务——幂等（dedup_key + 会话全量重算）保证可重放。
- 钩子做三件事：会话状态机推进（§1.1）、会话终局事实事件（§1.2）、PR 检测（§3）。
- `assumed=true`（imported history）的写入**不**触发钩子。

## 3. PR 检测（口径 = iOS spec 050，红线 #3 逐项对齐）

- **入选门**：复用 `calculateEligibleE1RM`（`src/domain/e1rm.ts`，纯函数）——RPE<7 拒、rep>10 拒（硬拉 rep>5 拒）、failed/未完成拒、`e1rm_confidence='low'` 拒（分级由客户端落库，backend 不重算 jump）。
- **family 解析**：复用 `resolveCompetitionFamily`（exercise competition stance × onboarding stance/style，同 exercise-stats 取数路径）；family 为 null 不判 PR。
- **基线**：该生该 family 此前 **28 天滚动窗**内合规组 e1RM 最大值（`E1RM_POLICY.rollingWindowDays`；低置信/assumed 排除）。
- **PR 条件**：新组 e1RM > 基线 **且** 超出 `max(0.5kg, 基线 × E1RM_POLICY.prNoiseRatio)` 噪声带（spec 050 §3）。窗口内无基线（新学员/久别）→ 首个合规组不判 PR，只立基线。
- 命中 → `pr_e1rm` 事实事件 + `pr_congrats` 绿信号（同师徒对已有 open 喜报则更新 payload 取更高值）。**PR 撤销 v1 不处理**（已拍板）：事后编辑/删除导致回收，账本条目不动。

## 4. 缺练判定（红线 #2 边界清单，逐条为准）

纯函数 `judgeMissedTraining(inputs)`（`src/domain/missed-training.ts`），每日收账 job 对每个「有 accepted bond 的 coached 学员」执行：

1. **仅**「有 status='published' 计划且当日为训练日」的学员参与判定；无在挂 published 计划 → 豁免。
2. 训练日 = `plans.start_date` + week/day 推算，**再套 plan_day_shifts 最新 batch 顺延覆盖**（spec 054/0037/0038 口径）。现 `plannedDate()` 不认顺延——本 spec 将 `src/routes/plans/index.ts` 的生效日期计算（`latestShiftByDay` 一族）抽为共享纯函数 `src/domain/plan-calendar.ts`，plans 路由与本判定共用，**plans 路由零行为变化**。
3. 日界线 = gym-day 04:00（复用 `shanghaiTrainingDay`）；判定跑在当日 gym-day 关账后，严禁 UTC/设备本地/沪三口径混用。
4. 休息日（该日历日无 plan_day）不计入连续；deload 周照 plan_day 有无判，无则同休息日。
5. 评估期豁免：`evaluation_periods` 存在 `completed_at IS NULL` 的行即豁免（含已过 `expected_end_at` 的 lazy-overdue 行——与读时口径一致，宁可少报不误报）。
6. 「开练」= 该 gym-day 有 ≥1 组 set_log（含 adhoc、含 failed；`assumed` 除外）——练了一半不算缺练。
7. 连续 ≥ N 个训练日未开练（N = `SIGNAL_POLICY.missedDaysThreshold` 默认 3）→ 开/更新红色 `missed_training` 信号，reason 写人话 + payload 存证据日期。
8. **auto-resolve**：已 open 的缺练信号，学员任一 gym-day 重新开练 → `auto_resolved`（每日 job 顺带判，事件钩子不管）。

## 5. 调度基建（仓库 cron 首例）

- `node-cron`（新依赖），`src/jobs/scheduler.ts`，`server.ts` 启动时挂载，env `SIGNALS_CRON_ENABLED`（默认 `true`，事故时可关）。
- **每日收账 job**（`05 4 * * *` Asia/Shanghai，gym-day 关账后）：对昨 gym-day 跑缺练判定（§4）+ auto-resolve + 信号过期（open 超 `signalExpiryDays`=7 天 → `expired`）。
- **会话超时 sweep**（每 15 分钟）：`in_progress` 且距 `last_set_at` > 4h → 归档（§1.1），写 `session_partial`/`session_completed` 事实事件。
- 所有 job 幂等（重跑安全：dedup_key + open 唯一索引 + 状态机终态保护）；SAE 多实例并发跑安全（同一约束兜底）。导出 `runDailySettlement(db, date)` / `runSessionSweep(db, now)` 纯编排函数供手动兜底与测试，cron 只是薄接线。

## 6. API（W1 合同；全走 `requireAuth` + 既有错误信封）

| 端点                                              | 角色                                 | 语义                                                                                                                                                                                                         |
| ------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /coach/signals?status=open`                  | coach                                | 花名册信号流：本教练全部信号，按 severity（red<yellow<green）+ opened_at 排序；返回 `{ signals: [{ id, student_id, student_name, signal_type, severity, status, reason, payload, opened_at, expires_at }] }` |
| `POST /coach/signals/:id/ack`                     | coach                                | open → acked；非本教练 404 `SIGNAL_NOT_FOUND`；重复 ack / 非 open 态 409 `SIGNAL_NOT_OPEN`                                                                                                                   |
| `GET /coach/students/:studentId/events?from=&to=` | coach                                | 学员事实事件时间线（hasAcceptedBond 守门，403）；默认近 28 天                                                                                                                                                |
| `GET /students/me/session?date=`                  | coached_student / self_train_student | 当日（缺省 = 当前 gym-day）会话：`{ session: { status, started_at, last_set_at, completed_at, duration_seconds } \| null }`——W1 学员端计时卡数据源                                                           |

DATE/时间戳序列化走既有 `normalizeDateOnly`/`timestamp` helper（pg-mem/prod 双态兼容）。

## 7. 阈值治理

`src/domain/signal-policy.ts`：

```ts
export const SIGNAL_POLICY = {
  missedDaysThreshold: 3, // 连续缺练 N（CEO plan 默认 3，可调）
  signalExpiryDays: 7, // open 信号过期
  sessionTimeoutHours: 4, // 会话超时归档
  dailySettlementCron: '5 4 * * *', // Asia/Shanghai
} as const;
```

对齐 `E1RM_POLICY` / plan-web `ROSTER_TRIAGE` 先例：集中、`as const`、不散落硬编码。

## 8. 已知取舍

- 缺练判定日批跑（非实时）：信号最迟延一天出现，换判定窗口完整（关账后判，零半天误报）。
- 部分完成会话后同日补完 → completed 事件与 partial 事件并存（append-only 不删账）；W1 聚合口径「练完计 completed、部分完成单独计数」按 dedup_key 前缀天然可去重。
- Demo/DemoStudent 账号 W0 不特殊处理（信号照常生成，反而利于演示）；红线 #4 的硬禁用作用于 W1 推送层。
- in-process cron 在 SAE 多实例下会并发跑：以幂等性兜底而非分布式锁——W0 体量（单实例）下够用，多实例扩容时再议锁。
- `softJumpRatio`/`hardJumpRatio` 分级留在客户端（spec 050 §5 原设计），backend 只消费落库的 `e1rm_confidence`。

## 9. 测试

- 迁移：`tests/migrations/0041-init-activity-ledger.test.ts`——DDL 断言 + 回填正确性（含 assumed 排除、完成/partial 派生）。
- 会话状态机：upsert 重放不双计、跨 04:00 边界、coached/adhoc 混合、最后一组判齐、窗口外编辑不动计时、partial 重开。
- PR：口径逐项（RPE<7 / 低置信 / rep 上限 / 28 天窗 / 噪声带内外 / 无基线首组不判 / 重放幂等）。
- 缺练：**红线 #2 每条边界至少一个用例**（含顺延后日历、评估期豁免、休息日、无计划豁免、开练≥1 组豁免、N 边界）；`plan-calendar` 抽取前后 plans 路由既有测试全绿。
- API：supertest 全端点含越权（403/404）、重复 ack（409）、序列化双态。
- Jobs：`runDailySettlement`/`runSessionSweep` 重跑幂等。

## 10. 拆卡（Codex，一卡一原子 commit，依赖 1→2/3→4→5）

| #   | 卡                                | 范围                                 |
| --- | --------------------------------- | ------------------------------------ |
| 1   | 迁移 0041 + types + SIGNAL_POLICY | §1 全部 + §7                         |
| 2   | 会话状态机钩子                    | §2 挂载 + §1.1 状态机 + 会话事实事件 |
| 3   | PR 检测钩子                       | §3                                   |
| 4   | 缺练判定 + cron 首例              | §4（含 plan-calendar 抽取）+ §5      |
| 5   | 读 + ack API                      | §6                                   |

## 变更记录

| 日期       | 版本 | 说明                                                                                                           | 作者   |
| ---------- | ---- | -------------------------------------------------------------------------------------------------------------- | ------ |
| 2026-07-16 | 0.1  | 初稿（CEO plan W0 全量落地合同；两个边界口径 David 过目认可：无计划会话归档为 completed、喜报行可 ack 不强求） | Claude |
