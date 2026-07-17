# 020 — 显式开始训练 + 「被压」信号（驾驶舱 W1 三调 backend 侧）

- **状态**: InProgress
- **来源**: David 2026-07-17 晚拍板三调（CEO plan 2026-07-16 signal-loop 的 Amendment 3；口径四点已过目认可）。T2 / P1。
- **依赖**: spec 018/019 已合 staging。迁移号 **0043**（staging 头 0042，开工现场已核实）。
- **明确不做**: iOS UI（等设计稿另仓 spec）；今日 tab 划掉交互（已拍板取消，ack 端点保留备用不删）。

## 1. 迁移 0043 — CHECK 扩展

- `student_events.event_type` CHECK 增加 `set_failed`；`student_signals.signal_type` CHECK 增加 `weight_failed`（drop constraint + re-add，additive 语义）。
- `src/db/types.ts`：`STUDENT_EVENT_TYPES` / `SIGNAL_TYPES` 同步。
- 无新表无回填。

## 2. 显式开始训练

- **端点** `POST /students/me/session/start`（requireRole coached_student / self_train_student）：
  - 当日 gym-day（`shanghaiTrainingDay(now)`）无会话 → 建行：`status='in_progress'`，`started_at = last_set_at = now`，`plan_day_ids=[]`，201 返回与 `GET /students/me/session` 同 shape 的 session。
  - 已有会话（任何状态）→ 200 返回现状，**不重置**（completed 终态不动；幂等重点）。
  - 并发安全：沿用 seed-then-lock（ON CONFLICT DO NOTHING + FOR UPDATE 读回）。
- **语义**：`started_at` 锚点 = 按钮点击；时长 = 按钮 → 最后一组（热身计入）。**首组隐式开始保留为回退**（老客户端无按钮；`recordSetLogActivity` 的单调合并天然兼容——按钮时刻更早即胜出，零行为改动）。
- **零组会话**〔David 过目认可〕：`sweepTimedOutSessions` 中 `in_progress` 且该 session_date **无任何非 assumed set_log** 且距 `last_set_at` 超时 → **DELETE 行，不产生任何事实事件**（点了开始没练=没练；缺练判定按 set_logs 判开练，不受影响）。现行 sweep 对零组会话会误归 `completed`（plan_day_ids 空分支），本条同时是 bugfix。

## 3. 「被压」信号（黄档首个生产者）〔四口径 David 过目认可〕

- **触发**：set-log 写入钩子（对齐 pr-detection 模式：会话事务提交后**独立事务**，事件+信号原子，失败不回滚会话账），条件 = `failed=true` 且 `plan_exercise_id NOT NULL` 且该 plan_exercise `is_main_lift=true`。辅项/adhoc 不触发（噪声控制，后议）。`assumed` 不触发。
- **事实事件** `set_failed`：每 failed 组一条（记录即真），`dedup_key = "fail:{studentId}:{setLogId}"`（upsert 重放不双计），payload `{ set_log_id, exercise_id, weight_kg, reps, set_index, logged_date }`，coach 归因复用 plan-coach 优先/bond 回退。
- **派生信号** `weight_failed`（severity **yellow**，status open）：同学员同教练**同 gym-day 合一条**——当日已有 open 且 payload.gym_day 相同 → 更新（最新一组入 reason + `failed_count`++），否则走 LOCK CONTRACT（users 行锁）select-then-update/insert。reason 人话如「卧推 120kg 未完成（第 3 组）」。`expires_at` = opened_at + `SIGNAL_POLICY.signalExpiryDays`。
- **离场**（无划掉后的关键）：每日结算（`runDailySettlement`，逐学员事务内）——该生昨 gym-day 存在 `session_completed` 事实事件 → 该师徒对全部 open `weight_failed`（`opened_at` 早于该日关账）置 `auto_resolved`。否则 7 天过期兜底。
- **每日摘要**：digest 增第三段「{n} 被压」= 昨 gym-day 有 ≥1 条 `set_failed` 事件的**学员数**（distinct，与缺练同口径），文案顺序：`昨天：{n} 练完 · {n} 部分完成 · {n} 缺练 · {n} 被压 · {n} 破 PR`，零值段省略规则不变。

## 4. 测试

- 0043 CHECK 双向断言；start 端点幂等/终态不重置/并发 seed/角色/序列化双态。
- 零组会话：超时删除且零事件；有组会话不受影响（回归）；按钮后打卡 started_at 保持按钮时刻（单调合并回归）。
- 被压：主项 failed 触发/辅项 adhoc assumed 不触发/重放幂等/同日合条 failed_count/次日完成会话 auto-resolve/7 天过期/digest 计数与文案段。

## 5. 拆卡

| #   | 卡                                           | 范围    |
| --- | -------------------------------------------- | ------- |
| 1   | 迁移 0043 + start 端点 + 零组会话 sweep 修正 | §1 + §2 |
| 2   | 被压检测钩子 + 结算离场 + digest 段          | §3      |

## 变更记录

| 日期       | 版本 | 说明                                          | 作者   |
| ---------- | ---- | --------------------------------------------- | ------ |
| 2026-07-17 | 0.1  | 初稿（W1 三调 backend 侧，口径 David 已过目） | Claude |
