# 008 — analytics events 摄入端点 + events 表（first-party 行为观测）

- **状态**: Draft
- **来源**: 埋点 / 行为观测 wave（`~/Brain/wiki/projects/MeetPR/analytics-instrumentation-wave.md`），CEO review 锁定方案 B / SELECTIVE_EXPANSION（`~/Brain/wiki/projects/MeetPR/reviews/analytics-instrumentation-ceo-review.md`，2026-06-24）；内测在即，目标 = ① 卡点定位 + ② 功能取舍，靠**逐条读 per-user 故事线**（n<50 时比聚合漏斗更值）。
- **批准语境**: 内测前埋点 wave（David 2026-06-24 拍板 4 分叉 + 18 项工程 auto-decided + 5 CRITICAL）。本 spec **先行**，iOS spec 043 依赖它落地后才能开埋。

> ⚠️ **这是一张可替换的种子表，不是 PD-007 web 宏观分析平面。** `events` 是内测期"读懂用户"的最小观测层，不是数仓。**不要镀金**：不做维度表 / event-sourcing / Kafka / 物化漏斗。`schema_version` + `name` enum allowlist 留前向兼容，到此为止。

## 范围

### 1. migration `NNNN-init-events.sql`

> ⚠️ **迁移号是占位符，起跑时现取。** 本 spec 起草时（2026-06-24）写作 `0019`/`0020`，但**那两号已被导入 wave 占用并合入 `staging`**（`0019-sync-plan-coverage-exercises.sql` / `0020-relax-plan-weeks.sql`）。实装起跑时按 **CLAUDE.md Hard rule 2** 现取两个连续号 —— 下文记为 `NNNN`（events 表迁移号）与 `NNNN+1`（紧随的 feedback 表迁移号）—— 并同步替换本 spec 全部 `NNNN`/`NNNN+1` 引用、迁移文件名、文件头 `-- Migration NNNN:` 注释与配套测试文件名。

仓库**无 migration runner**（手 psql 应用，见 CLAUDE.md Hard rule 2）。文件落 `db/migrations/NNNN-init-events.sql`，BEGIN/COMMIT 包裹，镜像 0014/0015 文件头注释风格。**字面 SQL**：

```sql
-- Migration NNNN: first-party analytics events (behavioral observation layer).
-- One wide table + JSONB props. event_id is a client-generated uuid, UNIQUE on
-- the server so an at-least-once retry (lost 204 ack / killed flush) dedups to
-- exactly-once storage via ON CONFLICT(event_id) DO NOTHING. user_id is
-- SERVER-derived from the JWT (never trusted from the client body) and NULL for
-- pre-login events; ON DELETE SET NULL preserves the timeline shape after a user
-- deletion (the repo default CASCADE would erase history — do NOT use it here).
-- name is validated against a zod enum allowlist in the route (the real gate);
-- the column is plain text for forward-compat. props are ids/enums only — never
-- free text. ts_client is the untrusted device clock; reads tie-break on
-- (ts_client, ts_server, seq). Retention: 90d (documented; see SPEC §7).
-- Spec: specs/008-analytics-events/SPEC.md

BEGIN;

CREATE TABLE events (
  id             BIGSERIAL PRIMARY KEY,
  event_id       UUID NOT NULL UNIQUE,
  anon_id        UUID NOT NULL,
  user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  role           TEXT,
  session_id     UUID NOT NULL,
  seq            INT NOT NULL,
  name           TEXT NOT NULL,
  props          JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version SMALLINT NOT NULL DEFAULT 1,
  app_version    TEXT,
  build          TEXT,
  platform       TEXT NOT NULL DEFAULT 'ios',
  ts_client      TIMESTAMPTZ NOT NULL,
  ts_server      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- per-user story timeline (the core "感受" read), ordered by client clock.
CREATE INDEX events_user_ts_idx     ON events (user_id, ts_client);
-- one session as one story.
CREATE INDEX events_session_idx     ON events (session_id);
-- "功能使用排行榜" / funnel-by-event slices on server clock.
CREATE INDEX events_name_server_idx ON events (name, ts_server);
-- retention sweep + daily sanity window.
CREATE INDEX events_server_ts_idx   ON events (ts_server);

COMMIT;
```

`event_id` 的 `UNIQUE` 自带索引（不另建）。`props` JSONB 沿用 readiness（0014）的 jsonb 先例：插入时传 JSON 字符串，node-pg 读回已解析、pg-mem 可能回字符串 → 序列化层归一。

### 2. `createOptionalAuth` 中间件（CRITICAL #4）

新增到 `src/middleware/auth.ts`，与 `createRequireAuth` 并列、复用同一 `AccessTokenPayloadSchema`。语义差异：

- 无 `Authorization` header / 非 `Bearer ` 前缀 / 空 token / `jwt.verify` 抛错 / payload 不过 zod → **不返回 401**，**不设置 `req.user`**（若已存在则 `delete req.user`），`next()` 继续。
- token 有效 → `req.user = { id: sub, role }`，同 requireAuth。

> **TS 真 gate（CRITICAL #4 编码细节）**：`src/types/express.d.ts` 是 `user?: { id; role }`，且 `tsconfig.json` 开了 `exactOptionalPropertyTypes: true`——**不能** `req.user = undefined`（类型不过）。未登录路径**留 `req.user` 不设**（或 `delete req.user`），不要赋 `undefined`。

**永不 401**。这是救 pre-login onboarding 漏斗的唯一原因：无 token 的 `onboarding_step` 事件若被 `requireAuth` 拦成 401，整条注册前漏斗静默丢失。

### 3. `POST /events` 摄入端点

挂载点：`/events` 用 `createOptionalAuth`（**不是** `deps.requireAuth`），不属于现有 `/students`-requireAuth 簇。在 `mountRoutes`（`src/routes/index.ts`）里单独一行：

```ts
app.use(
  '/events',
  createOptionalAuth(deps.config),
  eventsRouter({ db: deps.db, logger: deps.logger, config: deps.config }),
);
```

`createOptionalAuth` 由 `createApp` 注入到 `RouteDeps`（镜像现有 `requireAuth: createRequireAuth(config)` 注入路径），或在 `eventsRouter` 内自挂——按现有 `requireAuth` 经 `AppDeps` 流过来的模式，加 `optionalAuth: createOptionalAuth(config)` 到 `mountRoutes` deps。

请求 body：

**信封形态（CRITICAL #3 修正）**：`anon_id` / `app_version` / `build` / `platform` 一批一致（同一安装、同一构建），**提到 batch 顶层**；只有 `event_id` / `session_id`（可跨 session 轮换）/ `seq` / `name` / `props` / `schema_version` / `ts_client` 留 per-event。这样 rate-limiter 的 `keyGenerator` 能稳定读 `req.body.anon_id`（pre-login 也有），不退化到 IP。

```json
{
  "anon_id": "…uuid…",
  "app_version": "0.1.0",
  "build": "42",
  "platform": "ios",
  "events": [
    {
      "event_id": "…uuid…",
      "session_id": "…uuid…",
      "seq": 0,
      "name": "set_logged",
      "props": {
        "exercise_id": "…uuid…",
        "set_index": 2,
        "has_video": true,
        "outcome": "completed"
      },
      "schema_version": 1,
      "ts_client": "2026-06-24T19:03:11.000Z"
    }
  ]
}
```

行为（按序，全部 **await-insert-then-respond**，CRITICAL #1）：

1. **batch cap**：`events` 数组 1–50（空数组 400）。超 50 → 400 `EVENTS_BATCH_TOO_LARGE`。客户端侧约定每 POST ≤50（远低于 `express.json` 1mb 限）。
2. **413 契约**（需改 errorHandler）：body >1mb 由 `express.json({ limit: '1mb' })` 抛 `PayloadTooLargeError`，但现 `src/middleware/errorHandler.ts` **无条件返回 500**——所以 413 契约现在是**假的**。本 spec 要求改 `createErrorHandler`：当 `err.statusCode`/`err.status` 为已知 body-parser 错误码（`PayloadTooLargeError` → 413）时**透传该状态码**，而非一律 500（其它未知错误仍 500）。改完客户端收 413 才会**拆批重发**（不 wedge 队列）。iOS 043 消费此契约。
3. **per-event zod 判别联合**（CRITICAL：不信客户端 + 禁自由文本）：按 `name` 做 `z.discriminatedUnion('name', …)`，每个 variant 的 `props` 是 `.strict()`，**只准 id（uuid）/ int / bool / enum 白名单值**——任何 free-text / 实测重量 / 用户输入值一律拒。`name` 不在 enum allowlist → 该条无效。事件信封字段（`event_id`/`anon_id`/`session_id` uuid、`seq` int≥0、`ts_client` ISO8601、`schema_version`/`app_version`/`build`/`platform` 受限）单独校验。
4. **server-derive + strip**（CRITICAL #4，**顺序钉死**）：**先剥离**每个 event 对象里的 `user_id` / `role`（若客户端塞了），**再**跑 step 3 的 per-event `.strict()` 校验——否则 `.strict()` 先跑会把带伪造 `user_id` 的事件直接 4xx/skip 掉（而我们要的是"忽略客户端值、用服务端值"，不是拒）。剥离后服务端从 `req.user` 取：登录 → `user_id=req.user.id`, `role=req.user.role`；未登录 → 两者 `NULL`。即 **strip → strict → server-set**，三步定序。`user_id`/`role` 不在 props/信封 schema 内，剥离后 strict 自然不报未知键。
5. **partial-accept**（per-event，永不毒整批）：逐条校验，第 N 条无效 → **skip + pino warn**（`{ event_index, name, issues }`），**不**让整批失败。有效条进 INSERT。全部无效仍 204（0 行入库 + 日志）。
6. **insert + 幂等**（CRITICAL #1 + #2）：把有效条**单批 INSERT**，`ON CONFLICT(event_id) DO NOTHING`（kysely `.onConflict((oc) => oc.column('event_id').doNothing())`）。**await** 这次插入：
   - 成功 → `204`（无 body）。
   - 插入抛错（DB 挂 / pool 耗尽 / 超时）→ **5xx**（交给 `createErrorHandler` 出 500 `internal_error`），**绝不**先 204 再异步写。客户端见 5xx 留 batch 重试。
   - => **at-least-once 投递 + exactly-once 存储**。客户端仅在收 2xx ack 后才从磁盘队列删该批。
7. **专属 rate-limiter + 绕开全局 limiter**（CRITICAL #3）：
   - **绕开全局**（BLOCKER 修正）：现 `src/app.ts` 在 `mountRoutes` **之前**就 `app.use(createGlobalRateLimit(...))`（per-IP）。若不处理，`/events` 会**先撞全局 per-IP limiter**——阿里云 SLB 后全员塌一桶、analytics 重试风暴把用户 429 出真实 app + 吃掉 `/auth`/`/sets` 配额。修法：给全局 limiter 加 `skip: (req) => req.path === '/events' || req.path === '/events/feedback'`（或等价路径前缀判断），让这两条**完全不过**全局 limiter；它们只走自己的专属 limiter。
   - **专属 limiter**：`/events` 与 `/events/feedback` 各挂一个 `express-rate-limit` 实例，**`keyGenerator` 读 `req.body.anon_id`**（已提到 batch 顶层，见上信封形态，pre-login 也有；缺失才退 `user_id` → IP）。必须挂在 `express.json` **之后**（全局 json 在 app 级，已满足）。
   - **fail-OPEN**：命中上限 → **静默 drop + 204**，**绝不 429** 用户（`handler` 覆写成返回 204，不是默认 429）。
   - 窗口/上限走新 config（见 §11 config），默认宽。
     > **TRUST_PROXY 真 gate**：现 `config.TRUST_PROXY` 默认 0；生产在阿里云 SLB 后，IP 兜底键会全塌成 SLB IP。anon_id 主键规避了大部分风险，但部署前**必须确认生产 `TRUST_PROXY` 设为 SLB 跳数**（否则 IP 兜底 + 任何未来 per-IP 逻辑误判）。本 spec 登记此确认为部署前置。

### 4. `GET /events/config`（kill-switch）

`createOptionalAuth`（读不需登录），返回：

```json
{ "enabled": true, "sample_rate": 1.0 }
```

iOS 在 `app_open` 时读一次。`enabled=false` → 客户端整体停发（远程熄火，无需发版）。`sample_rate ∈ [0,1]` 客户端侧采样。V1 值来自 config（env，默认 `enabled=true` / `sample_rate=1.0`）；不落库、不做 per-user 分桶（镀金）。

### 4b. `POST /events/feedback` + `analytics_feedback` 表（质化反馈，**唯一**自由文本路径）

> **决策（David 2026-06-24）**：in-app 摩擦反馈那句话**要存**（这是 founder 选 in-app 反馈进 v1 的本意 = 拿质化 why）。但 `events` 表**永不**接自由文本（真 gate 不变）。所以用户键入的一句话走**独立路径**落**独立表**，与 `events` 物理隔离。

`events` 流仍只收 enum-only `friction_feedback` 信号（"提示触发 + 用户参与"，见 §8）；**那句话**走这条单独端点 + 单独表，靠 `event_id` 与信号事件可 join。

**migration `NNNN+1-init-analytics-feedback.sql`**（紧随 `NNNN`）：

```sql
-- Migration NNNN+1: qualitative friction feedback (the ONE free-text path).
-- Physically separate from `events` (events stays free-text-free — true gate).
-- `text` is the only free-text column in the analytics surface; capped, and this
-- table carries a PIPL content-class declaration (User Content) that `events`
-- does not. Joins back to the friction_feedback signal event by event_id.
BEGIN;
CREATE TABLE analytics_feedback (
  id          BIGSERIAL PRIMARY KEY,
  event_id    UUID NOT NULL UNIQUE,          -- = the friction_feedback signal event's id (join key)
  anon_id     UUID NOT NULL,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  session_id  UUID NOT NULL,
  flow        TEXT NOT NULL,                 -- enum-validated in route
  from_screen TEXT NOT NULL,                 -- enum-validated in route
  trigger     TEXT NOT NULL,                 -- re_edit | flow_cancel
  text        TEXT NOT NULL,                 -- the user's sentence; capped <=500 chars in zod
  app_version TEXT,
  build       TEXT,
  ts_client   TIMESTAMPTZ NOT NULL,
  ts_server   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX analytics_feedback_user_ts_idx ON analytics_feedback (user_id, ts_client);
CREATE INDEX analytics_feedback_server_ts_idx ON analytics_feedback (ts_server);
COMMIT;
```

**`POST /events/feedback`**（`createOptionalAuth`，同 `/events` 的不信客户端 + await-insert-then-respond + 专属 limiter + fail-open 全套）：

- body 单条：`{ event_id, anon_id, session_id, flow(enum), from_screen(enum), trigger(enum), text, ts_client }`。
- zod：`flow`/`from_screen`/`trigger` enum allowlist；`text` = `z.string().trim().min(1).max(500).refine((s) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s), 'no control chars')`（**唯一**放行的自由文本：长度硬上限 + 显式禁控制字符，仅放行 \t/\n/\r）；`user_id`/`role` 同样**服务端从 JWT 推 + strip**。
- `ON CONFLICT(event_id) DO NOTHING`（幂等，客户端 2xx 后才删）；await insert → 204 / 失败 5xx。
- 客户端「跳过」不发本端点（只有真打字 + 发送才落 feedback；信号事件 `friction_feedback` 仍照常进 `/events`）。
- `src/db/types.ts` 加 `AnalyticsFeedbackTable`。

**为什么单独表而不是 events 加一列**：events 表的"无自由文本"是真 gate（PIPL 面 + 注入面 + 脏数据），一旦开个口子就守不住。独立表把自由文本 + 它专属的 PIPL 内容类声明（User Content，见 iOS 043 §8）圈在一处，events 表保持纯净 enum/id。

### 5. ingest 健康信号

- **per-batch pino line**（CRITICAL：破管道可检测）：每个 `POST /events` 出一条 `logger.info({ received, accepted, skipped, has_user }, 'events_ingest')`。fail-silent 客户端 + 静默管道断 = 零信号，这条结构化日志是唯一心跳。
- **每日 sanity 查询**（文档化，运维手跑 / 后续进 cron，本 spec 不实现调度）：

```sql
SELECT count(*)                              AS events_24h,
       count(DISTINCT anon_id)               AS distinct_installs,
       count(DISTINCT name)                  AS distinct_event_names
FROM events
WHERE ts_server > now() - interval '24 hours'
  AND build NOT LIKE 'Demo%';
```

`events_24h = 0` 或 `distinct_event_names` 骤降 = 管道死/坏部署，肉眼可判。

### 6. `src/db/types.ts` events interface

加 `EventsTable` + 注册进 `Database`，镜像 readiness/attachments 的 `ColumnType` 用法：

```ts
export const EVENT_PLATFORMS = ['ios'] as const;
export type EventPlatform = (typeof EVENT_PLATFORMS)[number];

// name 的权威 enum 在 route 的 zod discriminatedUnion；表列是 text（前向兼容）。
export interface EventsTable {
  id: Generated<string>; // BIGSERIAL — node-pg 默认把 int8 读成 string（同 types.ts:379 的 BIGINT 约定）；时间线查询本就不 select id
  event_id: string; // client uuid, UNIQUE
  anon_id: string;
  user_id: NullableColumn<string>; // server-derived, NULL pre-login, ON DELETE SET NULL
  role: NullableColumn<string>;
  session_id: string;
  seq: number;
  name: string;
  // JSONB: insert a JSON string (node-pg encodes JS arrays as PG array literals
  // otherwise); reads parsed JSON, pg-mem may return string. Normalize at serialize.
  props: ColumnType<Record<string, unknown> | string, string, string>;
  schema_version: Generated<number>;
  app_version: NullableColumn<string>;
  build: NullableColumn<string>;
  platform: Generated<EventPlatform>;
  ts_client: TimestampColumn;
  ts_server: TimestampColumn;
}
```

### 7. retention（90d）+ 删除路径

- **90d TTL 文档化**：`events` **和** `analytics_feedback` 同样保留 90 天，与 PIPL 隐私政策文案对齐（iOS 043 §隐私文案声明 90d）。删除方式 = 运维定期 `DELETE FROM events WHERE ts_server < now() - interval '90 days'`（用 `events_server_ts_idx`）+ 同条件删 `analytics_feedback`（`analytics_feedback_server_ts_idx`）。本 spec 不引入调度器（仓库无 cron 基础设施）；登记为运维 SOP + 后续可上 cron。`analytics_feedback` 是 User Content（自由文本），90d TTL 对它尤为重要（PIPL 最小必要期）。
- **删除路径接进用户删除**：仓库当前**无**用户删除端点（grep 无 `DELETE FROM users` 路径）。两种语义分清楚，别混（codex review 修正）：
  - **默认（无显式删除流程时）**：`user_id` FK `ON DELETE SET NULL` —— 若 users 行被删，events/analytics_feedback 的 `user_id` 自动置空（去标识，保时间线形状，PIPL 删除权可辩护）。
  - **未来用户删除 spec 要做完整 PIPL 抹除时**：在删除事务里 `DELETE FROM events WHERE user_id = $1` **+** `DELETE FROM analytics_feedback WHERE user_id = $1`，且**必须在删 users 行之前**执行——否则 FK 的 `ON DELETE SET NULL` 先把 `user_id` 置空，再按 `user_id=$1` 删就**找不到行**（孤儿）。删除顺序是真 gate。
  - **anon_id 范围**：后端**无** anon_id↔user 映射表（anon_id 只在 iOS UserDefaults），故服务端删除**只能按 `user_id`**。pre-login 的 anon-only 事件（`user_id IS NULL`）无法归属到某用户，靠 **90d TTL 自然老化**清掉，不在 user-delete 路径内。

### 8. 事件 registry（共享契约 — 与 iOS spec 043 逐字一致）

**每条事件自动携带**（客户端置，除标注外）：`event_id`(client uuid, server-UNIQUE 去重) · `anon_id`(uuid, UserDefaults — **非 Keychain**) · `user_id`(**服务端**从 JWT 推, pre-login NULL, 客户端值剥离) · `role`(服务端推, pre-login NULL) · `session_id`(uuid, 后台 ≥30min 重置) · `seq`(per-session 单调) · `name`(enum allowlist) · `props`(jsonb, per-event zod, **只 id/enum, 永不自由文本/实测值**) · `app_version` · `build` · `platform='ios'` · `ts_client`(设备时钟, **不可信**) · `ts_server`(`DEFAULT now()`)。

**~18 事件 + props（name enum allowlist + 每个 props 的 strict zod）：**

| 组                                        | name                  | props（只 id/int/bool/enum）                                                                 |
| ----------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| A 用量广度                                | `app_open`            | `cold`(bool)                                                                                 |
|                                           | `screen_view`         | `screen`(enum)                                                                               |
| B 录训练闭环（最细）                      | `workout_log_start`   | `plan_id?`(uuid), `source`(enum: dashboard\|calendar)                                        |
|                                           | `set_logged`          | `exercise_id`(uuid), `set_index`(int), `has_video`(bool), `outcome`(enum: completed\|failed) |
|                                           | `workout_log_save`    | `n_sets`(int), `duration_ms`(int)                                                            |
| C 学员流程                                | `onboarding_step`     | `step_index`(int), `step_name`(enum)                                                         |
|                                           | `onboarding_complete` | `n_steps_filled`(int), `used_draft_resume`(bool)                                             |
|                                           | `bind_coach_action`   | `stage`(enum: invite_open\|submitted\|accepted)                                              |
|                                           | `plan_viewed`         | `plan_id`(uuid)                                                                              |
|                                           | `progress_viewed`     | `tab`(enum: e1rm\|volume\|history)                                                           |
| D 教练闭环                                | `coach_open_student`  | `student_id`(uuid)                                                                           |
|                                           | `coach_feedback_sent` | `student_id`(uuid), `kind`(enum: text\|video)                                                |
|                                           | `coach_plan_assigned` | `student_id`(uuid)                                                                           |
|                                           | `coach_intake_action` | `stage`(enum: request_seen\|accepted_eval\|accepted_skip\|rejected), `student_id`(uuid)      |
|                                           | `eval_summary_action` | `stage`(enum: draft_saved\|delivered), `student_id`(uuid)                                    |
| E 摩擦/放弃                               | `validation_error`    | `flow`(enum), `field`(enum)                                                                  |
|                                           | `field_re_edit`       | `flow`(enum), `field`(enum), `count`(int)                                                    |
|                                           | `nav_back`            | `from_screen`(enum), `in_flow`(enum)                                                         |
|                                           | `flow_cancel`         | `flow`(enum), `from_screen`(enum)                                                            |
| F 崩溃                                    | `client_error`        | `domain`(enum), `code`(enum/int), `screen`(enum)                                             |
| G 摩擦反馈（David 加选）                  | `friction_feedback`   | `flow`(enum), `from_screen`(enum), `trigger`(enum: re_edit\|flow_cancel)                     |
| **GATED**（027 在内测构建 → **门控 IN**） | `media_upload`        | `stage`(enum: started\|succeeded\|failed), `context`(enum), `bytes?`(int)                    |

> **放弃信号 = 显式 `flow_cancel` + 后端派生兜底**（有 `workout_log_start` 无 `workout_log_save`）。abandonment **不另埋**事件。停留时长 / 漏斗逐步流失率 / 会话边界同样**后端派生**，不浪费埋点。
> **`media_upload` 门控判定**：spec 027 video upload **在 V0.1 内测构建内**（004-video-upload 已实装支撑 027），故 `media_upload` **纳入** allowlist。
> **in-app 摩擦反馈 `friction_feedback`**（David 加选进 v1）：2× `field_re_edit` 或 flow 放弃后弹"卡住了?一句话告诉我们"。**两段物理隔离**：① **信号**走 `events` 流，作为 registry 内的 `friction_feedback` 事件，props **只含 enum**（`flow` / `from_screen` / `trigger`），记录"提示触发了且用户参与了"——`events` 表无自由文本列，本事件 props 同样走 `.strict()` enum-only zod，与所有其它事件一致。② **用户键入那句话**（David 2026-06-24 决策要存）走**独立** `POST /events/feedback` → 独立 `analytics_feedback` 表（§4b），靠 `event_id` 与信号事件 join。`events` 表**永不**接自由文本（真 gate 不变）；自由文本仅存在于 `analytics_feedback.text` 这一处，带它专属的 PIPL User Content 声明。

**ts 读序 tie-break**：`ORDER BY ts_client, ts_server, seq`——设备时钟 skew 时用服务端时钟 + 会话内单调 seq 兜稳故事线顺序。读路径默认 `WHERE build NOT LIKE 'Demo%'`（Demo 隔离，见下）。

### 8.1 enum 值集（strict zod allowlist — 单一真源在 iOS 043 的 Swift enum，backend zod 镜像）

> 没有命名的 enum allowlist = 实装瞎编 = 削弱"禁自由文本"门。**权威在 043** 的 `AnalyticsScreen` / `AnalyticsFlow` / `AnalyticsField` / `AnalyticsScreen`(from_screen 复用) / `OnboardingStepName` 等 Swift enum（client 是事件源头，闭集编译期 gate）；backend zod `z.enum([...])` **逐字镜像同一闭集**。下为**种子值集**（实装时与 043 enum 对齐，增减同步两边）：

| enum                           | 种子值集                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `screen` / `from_screen`       | `today_workout` `dashboard` `plan` `progress_history` `onboarding_wizard` `bind_enter_code` `pending_bind` `coach_roster` `coach_student_detail` `coach_receiving` `coach_planning` `coach_evaluation` `account`（与 043 `AnalyticsScreen` 同源，闭集） |
| `flow`                         | `record_set` `onboarding` `bind` `planning` `coach_intake` `coach_feedback`                                                                                                                                                                             |
| `field`                        | `weight` `reps` `rpe` `set_count` `bodyweight` `competition_date` `invite_code` `goal` `experience`（表单可校验/可反复改字段；与 043 同源）                                                                                                             |
| `step_name`                    | spec 032 onboarding 7 步的步名（实装取 032 `OnboardingStep` 闭集，如 `goal` `experience` `lifts` `schedule` `competition` `equipment` `review`）                                                                                                        |
| `source`（workout_log_start）  | `dashboard` `calendar`                                                                                                                                                                                                                                  |
| `tab`（progress_viewed）       | `e1rm` `volume` `history`                                                                                                                                                                                                                               |
| `kind`（coach_feedback_sent）  | `text` `video`                                                                                                                                                                                                                                          |
| `outcome`（set_logged）        | `completed` `failed`                                                                                                                                                                                                                                    |
| `trigger`（friction_feedback） | `re_edit` `flow_cancel`                                                                                                                                                                                                                                 |
| `stage`                        | `bind_coach_action`: `invite_open\|submitted\|accepted`；`coach_intake_action`: `request_seen\|accepted_eval\|accepted_skip\|rejected`；`eval_summary_action`: `draft_saved\|delivered`；`media_upload`: `started\|succeeded\|failed`                   |
| `context`（media_upload）      | `onboarding` `set_log` `coach_feedback`                                                                                                                                                                                                                 |
| `domain`（client_error）       | `network` `decode` `persistence` `ui` `unknown`                                                                                                                                                                                                         |
| `code`（client_error）         | enum 或 int（崩溃信号/HTTP 码/`NSError.code`）；非自由文本                                                                                                                                                                                              |

任何不在闭集内的值 → 该事件 zod 校验失败 → partial-accept skip（不毒整批）。增事件/值 = 改两边 enum + bump `schema_version`。

### 9. Demo 隔离

iOS 043 侧 Demo 构建**硬关** Analytics（no-op，数据不离设备）**或** tag `build='Demo'`。后端侧**所有读路径默认 `WHERE build NOT LIKE 'Demo%'`**（sanity 查询已含），防演示数据污染真实内测时间线。后端不拒 Demo 写入（无害），靠读侧过滤。

### 10. tests

镜像 `tests/sets-log.test.ts`（supertest + 真实 Kysely，DB 边界）+ `tests/migrations/0014-readiness-checkins.test.ts`（pg-mem）：

**`tests/events.test.ts`（supertest）：**

1. **zod reject**：free-text props / 未知 `name` / 未知键 / 超界 → 该条 skip（partial-accept），合法条仍入库；全无效 → 204 + 0 行。
2. **server-derived user_id overrides client**：body 带伪造 `user_id`/`role`，登录态 POST → 入库行 `user_id = req.user.id`（非 body 值）；`role` 同理。
3. **anon-only insert**：无 token POST → 204，行 `user_id IS NULL` / `role IS NULL`，`anon_id` 保留（pre-login 漏斗不丢）。
4. **rate-limit path**：超专属 limiter → **204 + 0 新行**（fail-open drop），**绝不 429**。
5. **fail-open → 5xx on insert error**：mock DB insert 抛错 → 响应 5xx（**不是** 204），证明 await-insert-then-respond（客户端会重试）。
6. **batch N → N rows**：50 条合法 → 50 行。
7. **ON CONFLICT idempotency**：同 `event_id` 重发两批 → 仅 1 行（exactly-once 存储）。
8. **413**：>1mb body → 413（拆批契约）。
9. **batch cap**：>50 条 → 400 `EVENTS_BATCH_TOO_LARGE`。
10. **`GET /events/config`**：返回 `{ enabled, sample_rate }`，无 token 也可读。

**`tests/events-feedback.test.ts`（supertest，§4b 自由文本路径——最敏感，必测）：**

1. **server-derived user_id overrides client**：body 伪造 `user_id`/`role`，登录态 POST `/events/feedback` → 入库行 `user_id = req.user.id`。
2. **anon-only**：无 token → 204，`user_id IS NULL`。
3. **text 校验**：空串 / 全空白 / >500 字符 / 含控制字符 → **400 拒**（§4b schema 是 `.max(500).refine`，**只 reject 不截断**；客户端侧 ≤500 截断是 043 的事，服务端是硬 gate），合法 → 入库。
4. **ON CONFLICT(event_id) idempotency**：同 `event_id` 重发两次 → 仅 1 行。
5. **await-insert-then-respond**：mock insert 抛错 → 5xx（非 204）。
6. **rate-limit fail-open**：超专属 limiter → 204 + 0 新行，绝不 429。
7. **隔离断言**：`/events/feedback` 写 `analytics_feedback`，**不**往 `events` 表写任何行（自由文本不进 events，真 gate）。

**`tests/migrations/NNNN-events.test.ts` + `tests/migrations/NNNN+1-analytics-feedback.test.ts`（pg-mem）：**

- `NNNN`（events）：`event_id` UNIQUE 拒重复插入；`user_id` FK `ON DELETE SET NULL`（删 user 后该行 `user_id IS NULL`、行**仍在**，对比 0014 的 CASCADE）；`props` 默认 `'{}'`、`platform` 默认 `'ios'`、`schema_version` 默认 1；四索引存在。
- `NNNN+1`（feedback）：`analytics_feedback` 建表；`event_id` UNIQUE；`user_id` FK `ON DELETE SET NULL`；`text` NOT NULL；两索引存在。
- pg-mem 需注册 `gen_random_uuid` 已在 helpers；BIGSERIAL/jsonb 走既有 helper 模式。

### 11. config（新增 env，镜像现有 `RATE_LIMIT_*` 命名）

`src/config.ts` 的 `ConfigSchema` 加四个字段（zod-validated，默认值供本地/test 直接跑）：

| env                           | 类型 / 默认                                                               | 用途                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVENTS_RATE_LIMIT_WINDOW_MS` | `z.coerce.number().int().positive().default(60_000)`                      | /events + /events/feedback 专属 limiter 窗口                                                                                                                                       |
| `EVENTS_RATE_LIMIT_MAX`       | `z.coerce.number().int().positive().default(600)`                         | 每窗口每 anon_id 上限（宽，内测 n<50 远够；fail-open 不会 429 用户）                                                                                                               |
| `ANALYTICS_ENABLED`           | `z.enum(['true','false']).default('true').transform((v) => v === 'true')` | `GET /events/config` 的 `enabled`（kill-switch 总开关）。**不用 `z.coerce.boolean()`**——它走 JS `Boolean()`，`"false"`/`"0"` 都会变 `true`，kill-switch 永远关不掉（codex 验证）。 |
| `ANALYTICS_SAMPLE_RATE`       | `z.coerce.number().min(0).max(1).default(1)`                              | `GET /events/config` 的 `sample_rate`                                                                                                                                              |

`.env.example` 同步加占位（仅说明，无敏感值）。`TRUST_PROXY`（已存在）部署前确认（§3 step 7）。

## 真 gate

1. **不信客户端**：`user_id` / `role` 一律服务端从 JWT 推，body 值剥离（CRITICAL #4）。props 只准 id/enum，free-text 一律拒（per-event strict zod）——这是真 gate，不是纸面：自由文本入 analytics = PIPL 面 + 注入面 + 脏数据。
2. **await-insert-then-respond**（CRITICAL #1）：成功 204 / 失败 5xx，**绝不** ack-before-write（静默丢整批）。
3. **event_id UNIQUE + ON CONFLICT DO NOTHING**（CRITICAL #2）：at-least-once 投递 → exactly-once 存储。
4. **专属 limiter + fail-open + TRUST_PROXY**（CRITICAL #3）：keyed on anon_id，永不 429 用户；部署前确认生产 `TRUST_PROXY`。
5. **部署顺序**（仓库无 migration runner，手 psql）：
   1. `NNNN-init-events.sql` + `NNNN+1-init-analytics-feedback.sql` 合 staging → CI 出 image
   2. 手 psql **staging** RDS，`\d events` + 四索引 + `\d analytics_feedback` 验证
   3. 部署 staging SAE，跑扩展 e2e-smoke（emit → assert rows）
   4. 手 psql **生产**阿里云 RDS 应用同 migration（**先于** iOS 发带埋点构建）
   5. 改 `PrivacyInfo.xcprivacy` + App Store Connect 隐私问卷 + PIPL 隐私政策文案（iOS 043）
   6. 才切带埋点的 TestFlight 构建

## 不做

- **Metabase 自托管**：纯运维动作，beta 先 stored SQL（Day-1 dashboard 4 条 + per-user timeline），手跑超约每日才上。不进本 spec。
- **session-replay-lite**：defer。
- **维度表 / event-sourcing / Kafka / 物化漏斗**：`events` 是可替换种子表，不是数仓，禁镀金。
- **调度器 / cron**：retention 删除 + 每日 sanity 先手跑（仓库无 cron 基础设施）。
- **per-user 采样分桶 / config 落库**：`/events/config` 读 env，不分桶。
- **`events` 表自由文本 props 列**：后端 events 表**永不**接自由文本（真 gate）。`friction_feedback` 事件 props 为 enum-only 信号（`flow`/`from_screen`/`trigger`）。质化反馈那句话**不入 events 表**——它走独立 `POST /events/feedback` → `analytics_feedback` 表（§4b，本 spec 内唯一自由文本路径，圈在单独表 + 单独 PIPL 内容类声明）。

## 下游

- **iOS spec 043-analytics-instrumentation**：消费 `POST /events`（信封 + ~18 事件 registry 逐字一致）+ `GET /events/config`（app_open 读 kill-switch）。`Analytics` 叶子 SPM target 复用 Networking `BindQueue`/`OSSPartUploader` 磁盘原语（队列 cap N=1000 / 7d TTL，batch ≤50，413 拆批，props ≤4KB），event_id 客户端生成，anon_id 进 UserDefaults，`PrivacyInfo.xcprivacy` 字面 plist diff（`NSPrivacyCollectedDataTypeProductInteraction` Linked=true/Tracking=false/Purposes=[Analytics, AppFunctionality] + `DeviceID` Linked=true/Tracking=false/Purpose=Analytics；`NSPrivacyTracking` 保持 false）+ PIPL notice-only 隐私文案（收使用分析 / 为什么 / 境内阿里云 / 90d TTL / 删除路径，onboarding 前/时披露）。
- 未来**用户删除 spec**：其删除事务须 `DELETE FROM events WHERE user_id = $1` **+** `DELETE FROM analytics_feedback WHERE user_id = $1`，**且在删 users 行之前**（否则 ON DELETE SET NULL 先置空 user_id 致孤儿，见 §7）。SET NULL 仅是无显式删除流程时的去标识兜底。

## 修订记录

| 日期       | 版本 | 变更                                                                                                                                                                                                                                                                                                                                                       | 作者   |
| ---------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 2026-06-24 | 0.1  | 起草：events 表 + /events(optional-auth+专属limiter+await-insert+ON CONFLICT) + /events/config + 5 CRITICAL + ~18 事件 registry + 测试镜像                                                                                                                                                                                                                 | Claude |
| 2026-06-24 | 0.2  | David 决策质化反馈要存：加 §4b `analytics_feedback` 表（migration 0020 → 起跑重取号，见 §1）+ `POST /events/feedback`（唯一自由文本路径，与 events 物理隔离，带 User Content PIPL 声明）+ retention/删除/部署同步                                                                                                                                          | Claude |
| 2026-06-24 | 0.3  | review-loop 轮1 codex 8 BLOCKER+3 nit 全采纳：状态 Planned→Draft；全局 limiter `skip` /events；信封 anon_id 提顶层（limiter key）；errorHandler 透传 413；createOptionalAuth 不赋 undefined（exactOptional）；§8.1 enum 值集；删除顺序 + 仅 user_id；§4b feedback 测试 + feedback migration test；BIGSERIAL→string；text 禁控制字符 refine；§11 config env | Claude |
| 2026-06-24 | 0.4  | review-loop 轮2 codex 1 BLOCKER+2 nit 全采纳：`ANALYTICS_ENABLED` 改 `z.enum(['true','false']).transform`（`z.coerce.boolean` 关不掉 kill-switch）；feedback text 测试去掉"截断"（schema 只 reject）；step 3/4 钉死 strip→strict→server-set 顺序                                                                                                           | Claude |
