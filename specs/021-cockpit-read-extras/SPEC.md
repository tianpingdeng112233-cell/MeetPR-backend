# 021 — 驾驶舱读扩展（digest 读端点 + 花名册补字段）

- **状态**: InProgress
- **来源**: iOS spec 057 §1/§5 的数据依赖（W1 发现层）。T1 / P1。零迁移。
- **依赖**: spec 019 已合 staging（复用 daily-digest 聚合函数）。

## 1. `GET /coach/daily-digest`

- requireRole('coach')。`?date=` 缺省 = 昨 gym-day（`justClosedGymDay(now)` 同源）。
- 响应 `{ gym_day, counts: { session_completed, session_partial, missed_training, weight_failed, pr_e1rm }, body: string | null }`——**抽取并复用** `runDailyDigest` 的单教练聚合与文案函数（重构为共享纯函数，job 与端点同源，口径永不分叉），不写 outbox、纯读。
- 全零 counts 时 body=null（iOS 隐藏摘要条）。

## 2. `/coach/students` 补两字段（additive，响应 shape 只增不改）

- `competition_date`：来自 `onboarding_profiles.competition_date`（可 null）。
- `recent_4w`：近 4 个完整周（周一起算，与 exercise-stats overview `recent_4w` 同口径复用其逻辑，抽共享而非复制）每周 `{ trained_days, planned_days }` 数组（长度恒 4，旧→新）。**单批量查询**（roster 全员一次算齐，禁逐学员 N+1——参照 spec 016 has_logs 聚合先例）。

## 2.5 会话响应补 `gym_day`（附带，iOS 跨日守卫需要）

- `GET /students/me/session`（含 session=null 时）与 `POST /students/me/session/start` 响应顶层补 `gym_day`（服务端解析出的当日 gym-day）。additive；客户端以此做本地态跨日失效判断，**不得**在客户端计算「今天」——04:00 口径唯一实现在服务端。

## 3. 测试

- digest 端点：口径与 job 完全一致（同 fixture 双跑对比）、date 参数校验、零值 body null、越权 403。
- roster 字段：null 比赛日期、4 周窗边界（跨顺延日历——planned_days 用 plan-calendar 共享 helper）、批量查询正确性、既有 roster 测试零回归。

## 4. 拆卡

单卡（§1+§2+§3）。

## 变更记录

| 日期       | 版本 | 说明 | 作者   |
| ---------- | ---- | ---- | ------ |
| 2026-07-18 | 0.1  | 初稿 | Claude |
