# 024 — 教练↔学员 1:1 聊天(后端 · W1 应用内消息)

- **状态**: InProgress（scope 已锁,经 6 轮 Claude↔Codex 互审收敛 VERDICT: CLEAN;此后改 scope 须另开 follow-up spec）
- **PR**: TBD(backend spec PR + backend impl PR)
- **对应 iOS spec**: `058-coach-student-chat`(同一 wave 的客户端;本 spec 定义 wire 契约,iOS 侧消费)。评审期在 worktree `~/Projects/apps/MeetPR-wt-chat/specs/058-coach-student-chat/SPEC.md`;merge 后落 `~/Projects/apps/MeetPR/specs/058-coach-student-chat/SPEC.md`。
- **来源 / 授权**:
  - David 2026-07-20 拍板:启动教练↔学员 1:1 聊天功能;产品面四拍板 = **做已读回执 / 文本+图片 / 复用「接收」tab 聚合 / W1 轮询·W2 推送**;1:1、历史全留、bond 授权、落 main 大包(P2 不上车)为默认。
  - 通道选型 = **A(REST 轮询 + 复用推送 outbox)**:数据落自家 Postgres,将来升 SSE/WebSocket 不换表结构。
  - 复用授权源:`src/db/bonds.ts` `hasAcceptedBond(coachId, studentId)` = 1:1 关系的权威判据。
  - 复用上传设施:spec 004 `/uploads/*` 多段上传 + 预签名 URL + `attachments` 表 + `KIND_LIMITS`(本 spec 加一个 `chat_image` kind)。

## 目标

给「已建立 accepted 绑定」的教练与学员之间开一条**异步文本 + 图片消息**通道,后端提供:会话解析(get-or-create)、消息发送(文本/图片,幂等)、历史分页拉取、增量轮询、已读游标(驱动已读回执 + 未读红点)。

**本 spec = W1**,只做 REST + 数据层。**不做**实时推送(APNs 在 W2);当前纯轮询由 iOS 侧驱动。

## 范围

### 做什么

#### 1. 迁移 `0045-init-chat.sql`(additive,head 现为 0044)

> **迁移号现场核实**:head = `0044-add-admin-role.sql`(0043 跳号)。本 spec 取 **0045**;开工时以 `db/migrations/` 实际最大编号 +1 为准,若已被占用则顺延,并同步改 `src/db/types.ts` 的 `Database` 接口(hand-augmented,硬规则 #1)。

> **迁移写法惯例**(核对既有迁移 0036/0042):文件用 `BEGIN; … COMMIT;` 包裹;类型大写(`UUID` / `TIMESTAMPTZ` / `TEXT`);`gen_random_uuid()` 生成主键、`DEFAULT now()` 生成时间戳——下方示意 SQL 已按此约定。

三张表 + 一个 enum 值扩展:

```sql
-- conversations: 一对 (coach, student) 唯一一条 1:1 会话
CREATE TABLE conversations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id       uuid NOT NULL REFERENCES users(id),
  student_id     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,           -- null = 空会话;排序键
  UNIQUE (coach_id, student_id)
);
CREATE INDEX conversations_coach_idx   ON conversations(coach_id, last_message_at DESC);
CREATE INDEX conversations_student_idx ON conversations(student_id, last_message_at DESC);

-- messages: 一条消息(文本或图片)。排序/游标唯一依据 = 会话内单调序号 seq(D1),不是时间戳
CREATE TABLE messages (
  id              uuid   PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid   NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             integer NOT NULL,      -- 会话内单调递增,发送事务锁会话 row 后分配(D1)。INTEGER 非 BIGINT:node-pg 不 parse int8→string,单会话 21 亿条足够
  sender_id       uuid   NOT NULL REFERENCES users(id),
  kind            text   NOT NULL CHECK (kind IN ('text','image')),
  body            text,
  attachment_id   uuid   REFERENCES attachments(id),
  client_id       text   NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),  -- 展示用,DEFAULT 也用 clock_timestamp(非 now()=事务开始时间),防 seed/测试/后续写路径造倒序展示时间
  CHECK ((kind='text'  AND body IS NOT NULL AND attachment_id IS NULL)
      OR (kind='image' AND attachment_id IS NOT NULL AND body IS NULL)),
  CHECK (body IS NULL OR length(body) BETWEEN 1 AND 4000),  -- 非空 + 上限(nit 修)
  CHECK (length(client_id) BETWEEN 1 AND 64),
  UNIQUE (conversation_id, sender_id, client_id),  -- 幂等:重发同 client_id 命中既有
  UNIQUE (conversation_id, seq)                     -- 会话内序号唯一 + 排序键
);
CREATE INDEX messages_conversation_seq_idx ON messages(conversation_id, seq);

-- conversation_reads: 每人一条已读游标 = 会话内 seq(不做每消息 read 行,不去规范化——避免漂移,见 nit)
CREATE TABLE conversation_reads (
  conversation_id uuid   NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid   NOT NULL REFERENCES users(id),
  last_read_seq   integer NOT NULL,  -- 我已读到的会话内 seq(经会话归属校验后写入;INTEGER 同 messages.seq)
  PRIMARY KEY (conversation_id, user_id)
);
```

`attachments.kind` 扩 `chat_image`(**BLOCKER 修 — 事实纠正**):DB 侧**已有** CHECK 约束 `attachments_kind_check`(`0007-init-attachments.sql:9`);`src/db/types.ts` 的 `ATTACHMENT_KINDS` 只是手工镜像、**不会改 DB**。所以 0045 **必须 `ALTER TABLE attachments DROP CONSTRAINT attachments_kind_check` 再 `ADD CONSTRAINT` 一个含 `chat_image` 的新版**(否则 `/uploads/initiate` 插 `kind='chat_image'` 必被 CHECK 拒),同时改 TS 常量。这是对既有约束的 additive 扩值(只增枚举值、不动既有值),符合硬规则 #8。

> **D1 — 排序/分页/已读全用会话内单调序号 `seq`,不用时间戳也不用 `(created_at,id)`(BLOCKER 深修)**:时间戳(乃至 `(created_at,uuid)`)在并发下不可靠——UUIDv4 不单调,且 `now()` 是**事务开始时间**,早开始晚提交的发送会生成比已轮询 anchor 更早的 created_at → 增量轮询**永久漏消息**。故:
>
> - **`seq` = 会话内单调序号**,在发送事务里 **`SELECT … FOR UPDATE` 锁住 conversation row 后**分配 `seq = COALESCE(MAX(seq),0)+1`。会话锁串行化并发发送,`seq` 严格按提交可见顺序递增,`UNIQUE(conversation_id, seq)` 兜底。
> - **分页/轮询/已读全按 `seq` 比较**;`created_at` 仅展示。
> - **wire 游标仍用 `message_id`**(客户端友好):`GET messages` 分页也可直接用 `seq`(客户端追最大 seq),`POST /read` 传 `message_id`,服务端解析成该消息的 `seq`(校验属本会话)后前移 `last_read_seq`。
> - **已读回执** = 「对方 `last_read_seq ≥` 本条 `seq`」;**我的未读数** = 「本会话 `sender_id≠我` 且 `seq >` 我的 `last_read_seq` 的消息数」。
> - **游标单调**:仅当新 `seq >` 现有时前移。
> - **从没读过(无 `conversation_reads` 行)**:wire `my_last_read = null`,未读基线 = 该会话所有对方消息全未读。

> **D2 — 聊天图读授权 = 会话成员;通用 URL 对 chat_image 仅 owner(BLOCKER 修)**:
>
> - **正路**:`GET /messages` 对 image 消息现签 `image_url`(`oss.signGetUrl`,15 min TTL);能不能读由「请求者是该会话成员」决定。跨端读聊天图**只走这条**。
> - **通用 URL 收口**:既有 `GET /uploads/:id/url`(`src/routes/uploads/index.ts:524`)对 `is_unlinked_explicit=true` 附件放行「owner + owner 的 accepted-bind 教练」。强制单教练后(D6)已无「另一教练越界读」的可达漏洞,但仍把 `kind='chat_image'` 收成**仅 owner**——让聊天图授权**不押在 bind 基数约束上**(UUID 不是授权边界),且不挡任何正当流程(对端读图走上面的会话现签、不走通用 URL)。additive-safe,不改其它 kind。

> **D2b — 被消息引用的聊天图不可删除,用共享附件行锁消除 TOCTOU(BLOCKER 深修)**:`messages.attachment_id` 是 `NO ACTION` FK,但既有 `DELETE /uploads/:attachmentId`(`src/routes/uploads/index.ts:461`)先删 OSS 再删行。**光「删前查引用」不够**——它与并发发图存在 TOCTOU:DELETE 查到无引用→发图校验 attachment ready→DELETE 删 OSS→发图插入引用,最终仍产生引用已删对象的坏消息。**修法(发送与删除共用同一 attachment row lock)**:
>
> - **发图**:事务内先 `SELECT … FOR UPDATE` 锁住该 attachment,校验 owner/kind/status=ready,再插消息(引用它),提交。
> - **DELETE / reconcile-delete**:事务内 `SELECT … FOR UPDATE` 锁 attachment → 查 `messages` 引用(有则 `409 ATTACHMENT_IN_USE`,不碰 OSS)→ 原子 claim `deleting` → **提交事务释放锁**,之后再删 OSS(**不持 DB 锁跨 OSS 网络调用**),失败按既有状态机恢复。
> - 谁先拿锁谁定结果,后者拿到锁必须重读 status/引用。聊天图一旦入消息即不可变、伴会话终身;DELETE/reconcile 测试覆盖并发。

#### 2. 会话/消息路由(`src/routes/conversations.ts`,挂 `/conversations`,`requireAuth`)

按现有 `route()` / `validationEnvelope()` / zod-schema-in-`schemas.ts` 范式。

**角色门 + 成员不变量(BLOCKER 修)**:`requireAuth` 还放行 `self_train_student` / `admin`——聊天路由须加显式 `requireRole('coach','coached_student')`(自练学员/admin 不参与聊天)。**成员校验** = 请求者 `id` ∈ {`conversation.coach_id`, `conversation.student_id`};非成员一律 `404 CONVERSATION_NOT_FOUND`(不泄漏存在性)。**写路径不变量**:会话的 `(coach_id, student_id)` 恒从 accepted bond 的 canonical 对推导(`coach_id`→`users.role='coach'`、`student_id`→`coached_student`),不信客户端声明的方向;`sender_id` 必须是该会话 participant。

| 方法   | 路径                          | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/conversations`              | get-or-create。body `{ other_user_id }`。**单事务**:`resolveCanonicalAcceptedBond(student)`(D6)→ 请求隐含的 `(coach_id, student_id)` 对**必须等于 canonical pair**(不信客户端方向;非 canonical/无绑定 → `403 CHAT_BIND_REQUIRED`)→ upsert 会话(`ON CONFLICT (coach_id, student_id)` 命中既有)。返回**完整会话对象**(§wire 契约,含 `other_party{id,display_name}`、`last_message`、双游标、`unread_count`),足够 iOS `openConversation` 直接构 `ChatConversation`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET`  | `/conversations`              | `ORDER BY last_message_at DESC NULLS LAST, id DESC`(空会话不抢头、稳定次级键)。**教练**=全部学员会话;**学员**=只过滤到**当前 active accepted 绑定**的那条(≤1;过往教练历史会话留库不列,见 D6)。每条形状见 §wire 契约。驱动教练「接收」聚合 + 未读红点。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET`  | `/conversations/:id/messages` | 角色+成员校验。游标用会话内 `seq`,`limit` 默认 30 上限 100。**`?before_seq=<n>`**(历史)= `seq < n ORDER BY seq DESC LIMIT N`(新→旧);**`?since_seq=<n>`**(增量轮询)= `seq > n ORDER BY seq ASC LIMIT N`(**取最早的下一批**,防积压 >N 时跳过中间消息);不带游标 = 最新一页 `DESC LIMIT N`。**校验(zod)**:`since_seq` 与 `before_seq` 互斥,同现 → `400 VALIDATION_ERROR`;两者及 `limit` 均正整数、`limit ≤ 100`。meta 带 **`has_more`**(该方向是否还有,客户端在 since 模式 `has_more=true` 时循环推进到追平)。image 消息附现签 `image_url` + `image_expires_in`;meta 附 `other_last_read`(`{message_id, seq}` 或 `null`)。                                                                                                                                                                                                                                                                                                                                                                    |
| `POST` | `/conversations/:id/messages` | 角色+成员校验 + **该会话的 `(coach_id, student_id)` 必须 == `resolveCanonicalAcceptedBond(student)`**(非 canonical / 已解绑 → `403 CHAT_BIND_REQUIRED`,见 D3/D6:过往教练会话只读、不可再发)。body `{ kind, body?, attachment_id?, client_id }`。**单事务、步骤严格有序(BLOCKER 修:授权/锁必须先于任何写)**:① 先查幂等既有行 `(conversation_id,sender_id,client_id)`,命中直接回既有(`200`,同 client_id 异 payload 也回既有、记 `warn`);② image:`SELECT … FOR UPDATE` 锁 `attachment` 并校验**本人 owner、kind=chat_image、status=ready**,否则 `400 CHAT_INVALID_ATTACHMENT`(D2b 共享锁);③ `SELECT … FOR UPDATE` 锁 conversation row → 分配 `seq=MAX(seq)+1`、用 `clock_timestamp()`(**非 `now()`**=事务开始时间)作该消息 `created_at`;④ `INSERT` 消息(`ON CONFLICT (conversation_id,sender_id,client_id) DO NOTHING`,并发首发重试回查、不冒 500);⑤ 仅新建时 `last_message_at = GREATEST(last_message_at, 该 created_at)`(防并发提交顺序回退)。返回消息(§wire);新建 `201`、幂等命中 `200`。 |
| `POST` | `/conversations/:id/read`     | 角色+成员校验。body `{ message_id }`(须为该会话内一条消息;不存在/跨会话 → `400 CHAT_INVALID_CURSOR`)。服务端解析其 `seq`,**仅当 `>` 现 `last_read_seq` 才前移**(单调 upsert)。返回新游标 `{message_id, seq}` + 我方 `unread_count`。驱动已读回执 + 清红点。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

在 `src/routes/index.ts` `mountRoutes` 加一行:`app.use('/conversations', deps.requireAuth, conversationsRouter({ db, logger, oss }))`(需 `oss` 现签图片 url;`oss` 缺配时 image 路径降级——见 D4)。

> **D3 — 发送需活跃绑定;历史消息按成员可读,但学员列表只列 active(与 D6 对齐)**:`POST /messages` 每次重校验 `hasAcceptedBond`——解绑后不能再发。读分两层:**① `GET /messages`(按 conversation id)**——成员身份即可读,与当前绑定状态无关(「历史全留」:换教练/解绑后旧会话消息仍可读);**② `GET /conversations` 列表**——教练列全部;**学员只列 canonical active 会话(D6),过往教练会话留库、知道 id 仍能 `GET messages`,但不进列表(发现入口 defer V1.x)**。理由:不删记录、旧会话可回溯,但学员当前视图聚焦当前教练,且已解绑双方不能再发新消息。

> **D4 — oss 缺配时的降级**:本地 dev / 未配 OSS 时,`GET /messages` 对 image 消息回 `image_url: null`(客户端显示占位),文本消息不受影响;`POST` image 消息仍可写(attachment 已 ready 才允许)。与 uploads 路由「oss 缺则 503」不同——聊天文本不该因图片设施缺失而全挂。

> **D5 — `other_party.display_name` 从 profile 表按角色解析,不在 `users` 表**:`display_name` 落 `coach_profiles` / `student_profiles`(`0003.5-init-profile-tables.sql`),不在 `users`。`GET /conversations` 里对方名 = 对方是教练则 join `coach_profiles.display_name`、是学员则 join `student_profiles.display_name`,用 `COALESCE(..., '')` 防 null。**复用既有查询范式**:学员名见 `src/routes/signals.ts:145`(`sp.display_name` COALESCE),教练名见 `src/handlers/bind-requests.ts:187`(`cp.display_name as coach_display_name`)。因请求者自身角色已知(coach_id/student_id 哪个是我),对方角色即另一个,join 目标表确定。

> **D6 — 单一 active 教练(未来可换),聊天 W1 学员只列 active 会话(2026-07-20 David 拍板)**:David 定「一个学员同一时间只能选一名教练,未来可换教练」。拆清三层:
>
> - **强制单教练 = 独立任务,不在本聊天 wave**:它是 bind 模型改动,尾巴大——现有测试**故意**给一学员建两 accepted 教练(`tests/helpers/studentActions.ts:563`,多教练是当前受支持数据形状)、新 `409 STUDENT_ALREADY_COACHED` 改 accept 端点行为(硬规则 #8 需客户端先行)、存量违规「保留哪条」是产品数据策略(不能自动任选)。单开 spec 处理:部分唯一索引 `UNIQUE(student_id) WHERE status='accepted'` + **按约束名映射错误码**(不把任意 `23505` 都当 `BIND_ALREADY_BOUND`)+ fail-closed 迁移 preflight + 测试 fixture 迁移 + 客户端计划。**聊天 W1 不依赖它落地**。
> - **换教练 = 未来能力**:结束旧绑 → accept 新教练;历史会话「全留」(D3),故换教练后学员会**累积多条历史会话**——单 active 教练**不等于** ≤1 会话总数(Codex 正确指出)。
> - **canonical active 绑定 = 一个共享 helper `resolveCanonicalAcceptedBond(studentId)`(不靠唯一约束)**:该学员 `status='accepted'` 里 **`ORDER BY responded_at DESC NULLS LAST, submitted_at DESC, id DESC` 的第一条**(`responded_at` 可空、DESC 默认 NULLS FIRST 会选中无响应时间的行,故须 `NULLS LAST` + `submitted_at`/`id` 回退)。现数据即便多 accepted 也确定选一条,`LIMIT 1` 有 canonical 依据;bind 约束(拆出 spec)落地后自然只命中一条。
> - **列表 + 写路径都用它,消除「幽灵会话」**:`GET /conversations` 对学员只返回该 canonical 会话;**且 `POST /conversations`(建会话)与 `POST /messages`(发消息)的 `(coach_id, student_id)` 必须等于该 canonical pair**,否则 `403 CHAT_BIND_REQUIRED`——否则非 canonical 教练能建会话/双方能发,而学员列表隐藏它 → 学员发现不了的幽灵会话+未读。`GET messages`(按 id)仍只按成员授权(历史可读)。
> - 过往教练历史会话留库但不进列表、不可再发,「过往教练」入口 defer V1.x。iOS 学员端据此保持单会话(卡/铃直进、无列表)。**是确定性查询得 ≤1,不谎称基数唯一**。

#### 3. `chat_image` 上传(复用 spec 004 `/uploads/*`,零新上传路由)

聊天图走**既有** `POST /uploads/initiate`(`kind: 'chat_image'`)→ 多段 PUT → `POST /uploads/:id/complete`,拿到 `ready` 的 `attachment_id` 后 `POST /conversations/:id/messages`(`kind: 'image'`)。本 spec 只在 `KIND_LIMITS` 加 `chat_image`(见下)+ enum 扩值,**不碰** initiate/complete/abort 逻辑。

`src/routes/uploads/schemas.ts` `KIND_LIMITS` 加:

```ts
chat_image: { maxSizeBytes: 10 * MB, contentTypes: ['image/jpeg', 'image/png'] },
```

(`CONTENT_TYPE_EXTENSIONS` 已含 jpg/png,无需改;`ATTACHMENT_KINDS` 在 `src/db/types.ts` 加 `'chat_image'`。)

> **授权口径见 D2 / D2b(已修正,原「无漏洞」论断作废)**:`chat_image` 经 initiate `is_unlinked_explicit=true`,但**不能**依赖通用 URL 的 coach-of-owner 放行(有跨教练泄漏 + 不可删坏图两洞)。故 0045 配套加固既有 uploads 路由:`GET /uploads/:id/url` 对 chat_image 仅 owner(D2)、`DELETE /uploads/:id` 被消息引用则 409(D2b)。两处 additive-safe,不改其它 kind 行为。

### 不做(本 spec / W1)

- ❌ **APNs 推送**:W2。W2 在 `POST /messages` 成功后向 `notification_outbox` 入队一条 `new_message`(现有 outbox + `apns.ts` 现成,~几行),并翻 `PUSH_ENABLED`。本 spec **不**入队、**不**碰推送。
- ❌ **SSE / WebSocket / 长轮询**:通道选型 A,纯 REST;iOS 侧客户端轮询。升级留后续 spec(表结构不变)。
- ❌ **群聊 / 广播 / 公告**:1:1 only。
- ❌ **消息编辑 / 撤回 / 删除**:V1 不做(历史全留)。
- ❌ **富文本 / @提及 / 引用某次训练**:V1 纯文本 + 图片;「引用某组/某视频」的反 WeChat-chaos 上下文引用留 V2 蓝图。
- ❌ **输入中状态(typing indicator)/ 在线状态**:需实时通道,W1 无。
- ❌ **限流细化**:先套全局 per-IP 限流即可(内测规模);若压测暴露热点再照 `/events` 的 fail-open 限流器补。

## Wire 契约(规范 JSON — 双端并行实装的硬前提,BLOCKER 修)

约定:时间戳 **ISO8601 毫秒 UTC**(`2026-07-20T09:12:30.123Z`);id 为 uuid 字符串;字段 **snake_case**;错误统一 `{ "error": "<CODE>", ...detail }`。**文本 wire 字段是 `body`**(iOS model 映射到 `text`)。单对象响应一律具名包裹。

**Conversation 对象**(`POST /conversations` 的 `conversation`、`GET /conversations` 列表元素 同形):

```json
{
  "id": "c0-uuid",
  "other_party": { "id": "u1-uuid", "display_name": "王晨曦" },
  "last_message": {
    "id": "m9-uuid",
    "seq": 42,
    "kind": "text",
    "preview": "明天深蹲加到 140",
    "created_at": "2026-07-20T09:12:30.123Z",
    "sender_id": "u1-uuid"
  },
  "last_message_at": "2026-07-20T09:12:30.123Z",
  "unread_count": 2,
  "my_last_read": { "message_id": "m7-uuid", "seq": 40 },
  "other_last_read": { "message_id": "m9-uuid", "seq": 42 }
}
```

**可空**:空会话 `last_message=null` + `last_message_at=null`;从没读过 `my_last_read`/`other_last_read=null`;image 消息的 `preview="[图片]"`。`unread_count` 为任意非负整数(示例值非规范)。

**Message 对象**(GET 列表元素 / POST 返回 同形):

```json
{
  "id": "m8-uuid",
  "conversation_id": "c0-uuid",
  "seq": 41,
  "sender_id": "u2-uuid",
  "kind": "image",
  "body": null,
  "attachment_id": "a3-uuid",
  "image_url": "https://oss…signed",
  "image_expires_in": 900,
  "client_id": "cli-xyz",
  "created_at": "2026-07-20T09:10:00.000Z"
}
```

`seq` = 会话内单调序号(排序/游标依据);`kind='text'` 时 `body` 非空、`attachment_id/image_url/image_expires_in=null`;`kind='image'` 反之(`image_url` 在 oss 缺配时也为 null,D4)。

**各端点响应包裹**:

- `POST /conversations` → `{ "conversation": {Conversation} }`(201 新建 / 200 命中)
- `GET  /conversations` → `{ "conversations": [Conversation, …] }`(DESC NULLS LAST)
- `GET  /conversations/:id/messages?since_seq=&before_seq=&limit=` → `{ "messages": [Message, …], "meta": { "other_last_read": {message_id,seq}|null, "has_more": bool } }`。选批:`since_seq`=`seq>n` 的**最早 N 条**(ASC LIMIT,防跳过)、`before_seq`=`seq<n` 的最新 N 条(DESC LIMIT)、无游标=最新 N 条。`has_more`=该方向是否还有;客户端按 `seq` 排序,`since` 模式 `has_more` 时循环追平。
- `POST /conversations/:id/messages` → `{ "message": {Message} }`(201 新建 / 200 幂等命中)
- `POST /conversations/:id/read` → `{ "my_last_read": {message_id,seq}, "unread_count": <非负整数> }`

**错误码**:`CHAT_BIND_REQUIRED`(403)、`CONVERSATION_NOT_FOUND`(404 非成员/不存在)、`CHAT_INVALID_ATTACHMENT`(400)、`ATTACHMENT_IN_USE`(409 删被引用聊天图)、`CHAT_INVALID_CURSOR`(400 message_id 跨会话/不存在)。

## 验收

- [ ] `POST /conversations {other_user_id}`:有 accepted 绑定→返回 `{conversation}`(重复调幂等命中同一行、方向从 bond 推导);无绑定→`403 CHAT_BIND_REQUIRED`;自练/admin 角色→被角色门挡。
- [ ] `POST /conversations/:id/messages` 文本:成员可发、非成员 `404`、绑定已解除 `403`;同 `client_id` 重发命中既有(不产生第二条)。
- [ ] image 消息:`attachment_id` 非本人 owner / 非 `chat_image` / 非 `ready` → `400 CHAT_INVALID_ATTACHMENT`;合法→写入,`GET /messages` 回带现签 `image_url`。
- [ ] **图片授权(D2)**:学员上传 chat_image 发进与教练的会话——教练经会话 `GET /messages` 拿到现签 url;教练拿 attachment UUID 调**通用** `GET /uploads/:id/url` → `404`(chat_image 仅 owner,对端读图只走会话现签)。owner 本人调通用 URL 仍 200(不挡自读)。
- [ ] **图片不可删(D2b)**:被消息引用的 chat_image `DELETE /uploads/:id` → `409 ATTACHMENT_IN_USE`,OSS 对象与消息完好。
- [ ] `GET /conversations`:每条 `unread_count` 与双游标正确、`DESC NULLS LAST`(空会话不抢头);教练多条;**学员只列当前 active 绑定的那条**(≤1),过往教练历史会话不进列表(D6)。
- [ ] 增量分页:积压 >limit 时 `?since_seq=` 按 `ASC` 逐批推进**不跳过中间消息**;`has_more` 正确;`before_seq` 反向分页新→旧。
- [ ] `seq` 为 `INTEGER`,wire 序列化为数字(非 `"41"` 字符串);iOS `Int` 可解码。
- [ ] **游标单调(D1)**:并发发送(含同毫秒、事务交错提交)下,`?since_seq=` 增量轮询不漏不重;`seq` 严格按提交顺序递增(会话锁 + `UNIQUE(conversation_id,seq)`)。
- [ ] 已读:A 发 3 条,B `POST /read {message_id: 第2条}` → A 的 `GET /conversations` 里 `other_last_read` 覆盖前 2 条、B 的 `unread_count` 3→1;再 `POST /read` **更早**的 message_id **不回退**游标;跨会话 message_id → `400`。
- [ ] **角色门**:`self_train_student` / `admin` 调任一聊天路由 → 被 `requireRole` 挡。
- [ ] 迁移 `0045` additive、在 staging schema 上干净应用:三新表(含 `messages.seq` + `UNIQUE(conversation_id,seq)`、`conversation_reads.last_read_seq`)+ **`attachments_kind_check` drop/recreate 含 chat_image**(`/uploads/initiate kind=chat_image` 能过);`src/db/types.ts` hand-augment。
- [ ] `npm test`(vitest + supertest)绿:会话解析 / 幂等(含同 client_id 异 payload)/ 成员+角色门 / 绑定门 / 已读单调 / 未读计数 / 图片授权 + 不可删 / 游标 tie-break 全覆盖。
- [ ] 硬规则核对:additive-only 迁移(#8 向后兼容,含 CHECK 扩值)、无 ORM(#1)、error envelope `{error: code}`、结构化日志。

## 测试(vitest + supertest)

- `conversations.create`:canonical 绑定→创建/幂等;无绑定 403;方向从 bond 推导;角色门挡 self_train/admin。
- `conversations.canonical`(防幽灵会话):学员有多 accepted 时,**非 canonical 教练** `POST /conversations` 或 `POST /messages` → `403 CHAT_BIND_REQUIRED`;canonical pair 放行;`resolveCanonicalAcceptedBond` 对 `responded_at=null` 行走 `NULLS LAST` + `submitted_at`/`id` 回退(不误选无响应时间的行);历史 `GET messages`(按 id)对非 canonical 旧会话仍成员可读。
- `conversations.list`:多会话 `DESC NULLS LAST` 排序 + 空会话不抢头 + unread_count + 双游标;教练多条;**学员只列 active 绑定那条**(换教练后旧会话留库不列);非参与者看不到。
- `messages.paginate`:`since_seq` ASC 逐批不跳过(积压 >limit)、`before_seq` DESC 分页、`has_more` 两方向定义正确;`seq` 序列化为数字。
- (**强制单教练的约束/端点/数据迁移测试不在本 spec**——归 D6 拆出的独立 bind spec。)
- `messages.send.text`:写入 + `last_message_at=GREATEST`;client_id 幂等(含**同 client_id 异 payload 回既有**、并发首发不冒 500);空 body/超长 body 被 CHECK 拒;成员/绑定/角色门。
- `messages.send.image`:attachment 校验矩阵(owner/kind/status);写入后 GET 带 image_url;oss 缺配回 image_url:null(D4)。
- `messages.list`:`before_seq` 分页 + `since_seq` 增量 + limit 上限;**并发/交错提交下 seq 单调、轮询不漏不重**;image 现签;`has_more` 正确。
- `messages.seq`:并发两发送经会话锁串行、seq 连续无洞;`UNIQUE(conversation_id,seq)` 兜底。
- `reads`:`{message_id}` 解析 seq 前移单调;更早 message_id 不回退;unread 归零;跨会话 message_id → 400;无 read 行时 unread 基线。
- 授权:非成员对每个 `:id` 路由都 404;**chat_image 经通用 `GET /uploads/:id/url` 对非 owner(含另一教练)返 404(D2)**;**被引用 chat_image `DELETE` 返 409(D2b)**。
- `uploads.chat_image`:`/uploads/initiate kind=chat_image` 过新 CHECK;content-type/size 限(10MB、jpeg/png)。

## 备注

- **CLAUDE.md 硬规则 #4「No APNs」已被 spec 019 push-pipeline 取代**(`apns.ts` + `notification_outbox` + `device_tokens` 已在跑,`PUSH_ENABLED` 默认 false)。本 W1 spec 不碰 APNs,故不触及;W2 spec 会正式更新该硬规则措辞。**本 spec 不改 CLAUDE.md**,只在此备注。
- **部署形态**:SAE 多实例无粘性会话——这也是选通道 A(无进程内长连接)的原因;REST + 轮询天然多实例安全。W2 若上实时,须外挂 pub/sub(Redis)或托管长连接,届时单开 ADR。
- 本 spec 与 iOS spec 058 是同 wave 双端;wire 契约(字段名 snake_case、时间戳 ISO8601)以本 spec 为准,iOS 侧 Codable 对齐。两端可并行实装(iOS 先用 in-memory repo 对着本契约搭 UI)。
