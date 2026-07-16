# 019 — 推送管线（push pipeline，驾驶舱信号环 W1 backend 侧）

- **状态**: InProgress
- **来源**: CEO plan `~/.gstack/projects/meetpr/ceo-plans/2026-07-16-coach-cockpit-signal-loop.md` W1（David 2026-07-16 拍板：推送管线从零建，W1 最大件）。T2 / P1。
- **依赖**: spec 018（PR #73）合并部署后方可实装——账本表与 cron 基建是本 spec 的地基。**迁移号暂定 0042，开工时三源现场核实。**
- **手动前置**: Apple APNs auth key（.p8 + Key ID + Team ID）——David 手动步，凭证只存 Bitwarden，SAE 环境变量部署时注入。
- **明确不做**: iOS UI（另仓 spec）、学员侧任何新推送（W2 计划变更通知除外，不在本 spec）、per-event push（红线 #4：教练侧每日聚合一条封顶）。

## 1. 数据模型（迁移 0042）

`device_tokens`：

| 列                                     | 类型                          | 说明                     |
| -------------------------------------- | ----------------------------- | ------------------------ |
| id                                     | UUID PK                       |                          |
| user_id                                | UUID NOT NULL → users CASCADE |                          |
| token                                  | TEXT NOT NULL UNIQUE          | APNs device token（hex） |
| platform                               | TEXT NOT NULL CHECK (`ios`)   | 前瞻留字段               |
| created_at / updated_at / last_seen_at | TIMESTAMPTZ                   |                          |

- 同一设备换账号登录：`ON CONFLICT (token) DO UPDATE SET user_id, last_seen_at`（token 归属随登录迁移）。
- 索引 `(user_id)`。纯 additive，不碰既有表。

## 2. 端点

- `POST /devices/token`（requireAuth，全角色）：`{ token, platform: 'ios' }` → 201 `{ id }`；upsert 语义如上；zod 校验 token hex 格式。登出端点 v1 不做删除（token 失效由 APNs 410 反馈回收，见 §4）。

## 3. 每日聚合 job（复用 spec 018 cron 基建）

- 触发：`PUSH_POLICY.dailyDigestCron = '0 8 * * *'` Asia/Shanghai（常量可调，与 gym-day 同锚沪时区）。
- 对象：有 accepted bond 的教练；**Demo/DemoStudent 账号硬禁用**（对齐埋点先例的账号识别机制，实装时现场核对该先例落点）。
- 聚合昨 gym-day（既然 04:00 关账，08:00 时账本已收完）：
  - 练完 = `session_completed` 事件数（`session_date = 昨`，按 coach_id 归属）；
  - 部分完成 = `session_partial` 事件数，**排除同学生同日已补 completed 的**（dedup_key 前缀去重，spec 018 §8 口径）；
  - 缺练 = open `missed_training` 信号中 `payload.missed_dates` 含昨日的学员数；
  - 破 PR = `pr_e1rm` 事件数（`session_date = 昨`）。
- 文案（David 可在 review 时改）：`昨天：{n} 练完 · {n} 部分完成 · {n} 缺练 · {n} 破 PR`，**零值段省略**；四段全零 = **不发**（零事件日不发，已拍板）。
- 写 `notification_outbox`（0036 现成表）：`event_type='coach_daily_digest'`，`aggregate_id` = (coach_id, gym_day) 派生的确定性 UUID（UNIQUE 约束天然挡重发，job 幂等可重跑），`recipient_id` = coach_id，payload = 文案 + 计数明细。**每教练一天一条封顶。**

## 4. APNs 客户端 + outbox 消费 worker

- **零新依赖**：Node 22 原生 `node:http2` + 既有 `jsonwebtoken`（支持 ES256）签 p8 JWT。连接 `api.push.apple.com` / `api.sandbox.push.apple.com`（按 `APNS_ENV`）。
- env（zod，`.env.example` 同步）：`PUSH_ENABLED`（**默认 `false`，legacy-safe**——没配 key 的部署零影响）、`APNS_KEY`（p8 PEM 内容）、`APNS_KEY_ID`、`APNS_TEAM_ID`、`APNS_BUNDLE_ID`、`APNS_ENV`（sandbox|production）。`PUSH_ENABLED=true` 时启动校验五项齐全，缺失即 fail-fast。
- 消费 worker（cron 每分钟，`PUSH_ENABLED` 闸门）：取 `status='pending'` 的 outbox 行（`created_at` 升序，批量上限常量）→ 查 recipient 的 device_tokens → 逐 token 发 → 全部成功置 `delivered`；失败 `attempt_count++` + `last_error`，超 `maxAttempts`（默认 5，常量）置 `failed`；APNs 410/`BadDeviceToken` 回收删除该 token 行。多实例并发安全：行级 `FOR UPDATE SKIP LOCKED`。
- 既有 `notifyPlanPublished` stub 与其 outbox 行（`event_type='plan_published'`）**本期不接**：worker 只消费 `coach_daily_digest` 类型，白名单外的行不动（避免顺手激活未设计的学员推送——W2 再议）。

## 5. 阈值治理

`src/domain/push-policy.ts`：`PUSH_POLICY = { dailyDigestCron: '0 8 * * *', consumerCron: '* * * * *', consumerBatchSize: 50, maxAttempts: 5 } as const`，对齐 SIGNAL_POLICY 先例。

## 6. 测试

- 迁移 0042 DDL + token upsert 归属迁移；端点 supertest（角色/校验/幂等）。
- 聚合组装纯函数：四段计数口径（partial 去重）、零段省略、全零不发、Demo 排除。
- worker：幂等重跑、重试计数、410 回收 token、白名单外事件不动；APNs 网络层 mock（网络边界 mock 惯例）。
- sandbox 实测（卡 4，需 push key + 真机/模拟器 token）。

## 7. 拆卡

| #   | 卡                         | 范围                                      |
| --- | -------------------------- | ----------------------------------------- |
| 1   | 迁移 0042 + token 注册端点 | §1 + §2                                   |
| 2   | APNs 客户端 + 消费 worker  | §4 + §5                                   |
| 3   | 每日聚合 job               | §3                                        |
| 4   | e2e + sandbox 实测         | §6 尾项（前置：push key + PR #73 已部署） |

## 变更记录

| 日期       | 版本 | 说明                                              | 作者   |
| ---------- | ---- | ------------------------------------------------- | ------ |
| 2026-07-17 | 0.1  | 初稿（W1 backend 侧；iOS UI 等设计稿另仓开 spec） | Claude |
