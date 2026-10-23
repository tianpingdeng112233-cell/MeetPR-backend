# CODEX Journal

## 2026-07-09 — coached 学员单日顺延后端

- 从 `feat/043-plan-import-backend` 建立 linked worktree 和 `feat/shift-day-backend`，新增 0030 手写迁移、`plan_day_shifts` Kysely 类型、学员本人 POST/DELETE 顺延端点，以及 GET plan day 的 nullable `shifted_to_date` 字段。
- 顺延保持为已发布计划树之外的纯增量覆盖层；校验 UTC 今天、计划活跃期、同 plan-week 休息日和 set log，重复相同目标走 UPSERT 并保留原 `id`/`created_at`。
- 测试覆盖顺延/撤销、角色与归属、日期/休息日/log/draft 拒绝、GET 序列化和幂等；迁移测试验证唯一约束与 day 级联删除。
- 踩坑：旧 plans 集成测试使用手建 schema，GET 新增读表后必须同步执行 0030；同时 `pg-mem` 的 DATE 返回 `Date`，与生产 node-postgres 的 DATE-as-text 不同，因此在 wire 序列化边界统一归一为 `YYYY-MM-DD`。

## 2026-09-05 — Google multiple audiences

- Files changed: `src/config.ts`, `src/routes/auth/global.ts`, `src/routes/auth/index.ts`,
  `src/services/oidc.ts`, `tests/unit/config.test.ts`, `tests/unit/oidc.test.ts`,
  `tests/auth/global-identity.test.ts`, `.env.example`, and `docs/CODEX-JOURNAL.md`.
- Keep `GOOGLE_CLIENT_ID` as the environment variable; parse comma-separated IDs into
  `GOOGLE_CLIENT_IDS`, trimming whitespace and removing empty/duplicate entries. Empty or
  missing configuration remains unavailable with `503 AUTH_PROVIDER_NOT_CONFIGURED`.
- Google verification accepts any configured audience. The shared OIDC helper accepts
  `string | string[]`, narrows arrays to the nonempty tuple required by the installed JWT
  types, and rejects empty arrays. Apple string audiences, error envelopes, and logs retain
  their behavior. The deployment renderer has no audience-shape validation and was unchanged;
  no real client IDs, dependencies, or migrations were changed.
- Tests written before implementation:
  - Config: `parses comma-separated Google client IDs, trimming and removing empty and duplicate entries`,
    `preserves a single Google client ID unchanged`, and `leaves Google unconfigured for %j`
    (empty, missing, and whitespace/comma-only values).
  - OIDC: `accepts aud=b when the allowed audiences are a and b`,
    `rejects aud=c when the allowed audiences are a and b`, and
    `rejects a token when no audiences are allowed`.
  - HTTP: `accepts aud=%s with GOOGLE_CLIENT_ID="ios-id, android-id"` (both IDs),
    `rejects an audience outside the configured Google client IDs`,
    `accepts the existing single Google client ID configuration`, and
    `returns 503 when GOOGLE_CLIENT_ID is %j` (empty, missing, and whitespace/comma-only values).
- Red verification: config had 3 failing assertions; OIDC arrays caused TypeScript errors
  before widening the helper (the JWT library already accepted arrays at runtime). HTTP tests
  could not load because the shared dependencies lack `compression`.
- Final verification: config/OIDC unit suites pass all 37 tests. `npm run lint` fails with
  72 errors and 0 warnings; `npm run typecheck` fails with 18 errors, identical to baseline.
  `npm test` reports 81 passed and 71 failed test files, with 368 passed tests and no failed
  test assertions. Existing missing `compression`, `ws`, and AWS S3 dependencies prevent
  affected suites (including global identity) from loading; Vitest also reports an `EPERM`
  writing its results cache through the read-only `node_modules` symlink. No packages were installed.

## 2026-10-10 — 048 email signup verification（卡 A，未提交）

- 在指定工作树 `MeetPR-backend-wt-048` 首先试写并删除临时文件，输出 `WRITE_CHECK_OK`。分支 `feat/048-email-signup-verification`，起点 `756d5d8ad1a4e61d0bb16cda39cc456037b6c820`。只实现 SPEC §1–4 / 验收 1–10；未执行数据操作、发信探针、部署、commit、push 或 PR。
- 新增默认关闭的注册验证开关、默认英文的邮件语言配置；required 缺发信配置时按字段报错。新增注册码端点、5/email/hour 和 30/IP/hour 静默限速、三封 en/zh 邮件；保留英文重置信原文。验证码仅存 SHA-256，10 分钟有效，重发废旧码并清理过期码，错误尝试持久化，第五错作废。成功验码、消费码、建号及 session 在同一事务内；bcrypt 在事务外。同邮箱发码和验证使用事务级 advisory lock。
- 文件范围扩展：`src/routes/auth/email-code.ts` 上提 recovery 现有 `codeHash` / `hashesEqual` 原实现供两条链路复用（CARD 明确允许）；`src/routes/auth/email-recovery.ts` 接入共享函数和 `MAIL_LOCALE`，使 §4 中文重置信能真正生效。`docs/CODEX-JOURNAL.md` 为本次指定交付。其余文件均属 CARD 预期范围。`.env.example` 仅追加两个公开默认值与注释，未读取其原内容；未读取任何环境凭证文件。

### 迁移取号

采用 `0072-email-signup-codes.sql`。`git fetch origin` 原始错误：

```text
error: cannot open '/Users/david/Projects/apps/MeetPR-backend/.git/worktrees/MeetPR-backend-wt-048/FETCH_HEAD': Operation not permitted
```

只读 `git ls-remote` 也失败：`Failed to connect to 127.0.0.1 port 18083 ... Couldn't connect to server`。未改权限或转移工作目录。现有远端引用的现场证据：`origin/staging` = `1d4eb8c337deb39e901749ade71eccef8378169b`，最高 0070；`origin/feat/046-body-weight-records` = `2c0050a7059fd914c2905dabf50b7b48ba72d09f`，占用 0071；`origin/feat/047-user-avatar` = `b48cd3bb69daecd176a0f6e89502bcba9e3af1be`，最高仍 0071，未见 0072。远端最新占号仍须在可 fetch 环境复核，未声称已刷新远端。

### SPEC 验收清单与测试映射

以下是开发自测映射，不替代 Opus 收货验收。

| 条目 | 文件与测试名                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | `tests/auth/email-signup-verification.test.ts`: `keeps legacy registration unverified and ignores code when off; code endpoint is 404`；`defaults direct app configuration to legacy registration`。原有 `global-identity.test.ts` 与 `email-recovery.test.ts` 未改断言，定向运行全部通过。                        |
| 2    | `tests/auth/email-signup-verification.test.ts`: `rejects %s codes without creating a user`，参数 missing / absent / wrong / expired / used；成功用码后再次注册也断言 `AUTH_INVALID_SIGNUP_CODE`。                                                                                                                  |
| 3    | 同上：`issues a hashed ten-minute code, verifies registration and permits immediate login`。                                                                                                                                                                                                                       |
| 4    | 同上：`invalidates the previous code on reissue and deletes expired rows`；randomInt 在测试边界提供不同的确定值，避免随机碰撞导致偶发通过或失败。                                                                                                                                                                  |
| 5    | 同上：`persists wrong attempts and invalidates the code after five failures`；`allows the correct code on the fifth attempt`。                                                                                                                                                                                     |
| 6    | 同上：`sends an already-registered notice without creating a code`。                                                                                                                                                                                                                                               |
| 7    | 同上：`silently limits normalized email to five sends per hour`；`silently limits an IP to thirty sends per hour`。                                                                                                                                                                                                |
| 8    | `tests/unit/config.test.ts`: `rejects required verification without %s`，分别缺 RESEND_API_KEY / EMAIL_FROM；`defaults verification off and mail locale to English`；`accepts required verification with mail configured and rejects unknown settings`。                                                           |
| 9    | `tests/services/mail.test.ts`: `preserves every byte of the default English reset message`；`sends Chinese text and HTML for %s`（三封）；`defaults new email messages to English for %s`（两封）。HTTP 补充 `passes the configured Chinese locale to signup, notice and recovery emails`。所有发信均 mock fetch。 |
| 10   | `tests/migrations/0072-email-signup-codes.test.ts`: `applies on a clean database and is reentrant without changing existing codes`；使用与 0065 相同的 pg-mem 迁移 seam。                                                                                                                                          |

补充 HTTP 检查：`checks body and signup policy before verification`、`returns 204 when mail fails or remains pending`、`returns AUTH_EMAIL_TAKEN if the email is claimed after code issuance`。

### 测试与审查证据

- 先写四处测试、再实现。红阶段：4 个测试文件失败，`Tests 25 failed | 24 passed (49)`，日志 `/tmp/meetpr-048-red.log`；包括缺失迁移/邮件导出及未实现配置行为。之后增补兼容和边界检查。
- 定向命令：`pnpm exec vitest run tests/auth/email-signup-verification.test.ts tests/auth/global-identity.test.ts tests/auth/email-recovery.test.ts tests/services/mail.test.ts tests/unit/config.test.ts tests/migrations/0072-email-signup-codes.test.ts`。
- 定向结果：`Test Files 6 passed (6)`；`Tests 105 passed (105)`；日志 `/tmp/meetpr-048-targeted.log`。
- 独立只读 code-review：Standards 0 项确定问题；Spec 0 项确定问题。审查不等于验收。仓内缺 `docs/agents/issue-tracker.md`，本次使用已明确提供的 SPEC，不依赖 tracker；如启用 tracker 工作流，需 David 先运行 `/setup-matt-pocock-skills`。
  最终自检（2026-10-10，本地结果，非 CI）：

| 命令             | 退出码 | 最后一条非空结果行（原文）                             | 日志行数 |
| ---------------- | ------ | ------------------------------------------------------ | -------- |
| `pnpm lint`      | 0      | `> eslint .`                                           | 4        |
| `pnpm typecheck` | 0      | `> tsc --noEmit`                                       | 4        |
| `pnpm test`      | 1      | `ELIFECYCLE  Test failed. See above for more details.` | 23053    |

- 全量测试原始摘要：`Test Files 51 failed | 104 passed (155)`；`Tests 553 failed | 639 passed (1192)`；`Errors 548 errors`。未达到全绿，不能声称验收 1 的“所有现有测试全绿”已证实。
- 失败根因分类：`listen EPERM: operation not permitted 0.0.0.0` / `127.0.0.1`，以及监听未成功引发的 `Cannot read properties of null (reading 'port')`。以下 51 个文件中的受影响用例因沙箱无法监听端口，未能完成有效执行；未修改旧测试断言或跳过用例。全部逐例失败名和原始栈在 `/tmp/meetpr-048-final-test.log`。
- 本轮全量中的目标 6 个文件全部通过（18 + 45 + 8 + 8 + 25 + 1 = 105 条）；英文重置信和既有 global/email recovery 测试保持通过。
- 首轮 lint 发现新增测试的 7 个语法风格问题，已修复后重跑完整三条命令。最终 lint/typecheck 均退出 0。改动源码与测试的 Prettier 检查通过；`git diff --check` 通过。

<details>
<summary>全量测试中受环境限制的 51 个文件</summary>

```text
src/realtime/upgrade.test.ts
tests/activity-ledger.test.ts
tests/admin.test.ts
tests/auth/auth.test.ts
tests/bind-requests.test.ts
tests/chat-messages.test.ts
tests/chat-set-ref.test.ts
tests/chat-uploads.test.ts
tests/coach-bind-requests.test.ts
tests/coach-rpe.test.ts
tests/coach-students.test.ts
tests/conversations.test.ts
tests/devices-api.test.ts
tests/dto/snake-case-validation.test.ts
tests/evaluation-summary.test.ts
tests/evaluations.test.ts
tests/events-feedback.test.ts
tests/events.test.ts
tests/exercise-crud.test.ts
tests/exercise-stats.test.ts
tests/exercise-usage.test.ts
tests/feedback-fetch.test.ts
tests/feedback-mark-read.test.ts
tests/feedback-post.test.ts
tests/invite-codes.test.ts
tests/onboarding.test.ts
tests/plans/imported-history.test.ts
tests/plans/plan-exercise-mutability.test.ts
tests/plans/plan-intensity-api.test.ts
tests/plans/plans-batch.test.ts
tests/plans/plans.test.ts
tests/plans/sequence-progression.test.ts
tests/readiness.test.ts
tests/realtime-chat.test.ts
tests/response-compression.test.ts
tests/reviews.test.ts
tests/sets-fetch.test.ts
tests/sets-log.test.ts
tests/signals-api.test.ts
tests/smoke/routes.test.ts
tests/student-videos.test.ts
tests/training-streak-api.test.ts
tests/unit/app.test.ts
tests/uploads-abort.test.ts
tests/uploads-complete.test.ts
tests/uploads-delete.test.ts
tests/uploads-initiate.test.ts
tests/uploads-not-configured.test.ts
tests/uploads-url.test.ts
tests/user-timezone.test.ts
tests/video-markers.test.ts
```

</details>

### 未决项与验证边界

- SPEC 文件仍是 `Status: Draft`，与仓启动规约要求 `InProgress` 不一致。本次按 David 明确的 §1–4 / 验收 1–10 实装授权执行，不擅改 SPEC 状态，交 Opus 收货时同步。
- SPEC 同时描述新增 code 格式与 off 时忽略 code；实现采用 off 完全忽略任何 code 值、required 才校验六位格式。符合本卡 legacy 优先约束，无新增产品取舍。
- 契约细节待 Opus 核对：SPEC 对 `/register/code` 写“其余一律 204”，未单列无效 email。实现沿用既有邮件接口的 400 validation envelope，仅有效请求走 204 分支。未修改手机号登录或存量账号验证状态。
- pg-mem 不提供真实 advisory lock / rollback 语义；测试中显式注册无操作锁函数，因此 105 条通过不能证明真实 PostgreSQL 并发串行化、唯一冲突回滚。没有连接真实业务库。收货/上线前仍需可用 PostgreSQL 环境的并发与回滚验证。
- 0072 未完成远端刷新确认；§5/§6 与验收 11/12 按任务排除，不是本卡漏项。除上述无效 email 响应解释外，无其他需要新增产品决策的确定缺口。

### 返修第 1 轮

- 收货依据：David 转述 Opus 已在沙箱外确认上一轮 `pnpm lint` / `pnpm typecheck` 退出 0，全量 155 文件 / 1192 条通过；这是外部收货结果，不冒充本轮本地执行。启动时再次在指定工作树试写并删除临时文件，输出 `WRITE_CHECK_OK`。在既有未提交交付上仅作以下三项返修，未 commit、push 或开 PR。
- 第 1 项：`db/migrations/0072-email-signup-codes.sql` 增加用途、纯新增与回滚方式的中文头注释，按 `BEGIN;` → `SET search_path TO public;` → 原 DDL → `COMMIT;` 包装；列、类型、默认值与索引定义逐字保留。对应既有迁移测试 `applies on a clean database and is reentrant without changing existing codes`。
- 第 2 项：`src/routes/auth/global.ts` 的 off 前置中间件采用 `next('router'); return;`。当前挂载结构中会退出 global identity router，经父 auth router 落到应用统一 `notFound`，没有自行拼响应。测试 `keeps legacy registration unverified and ignores code when off; code endpoint is 404` 同时请求 `/auth/no-such-signup-route` 和关闭的端点，比较状态码与完整 body。因统一 notFound 本身包含实际请求 `path`，先分别断言各自 path 正确，再归一化该字段比较完整信封；统一处理器未改动。
- 第 3 项：body 校验与 `signupError` 之后、`bcrypt.hash` 之前，required 且缺 code 直接返回 `401 AUTH_INVALID_SIGNUP_CODE`。有 code 的路径顺序和事务保持不变。新增测试 `rejects a missing signup code before hashing the password`，spy 断言 bcrypt.hash 未调用，同时断言 401 信封和库内无用户；finally 恢复 spy。
- 红阶段：只补测试运行 HTTP 文件，`Test Files 1 failed (1)`，`Tests 2 failed | 17 passed (19)`；分别证实原 off 返回空 body、缺码仍调用 hash。之后修改实现。
- 本轮只读双轴审查：Standards / Spec 均无确定问题。advisory lock、限速、邮件文案、配置、类型均未修改；未读取环境或凭证文件。
- 本轮自检（均退出 0）：`pnpm lint` 最后非空行 `> eslint .`；`pnpm typecheck` 最后非空行 `> tsc --noEmit`。
- 定向命令：`pnpm exec vitest run tests/auth/email-signup-verification.test.ts tests/auth/global-identity.test.ts tests/auth/email-recovery.test.ts tests/services/mail.test.ts tests/unit/config.test.ts tests/migrations/0072-email-signup-codes.test.ts`。结果原文：`Test Files 6 passed (6)`；`Tests 106 passed (106)`；退出 0。
- 改动的 TypeScript 文件通过 Prettier 检查；`git diff --check` 通过。本轮临时自检日志在摘录结果后删除。
- 全量测试本轮未重跑：沙箱禁止监听端口的限制已知，由 Opus 在沙箱外重跑；本轮仅报告实际执行的 lint、typecheck 和指定六文件定向测试。

## Spec 050 · 学员自加记录（2026-10-13）

### 开工与范围

- 首个命令在指定工作树试写并删除临时文件，退出 0。分支 `feat/050-student-added-logs`，初始工作区干净；按 CARD 不 commit/push/开 PR，不读环境文件、不连真实数据库、不加依赖。依赖已由派工方安装，未重装。已读 CONTEXT、AGENTS、CLAUDE、FOLLOWUPS、完整 SPEC/CARD、最近 15 条提交与本 JOURNAL；FOLLOWUPS 无本卡触发项。
- GitHub CLI 原始阻断：`proxyconnect tcp: dial tcp 127.0.0.1:18083: connect: operation not permitted`。改用已连接 GitHub 的只读 API，确认 staging 为 `0c2304289f3e21eabe6868d6fd66bdca183b444a`，迁移最高 0072；20 个 open PR 的 files 列表全部少于 100 项，无遗漏分页、无 0074。占号：#294=0073、#289=0071、#267=0069、#110=0050、#95=0047、#79=0039/0043、#77=0043；其余 #288/#281/#280/#272/#227/#147/#138/#134/#131/#107/#106/#36/#15 无迁移。采用 0074。
- 开工基线 lint/typecheck 通过。基线全量 `pnpm test`：`Test Files 51 failed | 104 passed (155)`，`Tests 553 failed | 640 passed (1193)`，`Errors 548 errors`；失败包含沙箱 `listen EPERM` 与监听失败派生的空 address.port。后续按 David 补充指令不再跑全量；本地验证不等同 CI、真实 PostgreSQL 或产品验收。
- 开始时发现没有视频也可以填 coach_rpe，提出后暂停 DELETE 分支。Opus 裁决并提交 `555225f`，David 明确转达：非空 coach_rpe → `SET_HAS_COACH_FEEDBACK`，按 404 → 非自加 → 附件/聊天 → 教练反馈顺序。已重读更新 SPEC/CARD 与当前 diff；该问题已决，无待裁决产品问题。

### 删除前 set_logs 引用清单

| 谁引用它                                                                                                      | 删除时怎么处理                                                                                       | 依据                                                                                         |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `attachments.set_log_id`                                                                                      | 任意仍挂接的附件（含上传中、失败等状态）均拒绝，`SET_HAS_ATTACHMENT`；不依赖 FK 的 SET NULL 自动脱钩 | 0015 唯一指向 set_logs 的数据库 FK，ON DELETE SET NULL；uploads 写入路径                     |
| `messages.set_ref.set_log_id`                                                                                 | JSON 组卡片引用拒绝，`SET_HAS_ATTACHMENT`；含已撤回但仍存快照的行；写聊天引用时锁源行，与删除锁互斥  | 0051、domain/set-ref.ts、conversations 路由；不是 FK，必须显式保护                           |
| `feedback.video_id`、`video_markers.video_id` 与 marker 的 annotation `attachment_id`、视频 `coach_viewed_at` | 通过附件门统一 `SET_HAS_ATTACHMENT`；保留反馈、标记、截图和已看状态                                  | feedback-fetch 经附件 JOIN set_logs；0054/0055、uploads/videos 路由                          |
| `set_logs.coach_rpe`                                                                                          | 非空（含 0）拒绝，`SET_HAS_COACH_FEEDBACK`；保留整行                                                 | 0052、updateCoachRpe；写 completed:false 不修改 coach_rpe；555225f 与 David 裁决             |
| 动作级/日级 `feedback.plan_exercise_id` / `day_date`                                                          | 不指向特定组；删组不删除计划动作或训练日，反馈完整保留                                               | feedback-fetch/types/迁移；不存在另一个直接组级反馈外键                                      |
| `student_events.payload.set_log_id`、PR dedup key；`student_signals.payload` 与推送派生快照                   | 保留历史事实快照，不清理 PR 事件/信号；无 set_logs FK                                                | detectSetLogPr：completed:false 直接返回，不撤销历史事件；0041 的 payload/dedup 为 JSON/文本 |
| `training_sessions` / session 事件、日完成记录、session_reviews                                               | 保留已有结算/事件/时钟，不自行撤销；均按学员日期/训练日关联，没有组 FK                               | activity-ledger：completed 状态单调保留；plans 显式完成与撤销；0032/0041                     |
| e1RM、历史、统计、追踪、摘要、missed-training                                                                 | 查询现存行或计划日完成事实，无组外键或必须删除的缓存；删除后实时聚合自然排除该行                     | exercise-stats、evaluation-summary、activity-settlement 与计划读取路径                       |

结论：库内直接入向 FK 只有 attachments；聊天为必须保护的 JSON 逻辑引用。教练内容映射：附件/聊天/视频反馈/视频标记及截图 → `SET_HAS_ATTACHMENT`；直接组级 coach_rpe → `SET_HAS_COACH_FEEDBACK`。动作/日级反馈不附着于被删行，保留其父对象即可。PR 快照不是教练填写内容，依 SPEC 保留，不能把历史 JSON 快照误称数据库悬挂外键。

### 实现与其余读取口径核对

- `0074-student-added-logs.sql`：新增可空训练日 FK、`CHECK (plan_day_id IS NULL OR adhoc)` 和部分索引，原 adhoc 唯一索引不动；BEGIN/COMMIT 包住全部 DDL，尾注回滚不删组。为了原 SQL 可在 pg-mem 重入测试，列与 CHECK 分开声明，事务内 DROP IF EXISTS/ADD 同名 CHECK；曾试内联 CHECK，pg-mem 报 `Corrupted alias`，已调整 SQL，未跳过约束断言。
- adhoc 写入：先验证本人 published 训练日；更新语句将 plan_day_id 纳入 WHERE，插入不改幂等键，23505 后仍走原回退更新，再辨认不匹配归属并返回 409。不包整条 upsert 为事务；不改 coached 写入。大小写 UUID 仍按数据库 UUID 语义比较。
- 删除：事务内先锁本人 set row，按裁决顺序检查；成功只删除记录本身。聊天创建 logged 组卡片新增源行 `FOR KEY SHARE`，与 DELETE 的 `FOR UPDATE` 互斥，防止聊天 JSON 引用在检查后才落地；附件外键插入和已有 coach_rpe 写入也与此锁协调。此处为工程并发保护，不改变聊天 wire 契约。
- 教练读取保留原 plan 查询，只有 scope=all 才并入本人发布计划训练日的 adhoc；两路径序列化均增加 nullable plan_day_id。没有新建 `/sets` GET 路由，沿用仓内真实路径 `GET /students/:id/sets`（SPEC 的 GET /sets 是简称）。
- `sessionProgress` 是唯一处方完成口径；只累计 `set_index < 当前处方组数` 的有效提交，activity-ledger 两处调用方仅补 select 的 set_index。零处方既有语义及原断言不改。

| 读取接口/逻辑                                          | 额外组核对结论                                                                                                                    | 依据与处理                                                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 学员/教练 sets 历史                                    | 按行返回 set_index，无处方数组定位；额外组保持可读                                                                                | sets-fetch；旧 6 条读取测试通过                                                                                               |
| 教练 `/students/:id/exercise-stats?exercise_id=…` 明细 | recent_sessions 按实际 set_index 排序，by_set_count 按实际记录数分桶，不用序号索引处方                                            | exercise-stats 的 fetchExerciseStatsDetail/groupedSessions；无需改动                                                          |
| 同接口不带 exercise_id 的统计概览、e1RM、追踪看板      | 重量/次数/RPE/容量遍历实际行；repDistribution 索引来自 reps 并有界，不来自 set_index；trained_days 按日期去重，与处方组完成无混用 | fetchExerciseStatsOverview/buildTrackingAggregates/buildE1RMSeries/buildWeeklyVolume；无需改动，不把新 adhoc 暴露扩到这些接口 |
| 计划摘要/计划树                                        | 处方数量由 plan_sets 得到；没有拿实际记录的 set_index 去读取处方数组                                                              | plans/index 的摘要与树装配；无需改动                                                                                          |
| evaluation-summary                                     | 读写独立评价与版本表，不按组索引；删除组不会移除评价内容                                                                          | evaluation-summary；无需改动                                                                                                  |
| missed-training                                        | 按 logged_date 判断是否开始，assumed=false；既不以记录数充当处方完成，也不按 set_index 对齐                                       | activity-settlement 的 autoResolveCurrentDay/startedRows；原定向测试通过，无需改动                                            |
| 活动台账/超时结算                                      | 处方完成统一调用 sessionProgress；原事件/时钟/显式完成语义保留                                                                    | 两个生产调用点已全部补 set_index；activity-ledger 14 条原测试通过                                                             |

未发现上述其他接口需要修复的越界或错位，因此没有额外改动统计/看板产品口径。

### 先红后绿证据

全部新增行为沿 CARD 已批准的四类 seam 逐项推进，没有改既有测试断言。`sets-log`、`sets-fetch`、`chat-set-ref`、`activity-ledger`、`plans/sequence-progression` 五个旧路由测试文件仅把 supertest import 换成仓内已有 `inMemoryRequest`；仍走完整 Express HTTP 路由、认证及数据库，不监听端口。原 sessionProgress 测试只补必需的 set_index 输入。

| 切片              | 红阶段原始摘要/原因                                                                                | 绿阶段                                                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 迁移              | `Tests 1 failed (1)`，0074 文件不存在（ENOENT）                                                    | `Tests 1 passed (1)`                                                                                                                                                           |
| 处方完成          | `Tests 1 failed \| 5 passed (6)`，缺第三处方组却得到 true                                          | `Tests 6 passed (6)`                                                                                                                                                           |
| 自加动作写入/读回 | `Tests 1 failed (1)`，新字段被拒 400 而预期 201                                                    | `Tests 1 passed (1)`                                                                                                                                                           |
| 训练日权限        | `Tests 3 failed \| 1 passed (4)`，他人/草稿被接收，缺失日未映射业务码                              | `Tests 4 passed (4)`                                                                                                                                                           |
| 幂等归属          | `Tests 4 failed \| 4 passed (8)`，不同归属请求未返回 409                                           | `Tests 8 passed (8)`                                                                                                                                                           |
| 教练 all scope    | `Tests 1 failed \| 8 passed (9)`，缺自加动作行                                                     | `Tests 9 passed (9)`                                                                                                                                                           |
| DELETE 主路径     | `Tests 2 failed \| 9 passed (11)`，尚无删除路由，预期 204 得 404                                   | `Tests 11 passed (11)`                                                                                                                                                         |
| DELETE 可删类型   | `Tests 4 failed \| 12 passed (16)`，处方/assumed/纯 adhoc/脱钩行被删                               | `Tests 16 passed (16)`                                                                                                                                                         |
| 教练内容保护      | `Tests 4 failed \| 17 passed (21)`；视频/两种教练 RPE 未拦截，聊天夹具另报不存在的 client_msg_id   | 修正新夹具为实际 client_id；单独移除聊天门验证 `protects chat` 红：`Tests 1 failed \| 20 skipped (21)`，错误码落到 SET_HAS_COACH_FEEDBACK；恢复聊天门后 `Tests 21 passed (21)` |
| 既有行为回归      | 乱序结算无需改生产代码，新增回归首次即绿，不伪造红阶段；同样记录 self-train 删除和 PR 快照保持行为 | plans 文件 `Tests 18 passed (18)`；sets 新文件 `Tests 23 passed (23)`                                                                                                          |

原始日志在本机 `/tmp/050-*-red.log` 与 `/tmp/050-*-green.log`；乱序 `/tmp/050-order.log`、派生记录 `/tmp/050-derived.log`。静态检查初次发现新增测试 fixture 类型/风格错误，已修复；不修改旧断言消除失败。

### 验收清单到测试名

| SPEC 项          | 测试文件与名称                                                                                                                                                                                                                                                                                                                                                                                                                                    | 本地结果/边界                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1 迁移与存量     | `tests/migrations/0074-student-added-logs.test.ts`：`applies to empty and existing tables, is reentrant, and detaches deleted days`                                                                                                                                                                                                                                                                                                               | pg-mem 通过，涵盖空表/存量 NULL/重入/FK/CHECK/删除训练日脱钩；未连真实 PostgreSQL    |
| 2 写入权限和冲突 | `tests/sets-student-added.test.ts`：`writes and reads an added exercise on the student published day`；`rejects a %s day without creating a log`（other student/draft/missing）；`rejects %s rebinding without changing the row`（day to day/day to null/null to day）；`keeps same-day replay idempotent and does not rebind racing inserts`                                                                                                     | 全部通过；Promise.all 验证内存环境并发请求，不代表 PostgreSQL 真实锁竞争实测         |
| 3 老写入兼容     | `tests/sets-log.test.ts` 原 25 条，包括 `logs an adhoc set for a self-train student and upserts idempotently`、`preserves logged_date when an old-build coached upsert edits a historical set`                                                                                                                                                                                                                                                    | 原断言全部保留并通过                                                                 |
| 4 删除           | sets 新文件：`deletes an owned %s and returns 404 on replay`；`rejects %s rows unchanged`；`checks ownership before eligibility and forbids coach deletion`；`protects %s with ordered errors and preserves related rows`（video/chat/coach rpe/zero coach rpe/prescribed with video）；`allows the self-train owner to delete an added exercise on their published plan`；`preserves PR event and signal snapshots like writing completed false` | 全部通过；覆盖附件、聊天、视频反馈/标记和 RPE 不变，含重复删除 404                   |
| 5 读取兼容和隔离 | sets 新文件：`adds only own published-plan days under all and keeps default identical to plan`；`tests/sets-fetch.test.ts` 原 6 条                                                                                                                                                                                                                                                                                                                | 全部通过；默认与显式 plan 比较原始 response.text，相异教练/草稿/他人/纯 adhoc 不泄漏 |
| 6 额外组不替处方 | `tests/sequence-progression-auto.test.ts`：`does not let an extra set replace a missing prescribed set`                                                                                                                                                                                                                                                                                                                                           | 3 处方提交 0/1/3 → false，0/1/2/3/4 → true；原 5 条也通过                            |
| 7 乱序结算       | `tests/plans/sequence-progression.test.ts`：`settles D4 before D2, keeps the earliest unfinished cursor, and only undoes the latest completion`                                                                                                                                                                                                                                                                                                   | 通过；各步按 API 返回训练日计算最早未完成日，无新增服务端游标实现                    |
| 8 gates          | lint/typecheck/format 与下述 12 文件定向命令                                                                                                                                                                                                                                                                                                                                                                                                      | 本地自检见末表；全量测试按沙箱限制不重跑，不能宣布本项完整验收通过                   |

### 独立审查与验证边界

- code-review 两个只读子代理，以未提交 diff 相对 `HEAD=555225f` 加新增文件审查。Standards：0 确定代码问题；Spec：0 确定实现问题。Standards 指出的本节信号表名笔误已更正为 student_signals。review 不等于 Opus 收货终审。
- 已直接给定 SPEC/CARD，不依赖缺失的 `docs/agents/issue-tracker.md`；本卡没有启用 tracker 工作流，也没有私建配置。
- 未运行真实数据库迁移/锁竞争、真实部署、iOS 1.0(23) 教练/学员 demo；这些不能由 pg-mem 或代码审查代替。全量 suite 在开工时因沙箱监听被阻断，收到续行约束后未再运行。未 commit/push/开 PR，SPEC/CONTEXT/MIGRATIONS-APPLIED 未编辑。产品裁决全部已落实，无仍待决定事项。
- 定向命令（退出 0）：

```sh
pnpm exec vitest run tests/migrations/0074-student-added-logs.test.ts tests/migrations/0031-adhoc-set-logs.test.ts tests/sets-student-added.test.ts tests/sets-log.test.ts tests/sets-fetch.test.ts tests/sequence-progression-auto.test.ts tests/plans/sequence-progression.test.ts tests/activity-ledger.test.ts tests/chat-set-ref.test.ts tests/pr-detection.test.ts tests/activity-settlement.test.ts tests/sequence-progression-backfill.test.ts
```

- 定向原始结果：`Test Files 12 passed (12)`；`Tests 142 passed (142)`。最后非空结果行：`Duration  2.80s (transform 627ms, setup 80ms, collect 6.34s, tests 12.32s, environment 1ms, prepare 583ms)`。日志 `/tmp/050-final-targeted.log`。

最终静态自检（均退出 0，原始最后非空结果行）：

| 命令                | 最后结果行                                   |
| ------------------- | -------------------------------------------- |
| `pnpm lint`         | `> eslint .`                                 |
| `pnpm typecheck`    | `> tsc --noEmit`                             |
| `pnpm format:check` | `All matched files use Prettier code style!` |

`git diff --check` 通过。额外逐字核对：JOURNAL 原有前缀完整保留，只新增本卡一个节；SPEC、CONTEXT、MIGRATIONS-APPLIED 相对 HEAD 无 diff。未提交文件就是本卡交付，全部留在指定工作树内。

## 2026-10-17 · Spec 093 卡 B（本地自检与独立审查完成，国内部署待执行）

### 范围与现场

- 按 David 提供的 CARDS/SPEC 开发，SPEC 为完整口径；IOS-HANDOFF 未使用。唯一写者在 `feat/093-coach-onboarding`，base `9f0e735`（现场 origin/staging），没有合并/commit/push/部署。
- 开工检查 worktree/status/log、仓规/CONTEXT/FOLLOWUPS、engineering-workflow、impl-wave、tdd。基线 typecheck/lint/test 通过，157 文件/1219 测试。已核对 open PR：0071（#289）、0073（#294）已被占，staging 最新 0074，本卡取 0075。
- B0 运维由主会话记录；本卡不读取或保存真实账号、邮箱、电话、备份或凭证。

### 实装

- B1：`coach_applications` + 公开申请，姓名/邮箱/可选联系方式/人数/设备校验；IP 30 次/小时、规范化邮箱 5 次/小时；中文确认信。按 SPEC §3.1 全状态同邮箱唯一（CARDS 的 pending-only 描述更窄），重复返回 `COACH_APPLICATION_EXISTS`，不再生成第二条。
- B2：live admin 角色复核后的列表/通过/拒绝/重发。通过时在同一 DB 事务创建用户、邮箱身份、显示名、永久邀请码、7 天 setup token 与审批记录。现有用户表密码 NOT NULL，因此用不可供 bcrypt 登录的标记表示尚未设置密码，不改用户表。已注册学员返回 `COACH_APPLICATION_EMAIL_IS_STUDENT`，其余已占用账号返回 `COACH_APPLICATION_EMAIL_EXISTS`，不转角色、不覆盖原账号。
- 邮件在 DB 提交后发送：网络副作用无法加入 PG 事务。返回 `receipt_email_sent`/`welcome_email_sent`/`result_email_sent=false` 明示投递失败；管理员和公开重发可以恢复。欢迎信严格按「设置密码 → 安装 App → 邀请学员」排列，后两项指向欢迎页锚点；拒绝结果也发邮件。未调用真实邮件服务。
- B3：复用 `password_reset_codes`、`/auth/email/reset` 与原密码/会话撤销函数，0075 加 `purpose`，旧行默认 `password_reset`。setup token 为 256-bit 随机值、只存摘要、7 天有效、单次使用；旧六位码输入保持兼容且不会消耗 setup token。密码设置完成撤销全部未用 reset/setup 令牌；锁顺序统一为 user → code，避免重发/设密倒序锁。
- B4：`GET /public/invites/:code` 限速 60 次/分钟、不消费次数，只返回 `{valid,coach_display_name}`；被撤销/过期/用尽/不存在均 false/null。只认仍为 coach 的拥有者。
- B5：events 接受 `platform=web` 及五种入驻漏斗事件；属性仍严格枚举，不收自由文本。W0：admin users/list/detail 加 `email:string|null`，原 phone 可 null；搜索仍在前端。
- 新功能只在 `COACH_ONBOARDING_ENABLED=true` 时启用。仅精确三个 HTML SPA 入口 `/coach`、`/coach/set-password`、`/coach/welcome` 绕过 coach API 认证；JSON 请求及其余 coach API 不绕过。欢迎信凭据放 URL fragment，不进入浏览器 HTTP 请求和访问日志。

### 给 W 的 API 契约

- `POST /coach-applications`：`{name,email,contact?,student_count,device}`；device 为 `iphone|android|both`，人数整数 0–100000。201 `{id,status:'pending',receipt_email_sent}`；重复 409 `COACH_APPLICATION_EXISTS`；校验 400；限速 429。
- `GET /admin/coach-applications`：`{applications:[{id,name,email,contact,student_count,device,status,user_id,reviewed_by,reviewed_at,created_at}]}`。管理员 `POST /:id/approve|reject|resend` 挂在此路径下。approve 返回 `{id,status,user_id,welcome_email_sent}`；reject 返回 `{id,status,result_email_sent}`；resend 返回对应邮件的 sent 布尔字段。已审批状态再次审批返回 409 `COACH_APPLICATION_REVIEWED`；设置完成后重发返回 409 `COACH_SETUP_COMPLETE`。
- `POST /coach-applications/resend {email}`：统一 204，按邮箱/IP 限速且超限静默；pending 重发确认信，rejected 重发结果，approved 且未设密码重发欢迎信。不存在/已完成不发送。
- 欢迎信 `/coach/set-password#email=...&token=...`；页面读取 fragment 后 `POST /auth/email/reset {email,token,newPassword}`。成功 204，随后调用既有 email/login 获取会话。过期/无效 401 `AUTH_INVALID_RESET_CODE`；密码沿用 8 字符至 72 UTF-8 字节规则。
- 欢迎页 `/coach/welcome#install` 与 `#invite`；当前永久码用已有认证 `GET /coach/invite-codes`，避免返回旧码。
- events 新 name：`coach_application_submitted`、`coach_application_approved`、`coach_password_set`（props 空对象）；`invite_landing_open` 的 props `{device:iphone|android|desktop,in_wechat:boolean}`；`install_clicked` 的 props `{device:iphone|android}`。沿用已有 batch envelope。

### 验证、红绿与边界

- API/邮件边界定向测试：4 文件，68 passed / 1 skipped。全量：158 文件，1236 passed / 1 skipped。skip 是仅真实 PG 启用的事务竞争/回滚用例，不是未验证。
- 本地独立 Docker PostgreSQL 18（仅 loopback、合成数据）跑同一 API suite：16/16 通过；每例从空 schema 建立依赖迁移，0075 连续执行两次，覆盖干净执行与重入。真实 PG 额外验证双审批竞争只成功一次、在创建账号后注入 DB 异常整笔回滚、移除故障后可重新通过。并非 RDS 实测。
- 红阶段原始日志见 evidence：申请入口 404→201；setup 输入拒绝→成功登录；公开重发/查码缺入口；web platform 拒绝及 admin 无 email；旧六位码耗尽 setup token；确认信失败无法重发；拒绝后重复创建；拒绝无邮件；HTML `/coach` 被认证拦截。审批测试最初因错误的 NULL 密码 fixture 先失败，修正夹具时该切片实现已存在，所以不将其声称为有效的 API 先红证据。新增只验证既有能力的回归有首次即绿的情况。
- typecheck、lint、format:check、build 均通过；lint 初次发现本卡 non-null assertion/格式问题，已修复，随后重跑 auth/onboarding 定向与真实 PG。完整原始输出在 `docs/evidence/spec093-2026-10-17/`。
- 未验：国内 RDS 0075、staging 镜像部署、真实发信收信、真实浏览器新 W 页面、国内完整 curl 入驻链路、Global 实际部署。没有运行这些步骤，也没有宣布功能验收通过。

### 部署交接（未执行）

1. 按既有 runbook 备份国内库，执行 0075（包含 public search_path）；不得跳过数据操作授权。
2. 部署本卡镜像，保持 Global 不动。CN 增加 `COACH_ONBOARDING_ENABLED=true` 与 `COACH_ONBOARDING_URL`（当前站点 origin）；沿用已配置 Resend 发件人/API key。loadConfig 在开启 gate 时要求这三项齐备。
3. W 发布后由主会话用授权真实邮箱走申请→审批→收信→设密→登录→公开查码，留 RDS/部署/HTTP/收信证据。外部用户入驻放行仍受 SPEC 的 iOS CN 邮箱包前置约束。
4. 回退关闭 gate/回退镜像，保留新增表、申请、邮箱身份与邀请数据；不删表或回滚用户数据。完整收货与合并由 David/Opus 决定。

### 主代理独立复审

- 固定基线 `9f0e735`，两名只读 reviewer 分别审 Standards 与 Spec，独立上下文、未交换结论，执行时间有重叠。Standards：0 finding；Spec：0 阻断 finding，一轮无代码返修。
- 主代理亲读全部新增源码、迁移、测试及最终 diff，核对原始门禁和真实本地 PG 输出。邮件在提交后发送并保留可重发结果；0075 为新增表/列，回退保留数据。
- 国内库未执行 0075，PR 等 David 合并；合并后还需备份、迁移、镜像与配置核验、真实链路证据。B0 的补邮箱批准与执行记录属于单独卡，不冒充本次 0075 已获批或已应用。W 仍按用户顺序等待 B 部署后开工。

## 2026-10-17 · Spec 093 同源网页部署候选（未部署）

将 plan-web `594c9201fceb45e563f1a33ce77f8699819095d1`（W PR #110，含 W0 #109）以 `VITE_API_BASE='' VITE_CN_TESTFLIGHT_URL='' VITE_CN_ANDROID_URL='' npm run build` 构建，换入本分支 `web/`。入口 `assets/index-DcBIb7BC.js`；SHA-256 `94f403464b053e1352dcf464278aa37c7a8176f32e5a94a26f53c3ace6c7386c`。静态产物均与源 dist 逐文件哈希一致，空同源 base 标记通过、未带 localhost fixture 安装地址。安装配置尚空，页面显示安装未开放；不能把此候选当成真实下载开放。

定向 `pnpm exec vitest run tests/coach-applications.test.ts`：15 passed / 1 skipped，含三条教练 HTML SPA fallback；真实 PG 事务用例此前独立 16/16。本次只换已审 W/W0 的构建产物，无后端源码变更。原始构建清单和本轮日志在仓外部署审查目录。0075、新镜像与 SAE 配置均未执行；等待全部代码完成后的统一批准，PR 不合并。

## 2026-10-17 · Spec 093 合并前未设密登录回归

David 直驱：新增公开 API 回归，申请并审批成功后，邮箱登录返回 401 / AUTH_INVALID_CREDENTIALS；通过欢迎信令牌设置密码后，同一凭证登录成功且用户 ID 与审批回包一致。使用真实 bcrypt，邮件只走本地 mock。临时移除密码比较后新测试以「expected 200 to be 401」失败，恢复源码后定向 16 passed / 1 skipped；生产代码无变化。

安装依赖、typecheck、lint、format:check、build 通过。初次基线全量有既有 plan exercise 删除 400/204 失败，独立重跑通过；增量全量在并行负载下有 3 条 5000ms 超时，单 worker 重跑为 158 文件 / 1237 passed / 1 skipped。skip 为既有真实 PostgreSQL 专用事务用例，本次未重复启动真实 PG。完整原始证据在本机 `/Users/david/Projects/scratch/spec093-closeout-20261017/`。独立 review-loop：Standards 0、Spec 0。未合并、未迁移、未部署、未触碰真实账号。

## 2026-10-17 — spec 093 B0：两个老账号补邮箱身份

- 交付范围：spec 048 §5 数据操作；本分支从 `origin/staging@9f0e735` 建独立 worktree，仅补执行事实记录。用户批准之前未对国内库执行写入。
- 先由 David 在 DMS 运行只读查询：目标身份对应两个非测试老账号；目标邮箱占用查询为 0 行。备份含两行 users、0 行 user_identities。用户提供的完整备份已存仓库外私有目录（目录 0700、文件 0600）；脚本、备份和截图均不入公开仓。
- 用户审阅脚本/备份并明确回复“同意”后，David 在 DMS 执行原子写入脚本。后验截图确认两条 email 身份与 verified=true，原手机号尾号保持不变。随后用户确认两个账号的邮箱登录、手机号登录和原数据均通过。
- 写入脚本仅新增 email 身份、更新邮箱及验证时间，事务内对比其余 users 字段。备份哈希与完整验证边界见 [048 部署记录](deployment-048-2026-10-10.md)。本卡无代码、schema、构建产物、环境或 Global 部署改动。
- 预执行保护与回滚在 PGlite 合成数据上验证；国内 RDS 未做回滚演练、未独立实测锁竞争。真实登录验证来源为 David，不声称代理自行验证。B0 完成不等于 B/W0/R-verify/W 或功能终审完成。
- 本地交付检查：`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build` 均退出 0；全量复跑 157 文件 / 1219 测试通过。首次全量中既有 `tests/bind-requests.test.ts` 过期码断言失败（1218/1219），未改任何代码或测试；定向复跑 10/10、随后全量 1219/1219。未定位首次偶发失败根因，不声明已修复。原始日志 `/tmp/spec093-b0-test.log`、`/tmp/spec093-b0-bind-recheck.log`、`/tmp/spec093-b0-test-rerun.log`。

## 2026-10-17 · Spec 093 CN 网页下载地址发布产物（部署待执行）

David 已批准本轮国内 staging 的新全库备份、0075、两项 COACH_ONBOARDING 配置、网页换装和镜像部署。六个业务 PR 已依次合并；本提交仅将已审网页代码的部署产物换入后端，不执行数据库或 SAE 操作。

源代码：plan-web main `5c04ba442078cdc0e2bf59a93f6798753e7c2221`；与构建工作树 HEAD `fc58647` 的完整树无差异。构建环境为 `VITE_API_BASE=''`、`VITE_CN_TESTFLIGHT_URL=https://testflight.apple.com/join/aKmSgx4b`、`VITE_CN_ANDROID_URL=https://dl.meetpr.cn/android/meetpr-cn.apk`。入口 `assets/index-CO-K36rW.js`，SHA-256 `bcc89e16e5cba66d0723e99ec993515c281ac875e2377c84983380dcc9bdef49`；dist/web 全部文件哈希一致，同源 API 标记、两条安装地址与「粘贴邀请码」文案检查通过。此前同一入口构建已完成本地浏览器截图验证。

本轮 web build、backend typecheck、format:check、build 通过；coach-applications 定向 16 passed / 1 skipped，skip 为既有真实 PG 专用事务测试。未改后端源码或迁移。OSS HTTPS HEAD 校验返回 200、no-cache、65281488 字节；David 确认测试机卸载旧签名包后新包装好、TestFlight 上限已改 200。这些仅证明下载安装与控制台配置，不代表业务全链路验收。

浏览器控制连接两次超时，新的全库备份、DMS 0075 和 SAE 配置需 David 在控制台操作并提供结果；确认备份完成和迁移核对通过后才触发镜像部署。未向学员外发链接，未上传 iOS 包。

## 2026-10-17 · Bundle iPhone TestFlight guidance

David explicitly approved merge and CN staging deployment of plan-web #111. Bundle from merged web main a5611bb, built with empty VITE_API_BASE and approved CN TestFlight/Android URLs. Only generated web assets change; no new migration or environment change. Existing 0075 was verified in DMS (11 columns, 3 indexes, purpose NOT NULL default password_reset), and previous deployment 973f224 was verified by online bundle hash. Previous image is the rollback candidate for this asset-only update. Web regression 51 tests and build passed; independent Standards/Spec reviews both zero findings. Deployment verification will follow.

## 2026-10-18 · Coach welcome email and web login correction

David 现场要求欢迎页直接进入教练网页登录，并重写欢迎邮件以明确流程。邮件现在按设置密码、安装并登录 App、登录教练网页、邀请学员四步说明；保留 7 天设密有效期，提示 App/网页共用申请邮箱与密码、教练不要注册、iPhone 先装 TestFlight、学员提交后在 App「接收」确认。HTML/纯文本共用步骤内容，网页登录链接为 `/coach/login`，不附带设密 token。

同时换装 plan-web #112（源码 `3388783`，合并 `dc6dec9`）产物，确保新登录路由与邮件同时生效。构建使用同源 API、既有 CN TestFlight/APK 链接；入口 `assets/index-CWxslhdL.js` SHA-256 `f8627d92270ea73755c96250b3b4f7452a0fa72f6cb406c53e5a5d50fdbe1632`。无迁移或环境变量修改，Global 不部署。

验证：邮件回归先红后绿；backend typecheck/lint/format:check/build 通过，158 文件 / 1238 tests passed / 1 skipped；web 93 文件 / 921 tests 通过与生产构建通过。亲看浏览器登录页面和合成邮件 HTML 预览，截图 `scratch/coach-login-mail-20261018/`；未发真实测试邮件。独立 Standards / Spec 两轴均 0 findings。旧邮箱内已发送邮件内容不会随模板更新。

部署前联调发现 backend 的 `/coach` API 认证会拦住新增的 `/coach/login` 浏览器导航。已将该精确路径加入既有 onboarding 网页 router（仍受 COACH_ONBOARDING_ENABLED 门控）；回归先红 401→预期 200，修复后 HTML 导航 200、JSON/默认 Accept 401，教练数据 API 仍 401。最终全量 1238 pass / 1 skip 及 typecheck/lint/format/build 再次通过。

## 2026-10-19 · Spec 051：HTTP 验收测试已补，业务红绿受沙箱阻塞

- 工作位置固定为 `MeetPR-backend-wt-051`，分支 `feat/051-exercise-stats-filtered-history`，基线 `cd9241e`。临时文件创建、删除成功；未在主仓或其他目录施工。SPEC 仍标为 Draft，与仓规要求 InProgress 不一致；本次用户明确给出实施卡，未擅改 SPEC 状态。
- 本轮仅在 `tests/exercise-stats.test.ts` 新增 21 个 HTTP 用例，按 SPEC 验收 1–7 覆盖：完整旧响应加 video_id、最新且归属正确的 ready set_video、同日顶组/退让行区分、混合处方次数、按 logged_date 最近五条、额外组与视频、reps 单独传入及非法/边界参数。原有 15 个测试及断言未修改；不新增测试 seam。生产 handler 和 route 尚未实现。
- 环境差异：现场没有 node_modules，首次 npm test/typecheck 分别报 vitest/tsc command not found；npm ci 又报 package.json 与 package-lock.json 不同步。将本机 pnpm 缓存复制到当前 worktree 后，使用 `pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir .spec051-pnpm-store` 恢复锁定依赖，478 个包全部来自缓存。未修改任何依赖清单/锁文件，未运行会写共享 Git hooks 的安装脚本。临时缓存已删除。
- 实际执行证据：恢复依赖后的基线 `npm test` 为 736 passed / 502 failed / 1 skipped（158 文件）；新增用例后的 `npm test -- tests/exercise-stats.test.ts` 为 0 passed / 36 failed / 36 unhandled errors；最终 `npm test` 为 736 passed / 523 failed / 1 skipped（112 文件通过、46 文件失败）。HTTP 监听被当前沙箱拒绝，原始错误 `Error: listen EPERM: operation not permitted 0.0.0.0`，部分既有测试也报 127.0.0.1；Supertest 随后因 server.address() 为 null 报 reading 'port'。这些失败没有到达接口业务断言，不能作为业务红测或功能缺陷证据。
- 定向首次运行另发现新 fixture 重复使用同一处方行的 set_index 违反既有唯一约束，已改为跨日期使用不同 set_index；再次运行全部 36 条仅剩监听权限阻塞。没有为了绕过沙箱改动测试基础设施或 seam。
- `npm run typecheck`、`npm run lint`、定向 ESLint/Prettier、`git diff --check` 均通过；最终测试版本再次 typecheck 通过。独立只读 code-review：Standards 0 findings、Spec 0 findings，仅证明测试静态审查，不代表验收通过。
- 原始输出保留在当前 worktree 的忽略文件 `.spec051-baseline-test.log`、`.spec051-red-test.log`、`.spec051-final-test.log`。没有业务 red/green 证据，因此遵守“先确认业务红测再实现”的要求，停在测试阶段；验收 1–8 未通过，功能未完成。续作需要允许 HTTP 测试监听本地端口的执行环境：先运行已有新增测试确认预期业务失败，再在本卡 handler/route 范围实现，最后跑定向、全量测试与 typecheck。未 commit、push、开 PR、部署或改迁移。

## 2026-10-19 · Spec 051：接续外部红测完成实现，HTTP 绿测待 Claude 外跑

- 红测来源：David 本轮转述 Claude 已在沙箱外执行 `npx vitest run tests/exercise-stats.test.ts`，结果 36 条中 9 failed / 27 passed；失败是带 sets/reps 被旧校验返回 400，以及缺少 filtered_sessions/video_id 等业务断言。按本轮明确授权采用该证据进入实现，不重复造红测；这不是 Codex 本地实测结果。
- 本轮修改文件：`src/handlers/exercise-stats.ts`、`src/routes/exercise-stats.ts`、`docs/CODEX-JOURNAL.md`。handler 为组返回最新本人 ready set_video 的 video_id，并由其是否为空计算 has_video；两个历史列表共用组序列化。仅在 sets 有值时查询处方，按 plan_exercise_id + logged_date 形成记录，以 plan_sets 行数及全部相同的 target_reps 匹配，保留额外组，组内 set_index 升序、记录日期倒序最多五条；无匹配为空数组，无 sets 时不新增 filtered_sessions。共享日志查询只额外选出已连接的 plan_exercise_id，原统计及 overview 响应不变。
- route 对 detail 接受 sets 1–20、reps 1–50 的整数字符串，非法参数沿用 validationEnvelope 返回 400；有效 reps 单独传入只校验、不筛选。overview 保持原有严格查询校验，鉴权及归属校验不改。视频“最新”按 created_at 倒序，时间相同时用 id 倒序稳定选取。
- 测试文件本轮没有修改；36 条用例原样交接。SHA-256：`f34fbf40c1e6ec69d29e397def309818018f7f2fc7123b1cf3d6f555b32e24e9`。没有锁文件、依赖清单、迁移或其他端点改动。
- 本地验证：初次 typecheck/lint 发现路由两种 Zod 校验结果合并后过滤字段类型丢失，已显式声明校验结果的可选字段类型；修正后 `npm run typecheck` 退出 0、`npm run lint` 退出 0。两个生产文件的 Prettier check 及 `git diff --check` 均通过。独立静态 code-review：Standards 0 findings、Spec 0 findings。
- 与 SPEC 行为契约无已知出入。SPEC 文件仍为 Draft，未擅自更新状态；此前阻塞记录中的“尚未实现”已由本节取代。按本轮分工没有在沙箱重复运行 HTTP/全量测试；36 条是否全绿及 SPEC 验收 8 的全量测试仍需 Claude 在沙箱外给出实际输出，不把静态检查当作绿测或功能验收。未 commit、push、开 PR 或部署。

## 2026-10-22 · 邀请落地页分享标题（未提交，待外部 Supertest / 全量收货）

- 工作位置固定为当前 `MeetPR-backend-wt-invite-title`，分支 `fix/invite-landing-title`，HEAD 与本地 `origin/staging` 均为 `11ea46d`。依据 David 本轮实施卡及后续明确分工执行；未 commit、push 或部署，无依赖、锁文件、迁移、其他 worktree 或其他业务路由改动。
- 新增 `src/routes/invite-landing-pages.ts`，在 `src/app.ts` 的静态资源后、通用 SPA fallback 前挂载一次。仅偏好 HTML 的 `/i/:code` 请求读取并在进程内缓存原始 `web/index.html`；并发请求共享读取 Promise，读取失败清缓存并 next，保持原 fallback/notFound 行为。逐请求生成标题、description、og:title、og:description，其余页面保留，磁盘产物不改；JSON/通配符/缺省 Accept 继续 next。不查数据库，不输出教练信息。
- 字符集现场核对 `src/handlers/invite-codes.ts` 与 `src/routes/public-invites.ts` 为 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`；接受 10 位与兼容 8 位，按四位分组（4-4-2 / 4-4）。非法字符或长度不回显，使用不带码的通用描述；全部注入文本经 HTML 转义。遵守当前 worktree 边界，未读取外仓 App 的 `InviteCodeFormat.grouped` 源码；按 David 明确给定的分组契约实现。
- 在既有 `tests/unit/app.test.ts` 的 Supertest/createApp seam 新增 15 条回归，连同原 6 条共 21 条：标题与三项 head metadata、8/10 位分组、注入载荷与非法字符/9/11 位长度、Accept 协商、缺失文件与原 fallback 一致、缓存不串码、其他 SPA 路径与磁盘模板保持不变。临时 fixture 均建在当前 worktree 并逐例清理。
- 红测来源：已亲读 Opus 沙箱外生成的 `.invite-title-external-red.log`，实施前版本为 7 failed / 12 passed（19），失败均为旧 HTML 缺标题/分组邀请码，无环境错误。后补两条非法长度断言不在该次外部红测中。此前本机 Supertest 的 19 failed / 19 errors 均为 `listen EPERM`，不冒充业务红测；本机全量串行尝试同样遭监听阻断，已终止，没有完整全量结果。依赖由用户确认已安装，本轮不再安装。
- 沙箱内功能验证：为保留正式 Supertest seam，临时复制 app 测试，仅将 request import 换成既有 `tests/helpers/inMemoryRequest`，其余断言不变；与 `tests/unit/in-memory-request.test.ts`、`tests/coach-applications.test.ts` 串行执行，3 文件 / 39 passed / 1 skipped，含全部 21 条 app 断言。skip 为既有真实 PostgreSQL 专用事务测试。临时副本验证后删除；此结果不代替正式 Supertest 或全量验收。日志 `.invite-title-in-memory-test.log`。
- 首轮 lint 指出 Express 回调不能直接返回 Promise，已改为缓存读取 Promise 并显式转发异常，再跑上述 39 条通过。修正后 `pnpm typecheck`、`pnpm lint` 均退出 0；四个改动文件的 Prettier check 与 `git diff --check` 通过。静态检查日志为 `.invite-title-final-typecheck.log`、`.invite-title-final-lint.log`。
- 自审分别核对 Standards（工厂内缓存、异步错误转发、无共享单例/依赖）与 Spec（Accept、分组与白名单、HTML 转义、不查库、仅模板元信息变化），无已知范围偏离；未把自测作为 Opus 的收货结论。真实微信链接卡片、浏览器 SPA 接管、真实 PostgreSQL 与部署均未验。
- Opus 沙箱外待执行：`pnpm test -- tests/unit/app.test.ts --maxWorkers=1 --minWorkers=1`（预期 21 条）；`pnpm test -- --maxWorkers=1 --minWorkers=1`（全量串行）。当前交付为未提交实现和测试，不宣称这两项已通过。

## 2026-10-22 · 邀请落地页文案 B：教练本人邀请（未提交，待 Opus 外跑）

- 范围：当前 `MeetPR-backend-wt-invite-title` / `fix/invite-landing-title`，起点 `82e5fdb`，按 David 本轮已批准实施卡续改 PR #319。仅改 `src/app.ts`、`src/routes/invite-landing-pages.ts`、`src/routes/public-invites.ts`、新增 `src/handlers/public-invites.ts`、`tests/unit/app.test.ts` 与本 JOURNAL；未 commit、push、部署、改依赖/迁移或其他正典文档。
- 抽出 `findValidInvite(db, code)`，将 public-invites 的查询原样移入 handler，两路共用；保留 coach 角色、未作废、未过期、未耗尽的过滤条件，不消耗次数。public JSON API 的 trim/uppercase、10 位格式校验、限流、no-store 和响应形状均未改。落地页仅在原 8/10 位白名单格式合法且模板可读时查询；实际迁移要求邀请码为 10 位，因此 8 位格式在现有数据库中查无记录，按无效码兜底。
- HTML 的 title/og:title 改为「{教练名} 教练邀请你在 MeetPR 跟练训练计划」，无有效码或空名时为「你的教练邀请你在 MeetPR 跟练训练计划」。有效码 description/og:description 为「输入邀请码 {分组码}，我排的计划直接同步到你手机」，无效码为「我排的计划直接同步到你手机」。名字先 trim，按 Unicode code point 截断 30 字，再 HTML 转义；使用 replace 回调保留名字中的 `$&` 等字面量。只缓存模板，不缓存查询结果/姓名；JSON 跳过、非法码不回显、模板缺失 fallback 不变。
- 先红后绿：先修改正式 `tests/unit/app.test.ts`（仍使用 Supertest），再生成仅将 request import 替换成既有 `tests/helpers/inMemoryRequest` 的临时副本 `tests/unit/invite-title-local.test.ts`。实现前运行下列同一命令，退出 1，22 failed / 30 passed / 1 skipped，失败为旧标题/描述不满足新断言，无监听错误；原始日志 `.invite-title-b-red.log`。实现后最终退出 0，52 passed / 1 skipped（3 文件），包括全部 34 条 app 测试、coach-applications 的 16 条及 in-memory-request 的 2 条；日志 `.invite-title-b-green-final.log`。skip 是既有真实 PostgreSQL 专用事务测试，未配置专用数据库。正式 public-invites 回归位于未修改的 `tests/coach-applications.test.ts`，本地已通过。
- 测试命令：`pnpm test -- tests/unit/invite-title-local.test.ts tests/unit/in-memory-request.test.ts tests/coach-applications.test.ts --maxWorkers=1 --minWorkers=1`。新增覆盖有效姓名、trim、script/引号/ampersand 转义、替换标记、30 字及代理对边界、作废/过期/耗尽/查无记录/非教练兜底、空名和无 profile 时仍保留有效码描述，以及缓存不串姓名。非法格式/JSON/模板缺失用例继续使用无查询方法的 DB stub，查询被误触发会失败。
- 过程中修正测试 fixture：同教练批量插入两个码时，pg-mem 原查询对第一个码返回 undefined、第二个有结果；单码对照通过，直接执行共享查询同样复现，排除 HTML 路由因素。改为两个教练各一码，保留全部生产 SQL 条件；并将 `$&` 测试的预期纠正为已转义的 `$&amp;`。诊断日志 `.invite-title-b-fixture-single.log`、`.invite-title-b-fixture-direct.log`；这不是对真实 PostgreSQL 行为的判断。最终副本已核对与正式测试仅 import 一行不同，然后删除；调试日志代码与临时 fixture 均已清理。
- 静态验证：开工基线与实现后的 `pnpm typecheck`、`pnpm lint` 均退出 0；最终日志 `.invite-title-b-typecheck.log`、`.invite-title-b-lint.log`。`pnpm exec prettier --check src/app.ts src/handlers/public-invites.ts src/routes/public-invites.ts src/routes/invite-landing-pages.ts tests/unit/app.test.ts docs/CODEX-JOURNAL.md` 全部通过；`git diff --check` 退出 0。
- 独立 `review-loop` 一轮只读审查：Standards 0 findings；Spec 0 findings，无未决项。仓内缺 `docs/agents/issue-tracker.md`，已提示正式 Matt 流程需 `$setup-matt-pocock-skills`，此次使用不依赖 tracker 的本地双轴审查，结论仅为静态审查，不代替 Opus 验收。
- 未验证：正式 Supertest、全量测试、真实 PostgreSQL、浏览器/微信卡片和部署。按本轮限制没有尝试监听端口或连接外部服务；Opus 沙箱外待跑 `pnpm test -- tests/unit/app.test.ts tests/coach-applications.test.ts --maxWorkers=1 --minWorkers=1` 与 `pnpm test -- --maxWorkers=1 --minWorkers=1`。本地无端口绿测不等同这些项目通过。

## 2026-10-22 · Spec 052 zh-Hant：接续中断实装

- 基线 `7d0d937`，工作目录 `MeetPR-backend-wt-052-zh-hant`，分支 `feat/052-zh-hant`；开工在本目录创建/删除临时文件成功，读取 CONTEXT、CLAUDE、AGENTS、CARD、SPEC、术语表、FOLLOWUPS 与历史记忆索引，再审视所有未提交改动。保留上一轮正确实现并续修。SPEC 仍为 Ready，按 David 本轮明确续作指令执行，未自行改状态或宣布 Opus 验收通过。
- 实现：认证请求规范化 `Accept-Language` 为 `zh-Hans|zh-Hant|en`，仅值变化时写 `users.preferred_locale`；缺失/非法头不覆盖。新增可空受限列迁移 `0076`，不回填或更改旧数据。本地迁移目录及 staging 引用未占用 0076，账本最后记录 0075；未访问远端，Opus 开 PR 前仍须核对最新占号。
- 推送/日报先选保存语言，未上报时国内邮箱账号走简体，Global 使用现有 `JWT_AUDIENCE=meetpr-global-client` 区分并保留 phone 回退。各事件用静态台湾文案，用户姓名、聊天和自建动作不转换；新视频事件携带动作归属标记，历史无标记视频名称保守保留。新增繁体日报携带语言标记，以便排队期间切回简/英时按 counts 重新渲染；旧简/英日报 payload 字节保持原样。
- 注册验证码、已注册提示、找回邮件按请求头选语言，无头继续 `MAIL_LOCALE`。动作库、统计、admin 计划/使用统计、视频/反馈的动作名仅在出参转换，存储与自建名称不变。普通计划树只返回 exercise_id，不增加名称字段。撤回上一轮对未接线的教练申请/欢迎/拒绝邮件模板的额外改动；这些邮件不属于本卡注册/找回验收范围。
- 开发期 `scripts/generate-zh-hant.py` 使用固定 `opencc-python-reimplemented==0.1.7` 的 s2twp 与共用术语表，生成 1,375 条静态映射与简体特有字集；运行时不加依赖，package/lock 不改。占位符校验与简体特有字扫描均通过。字集文件 SHA-256：`fd82b7169e42a93a362364026c6f50c714e348cf2a666abd8fd61d4de838ccc0`；其他三仓是否逐字相同留跨仓收货核对。
- 红绿证据：亲读上一轮原始 `.052-red-consumer.log`，国内邮箱测试 1 failed / 14 passed，实际收到 `Missed training` 而期望 `学员缺练提醒`；随后的 `.052-green-consumer.log` 为 15 passed。沿用 `.052-red-payloads.log`（10 failed / 12 passed，11 份旧 zh/en 快照）、`.052-red-locale.log`（持久化 1 failed）、`.052-red-mail.log`（繁体注册邮件 1 failed / 19 passed）等原始证据，不冒充本轮重新写测。本轮重跑中断处 consumer 测试，3 failed / 16 passed（排队日报语言切换两条、历史视频自建名一条），修复后 consumer 19 passed。
- 本轮补查系统回退名及聊天图片/训练组占位符：先写 push-payloads seam 用例，`/tmp/052-fallback-red.log` 为 1 failed / 23 passed，修后 24 passed；`/tmp/052-preview-red.log` 为 2 failed / 24 passed，修后 26 passed。生产端显式标记来源，消费端只转换系统文案；HTTP 聊天测试额外验证缺 profile 与真实同名昵称的区别。由此扩展 activity-ledger/settlement、聊天和计划推送生产端接线，未改变 zh/en 文案。
- 测试环境/修正：`pnpm install --offline --frozen-lockfile --store-dir /Users/david/Library/pnpm/store/v3` 确认依赖齐备；prepare 的 Husky 重写共享 `.git/config` 被沙箱拒绝，但既有 `core.hooksPath=.husky/_` 与 hook 已存在，未跳过 hooks。默认并行及首次串行全量曾出现 5 秒超时，停止后改为下述双 worker、15 秒单测限时跑最终全量，不修改仓内测试配置。admin 精简 fixture 补动作归属列；该 fixture 及新迁移测试触发 pg-mem `Corrupted alias`，经最小表对照证实是有旧行时内联 CHECK 的新列别名未刷新；另证实 pg-mem 将 NULL IN 错判为 false。admin fixture 只加可空列；0076 测试从源 SQL 提取同一 CHECK，首次按表级约束和显式 NULL OR 回放，复跑继续执行原 SQL，保留旧行/允许值/非法值/NULL/幂等性断言。上传旧断言补新增归属字段。SPEC 仅作 Prettier 空白整理，生成器兼容格式化后的 Markdown 分隔行。
- 独立 SQL 验证：本机 initdb/pg_ctl 来自 libpq，缺 postgres 服务端；Docker daemon 未运行。仅在 `/tmp/meetpr-052-pglite.HAfrhl` 安装临时 `@electric-sql/pglite@0.5.11`（不修改仓依赖），按[官方 Node 用法](https://pglite.dev/docs/)执行 `node /tmp/meetpr-052-pglite.HAfrhl/verify.mjs`，退出 0；PostgreSQL 18.6 WASM 引擎直接执行未经改写的 0076，验证存量全行保持、三种合法语言及 NULL、非法值 SQLSTATE 23514、迁移复跑和新用户默认 NULL，原始日志 `/tmp/052-migration-postgres.log`。生产 SQL 未因模拟器问题改写。首轮完整全量为 1355 passed / 1 failed / 1 skipped（仅此模拟器失败），保存为 `/tmp/052-full-before-migration-adapter.log`；适配定向 1 passed 后重新跑全量。
- 最终验证：`npm test -- --maxWorkers=2 --minWorkers=2 --testTimeout=15000` 退出 0，162 文件 / 1,366 passed / 1 skipped（既有 coach-applications 真实 PostgreSQL 专用测试未配置独立数据库），耗时 274.99 秒。`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build` 均退出 0；`PYTHONPATH=node_modules/.opencc-generator python3 scripts/generate-zh-hant.py --check` 退出 0，1,375 translations、simplified-only hits 0；`git diff --cached --check` 通过。最终原始输出位于 `/tmp/052-final-v21-full-test.log`、`/tmp/052-final-{typecheck,lint,format,build}.log`、`/tmp/052-artifacts-check.log`。未替换既有测试入口：统计/admin/聊天/上传等 HTTP 测试使用 Supertest，新增语言持久化测试及既有邮件测试沿用仓内 inMemoryRequest helper。
- 独立 `code-review`：Standards 0 项、Spec 0 项；追加系统来源标记后的两轴定向复审均 0 项。这里只记录实现、自测和自审，跨端界面、真实 APNs/邮件投递、真实部署库迁移及部署均未执行，Opus 按 SPEC 收货。David 要求仅本地原子提交并附指定 Co-Authored-By；最终暂存被沙箱拒绝，尚未提交，详见下方阻塞。不 push、不开 PR、不部署。

### v2 返修

- 收尾时发现术语表由外部并行更新为 v2，保留该产品决定并同步生成物：计划→課表、反馈→反饋、reps 次数→下數/N 次→N 下；输入别名表不进入显示覆写。先改断言，`/tmp/052-glossary-v2-red.log` 为 7 failed / 34 passed，语境用例 `/tmp/052-glossary-v2-context-red.log` 为 4 failed / 14 passed。Spec 定向复审发现真实动作名「21 次法弯举」仍漏转，补测 `/tmp/052-numeric-reps-red.log` 为 1 failed / 18 passed；限定数字+次法弯举语境并从术语表取单位，保留第2次/次日。最终定向 `/tmp/052-numeric-reps-green.log` 为 45 passed。SPEC 中旧「計畫」抽检词与 v2 术语表有文字差异，遵循最新明确术语表，正典对齐留 Opus。随后收到 v2.1 器械杆/杠杆语境覆写，停止尚未完成的 v2 全量；`/tmp/052-bars-red.log` 5 failed / 20 passed，修后 `/tmp/052-bars-green.log` 51 passed（2 文件）。最长词保护杠杆→槓桿，其余横杆→槓，多连杆保留 OpenCC 的多連桿。v2/v2.1 定向独立复审最终 0 项。

- 并行新增 `AMEND-v2.md` 已读；后端不承担动作输入别名/前端解析。reps 显式命中源 key 为 `次数`、`N 次`、`21 次法弯举`，测试只使用库内名称与合成值，没有真实课表数据。Standards 与 Spec 的 v2.1 定向复审均 0 项。David 本轮明确要求 commit，优先于返修卡的「不 commit」；已按该授权尝试，但最终被共享 Git 元数据权限阻止。未 push、开 PR 或部署。该返修卡仅做 Prettier 空白整理并保留在工作区。

- 提交阻塞：最终 `git add src tests db/migrations/0076-users-preferred-locale.sql scripts/generate-zh-hant.py specs/052-zh-hant docs/CODEX-JOURNAL.md` 退出 128，原始错误为 `fatal: Unable to create '/Users/david/Projects/apps/MeetPR-backend/.git/worktrees/MeetPR-backend-wt-052-zh-hant/index.lock': Operation not permitted`。工作区试写与全部代码/文档编辑成功，但共享 Git 元数据在可写根之外，当前策略不允许提权。未继续 commit 旧暂存内容，保留完整改动与既有暂存状态；HEAD 仍为 `7d0d937`。提交消息已备于 `/tmp/052-commit-message.txt`，末行是 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；需在有 Git 元数据写权限的环境完成最终暂存和 commit。

### 语言头返修（2026-10-22）

- 按 David 明确续作指令与 `AMEND-header.md` 完成后端三条；保留既有 WIP，未 commit、push、部署或更改暂存区。目录临时试写成功。SPEC 仍为 Ready，沿用本轮明确授权，不改 Opus 状态。安装依赖已齐备；Husky 写共享 `.git/config` 仍被沙箱拒绝，既有 `.husky/_` hooks 存在，未绕过 hooks。
- 请求与注册/找回邮件仅读取 `X-MeetPR-Locale`，头名大小写不敏感，值只接受精确 `zh-Hans|zh-Hant|en`；删除 Accept-Language 解析、区域标签归一化与 q 值协商。无头或非法值保持既有出参与 MAIL_LOCALE 回退、不覆盖保存偏好。旧客户端仅带 `Accept-Language: zh-TW` 的路由测试确认动作名简体且不写库。
- 中间件设置 req.locale 后先 next，再后台单条条件 UPDATE；`preferred_locale IS DISTINCT FROM` 保证 NULL 可写、同值不更新，无前置 SELECT。同步构建异常及异步拒绝均只结构化 logger.warn，不传 next(err)，测试验证请求仍 200，写库悬而未决时也先返回。Kysely 生成的 `$1` 与 `$3` 绑定同一 locale，`$2` 为用户 ID。
- CORS 现场无 allowedHeaders 白名单，保持原有反射配置；现有 app seam 新增 OPTIONS 预检用例，验证允许 Origin 下 authorization/content-type/x-meetpr-locale 均获放行。inMemoryRequest 仅补 OPTIONS 方法，不替换任何既有 Supertest 入口。
- 原稿恢复：SPEC 开工时已与 iOS/RN/web 三仓共享原稿逐字一致；GLOSSARY 从三仓相同的 iOS 原稿恢复，仅撤销 Prettier 排版，保留 v2/v2.1 内容。已按 `.prettierignore` 既有裸目录惯例加入 `specs`，本轮未格式化 specs。恢复后生成器 check 仍为 1,375 translations、simplified-only hits 0；原稿 cmp 均退出 0。
- 红绿证据 `/tmp/052-header-{legacy,values,failure,update}-{red,green}.log`：旧头回归 1 failed → 1 passed；严格三值 8 failed → 路由/邮件 47 passed；更新异常 500→200 的 1 failed → 1 passed；无前置 SELECT 的 1 failed → 完整语言路由 19 passed。随后补延迟拒绝及旧头邮件回退；最终定向 `/tmp/052-header-targeted-test.log` 为 5 文件、80 passed，CORS `/tmp/052-header-cors-final.log` 为 1 passed。CORS 配置已满足卡片条件，所以只补回归，无生产改动。
- pg-mem 不支持 IS DISTINCT FROM（最小 SELECT 也解析失败）。沿用 studentActions 既有 SQL 适配边界，针对非 NULL locale 参数等价改写为 IS NULL OR !=；生产 SQL 不退化。路由测试检查适配前原 SQL、单条 UPDATE、无 SELECT、受影响行数 1/0/1。另用既有临时 PGlite 0.5.11（PostgreSQL 18.6 WASM）直接执行同一原始 SQL，验证 NULL、重复、变化、其他用户及不存在用户，`/tmp/052-header-postgres.log` 通过；未增加仓依赖。
- 最终静态门禁：pnpm lint、pnpm typecheck、pnpm build、pnpm format:check 均退出 0；日志 `/tmp/052-header-{lint,typecheck,build,format}.log`。**全量未绿，不能声明验收通过**：基线 812 passed / 554 failed / 1 skipped；返修后 `pnpm test -- --maxWorkers=2 --minWorkers=2 --testTimeout=15000` 为 822 passed / 554 failed / 1 skipped（162 文件，116 passed / 46 failed）。两次 554 个失败用例名称集合完全相同，无新增失败；549 个未处理错误均为监听 0.0.0.0 EPERM，另有 127.0.0.1 监听拒绝及其后续 port=null 错误。原始日志 `/tmp/052-header-baseline-test.log`、`/tmp/052-header-full-test.log`；仍需在允许监听的环境跑全量，未为消除环境失败改测试入口或减少全量范围。
- `review-loop` 独立只读审查，以开工快照差分 `/tmp/052-header-review.diff` 为范围：Standards 0 findings；Spec 0 findings。仓内缺 `docs/agents/issue-tracker.md`，正式 Matt tracker 流程仍需 David 使用 `$setup-matt-pocock-skills`；本轮用不依赖 tracker 的本地双轴审查，未私建配置。审查后仅整理 lint 要求的测试回调与结果判空；本记录属于实现自测/自审，Opus 功能收货和全量环境验证仍未完成。

### v2.2（2026-10-22）

- 按 David 明确指令与 `specs/052-zh-hant/AMEND-v22.md` 在 Opus 提交 `d44d658` 上返修。开工临时文件试写成功，保留既有 GLOSSARY 两条新增及未跟踪的返修卡；未改 specs 原稿、暂存区或 HEAD，未 commit、push、部署。SPEC 仍为 Ready，沿用本轮明确执行授权，不修改 Opus 状态。
- 沿用现有生成器读取术语表并重生成 `src/i18n/zh-Hant.generated.json`：新增发布→發布、获取→取得，实际推送文案由「教練釋出了新課表」改为「教練發布了新課表」。生成脚本无需改动。测试沿用 `copy` 公开 seam 与 `buildPushPayload`，更新两条术语断言及计划发布推送断言；既有简体/英文快照原样通过。网页 title 条款不属后端仓范围。
- 先红后绿：生成校验先因 Stale artifact 失败（`/tmp/052-v22-generation-red.log`）；定向测试先为 3 failed / 50 passed（`/tmp/052-v22-red.log`），生成后推送、邮件、日报、consumer 与产物共 6 文件 / 101 passed（`/tmp/052-v22-green.log`）。生成及 `--check` 均为 1,377 translations、simplified-only hits 0（`/tmp/052-v22-generate.log`）。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm format:check` 均退出 0，日志 `/tmp/052-v22-{typecheck,lint,build,format}.log`；`git diff --check` 通过。依赖离线安装确认齐备，prepare 仍提示共享 `.git/config` 写入被沙箱拒绝；既有 `core.hooksPath=.husky/_` 与 pre-commit hook 存在，未绕过 hooks。
- 开工全量基线 `pnpm test -- --maxWorkers=2 --minWorkers=2 --testTimeout=15000` 为 822 passed / 554 failed / 1 skipped（162 文件，549 个未处理错误），数量与上一轮一致，日志含监听 127.0.0.1/0.0.0.0 EPERM 及 port=null 后续错误，原始证据 `/tmp/052-v22-baseline-test.log`。本轮按返修卡完成定向验证，未再次跑全量；不声明全量或功能验收通过，允许监听环境的全量验证仍待完成。
- `code-review` 对 HEAD 之上的 v2.2 生成物、测试及术语差异做独立只读双轴审查：Standards 0 findings；Spec 0 findings。仓内仍缺 tracker 配置，本轮使用用户给定返修卡，不依赖 tracker；正式流程配置仍需 David 调用 `$setup-matt-pocock-skills`。本记录仅为实现、自测和自审，Opus 按返修卡收货。

## 2026-10-22 · SPEC 054 CARD-A：教练总览提醒与已看记录（未提交）

- 范围固定为 `/Users/david/Projects/apps/MeetPR-backend-wt-054`、`feat/054-overview-alerts`，起点 `f3357e7`。首个动作是在当前目录创建并删除 `.codex-write-check.XXXXXX` 临时文件，退出 0；开工工作区干净。读完 CONTEXT、CLAUDE、CARD-A、SPEC、AGENTS、FOLLOWUPS 与工程规约后实施。SPEC 仍标 Draft，但 David 本轮明确要求按 CARD-A 实装，未擅改状态。依赖已装好，未重新安装、未改 lockfile。未 commit、push、开 PR、部署或修改 `db/MIGRATIONS-APPLIED.md`。
- 改动文件：新增 `db/migrations/0079-coach-student-plan-views.sql`、`src/domain/overview-alerts.ts`、`src/routes/coach-overview-alerts.ts`、`tests/domain/overview-alerts.test.ts`、`tests/coach-overview-alerts.test.ts`、`tests/migrations/0079-coach-student-plan-views.test.ts`；修改 `src/db/types.ts`、`src/routes/index.ts` 与本 JOURNAL。新表纯新增、无回填；POST 沿用 accepted 绑定与角色鉴权，数据库 `now()` upsert 并返回 204；GET 批量读取后调用纯函数，不修改既有 signals、结算、推送、exercise-stats、bind-requests 或会话行为。
- 迁移取号：使用 `git for-each-ref --format='%(refname)' refs/remotes` 遍历本地所有远端跟踪引用，逐一 `git ls-tree -r --name-only "$ref" db/migrations`；0076 已由 `origin/feat/052-plan-import-ai` 占用，0077 为 `users-preferred-locale`，0078 为 `origin/feat/053-exercise-adoption` 的 `exercise-adoption`，未见更高占号。最终 **0079**，没有改号或重排已有迁移。此证据来自本机远端跟踪引用，未 fetch 或核实部署库。
- 红→绿：先写两个指定测试文件，再运行 `pnpm test -- tests/domain/overview-alerts.test.ts tests/coach-overview-alerts.test.ts`：**2 failed files，5 failed tests**（路由未挂载返回 404；纯函数文件尚不存在导致该 suite 加载失败），日志 `/tmp/054-red.log`。纯函数落入计划快结束首个切片后，`pnpm test -- tests/domain/overview-alerts.test.ts`：**14 failed / 22 passed**，日志 `/tmp/054-domain-red.log`。迁移先运行 `pnpm test -- tests/migrations/0079-coach-student-plan-views.test.ts`：**4 failed**（SQL 文件尚不存在），日志 `/tmp/054-migration-red.log`。
- 定向返修红→绿：路由提前裁掉旧日志会把已完成处方误报 missing；先补路由回归，`pnpm test -- tests/coach-overview-alerts.test.ts` 为 **1 failed / 5 passed**（`/tmp/054-old-log-red.log`），修后保留完整日志作完成证据，由纯函数执行日期窗口。Spec 轴发现 incomplete 不应使用较晚的日志时间重开已看完成日；先补回归，`pnpm test -- tests/domain/overview-alerts.test.ts` 为 **1 failed / 36 passed**（`/tmp/054-seen-completion-red.log`），改为只比较 `completed_at`。最终 `pnpm test -- tests/domain/overview-alerts.test.ts tests/coach-overview-alerts.test.ts tests/migrations/0079-coach-student-plan-views.test.ts`：**3 files / 49 passed，退出 0**（37 纯函数、8 路由、4 迁移），日志 `/tmp/054-green-final.log`。路由测试复用 `studentActions` 和既有 `inMemoryRequest`，保留真实 Express、鉴权与 pg-mem/Kysely 链路，无网络监听；未替换任何既有测试入口。
- 清单逐项核对（开发自测，不替代 Opus 收货）：① 迁移首次/复跑、下线/重建、复合主键、非空、双 FK 与双向用户删除级联均验证，存量 users 全行不变；② 绑定教练 204、更新时间、重复调用一行、非绑定/学员拒绝；③ 3/4 天、结束 14/15 天、后续已发布/草稿、已看不消 plan_ending；④ RPE 9/8.5、区间上限、coach_rpe 覆盖（含 0）、非 RPE/缺目标忽略；⑤ missing/failed、未完成日排除、额外组/自加动作排除；⑥ 昨天落后、完成排除、后移到明天排除；⑦ 八天前/未来排除、严格大于已看时间、完成后晚写不重开、04:00 时区边界；⑧ 他教练计划、未绑定/解绑学员、不同教练独立 seen、50 名学员带计划时仍固定 **8 条查询**；⑨ 既有业务文件与测试未改，全量运行情况见下文，不能把环境失败写成验收通过。
- 迁移验证限制与补证：pg-mem 对任意复合主键表 `DROP TABLE` 后残留主键索引名，已用双 int 列最小表复现；测试仅在 down 前删除模拟器中的残留索引，生产迁移保持原 SQL。使用本机已有 `/tmp/meetpr-052-pglite.HAfrhl/node_modules/@electric-sql/pglite` 的 PostgreSQL **18.6 / PGlite 0.5.11** 另跑 `node /tmp/054-verify-migration.mjs`，原样执行 up/reapply/down/up，核验既有数据、23505/23502/23503 约束与两条 FK 的 cascade，退出 0，日志 `/tmp/054-postgres-migration.log`。未安装仓依赖，未触碰部署库。
- 口径说明：时区取 `users.timezone`，复用 `trainingDay` 的本地 04:00 切日与现有默认时区；推荐日期只用 `effectivePlanDays`。`coach_rpe ?? rpe` 包括教练给 0 的覆盖，wire RPE 统一一位小数。处方按 `set_number` 排序映射零基 `set_index`，与现有导入/完成统计口径一致；`set_index >= 处方数` 的额外组不判，无 `plan_exercise_id` 的自加动作不判。missing 无日志时以完成时刻的训练日作日期，有日志时以 `logged_date` 作日期；incomplete 的已看与 latest_at 均用完成时间。
- SPEC 未细化两点：七日窗口采用**今天与前六个训练日**，沿用既有 signals 日期范围惯例；SPEC 仅明确八天前排除，七天前边界措辞仍有歧义。behind 没有发生时刻列，`latest_at` 采用推荐日期的 **UTC 00:00:00** 作为排序值，seen 过滤仍按学员时区的训练日期；该 timestamp 规则在 SPEC 未定义。以上在测试固定并交 Opus 对齐，不自行改产品正典。
- 独立本地审查：依照 review-loop / code-review 的双轴方法，Standards **0 findings**；Spec 初审 **1 项行为偏离 + 七日边界歧义**，incomplete 完成时间问题修后定向复审 **0 项明确违反**，审查者独立跑纯函数 **37 passed**。仓内缺 `docs/agents/issue-tracker.md`，正式 Matt tracker 配置需 David 调用 `$setup-matt-pocock-skills`；本次本地审查以用户给定 SPEC/CARD-A 为源，不依赖 tracker，也未私建配置。
- 最终静态门禁：`pnpm exec tsc --noEmit` **退出 0**（`/tmp/054-tsc-final.log`）；`pnpm lint` **退出 0**（`/tmp/054-lint-final.log`）；补充 `pnpm build` **退出 0**（`/tmp/054-build-final.log`），七个改动 TypeScript 文件 Prettier check 通过（`/tmp/054-format-final.log`），`git diff --check` 通过。锁文件和迁移应用账本对 HEAD 的 diff 均为空。
- 全量基线：开工执行 `pnpm typecheck && pnpm lint && pnpm test`，前两项退出 0；test **554 failed / 824 passed / 1 skipped，46 failed files / 116 passed files，549 errors，退出 1**（`/tmp/054-baseline-test.log`）。失败包含沙箱 `listen EPERM`（0.0.0.0/127.0.0.1）及随后的 Supertest `port=null`。最后代码上的默认 `pnpm test` 为 **558 failed / 869 passed / 1 skipped，48 failed files / 117 passed files，549 errors，退出 1**（`/tmp/054-full-final.log`）；逐名对照基线仅多 4 条既有邮箱注册/找回测试的 5 秒超时，新增 49 条全部通过。为排除资源竞争，保持全量范围与原入口，用双 worker 和 15 秒限时重跑，结果补于下行。
- 双 worker 全量重试 `pnpm test -- --maxWorkers=2 --minWorkers=2 --testTimeout=15000` 中途退出 1，未生成完整统计（`/tmp/054-full-limited.log`），不能算完整验证。随后 `pnpm test -- tests/auth/email-recovery.test.ts tests/auth/email-signup-verification.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=15000` **2 files / 33 passed，退出 0**（`/tmp/054-auth-timeouts-recheck.log`），覆盖默认全量新增的四条超时项；没有修改这些测试或认证代码。
- **最后一次完整全量结果**：停止并行静态检查后，单独再跑 `pnpm test`：**554 failed / 873 passed / 1 skipped（1428），46 failed files / 119 passed files（165），549 errors，退出 1**，耗时 53.51 秒，日志 `/tmp/054-full-isolated.log`。与开工基线逐名比较的 550 个失败名称分组完全相同（对应 554 个失败用例），新增/消失均为 0，证据 `/tmp/054-failure-comparison.log`；4 个认证超时在此轮也已消失。新增 49 例在完整全量中全绿。SPEC 第 9 条“全量绿”因既有沙箱监听限制未满足，需在允许监听的环境执行原样全量，不能宣称功能验收已完成。最终 tsc/lint 均退出 0；本次仅交付未提交实现、测试及开发证据。

### 054 卡 A 第 1 轮返修：限制历史计划读取（2026-10-23）

- 本轮仅修改 `src/routes/coach-overview-alerts.ts`、`tests/coach-overview-alerts.test.ts` 与本 JOURNAL；沿用 `feat/054-overview-alerts`、HEAD `f3357e7` 及既有未提交实现，不改 SPEC、不 commit、不 push。依赖沿用卡 A 已安装环境；SPEC 仍为 Draft，按本轮明确返修指令执行，不改状态。
- GET 计划查询增加 `end_date >= UTC 今天 - 22 天`，复用 `utcDate` / `utcDateOnly`，包含下界当天；后续 days / sets / logs / completions / shifts 继续按已筛选的计划及训练日 ID 查询，保留入选计划的完整日志作为完成证据。`plan_ending` 的「后面没接上」判断不受影响：能展示的候选计划仍在窗口内，后续计划的 end_date 更晚，必然也在查询范围内，published / draft 判定原样保留。
- 回归在既有路由/真实 pg-mem seam 用 `afterQuery` 统计查询，造结束于 2026-08-23（冻结 UTC 今天 2026-10-22，恰好 60 天前）、带旧日志和完成记录的计划，断言加入前后响应相同，且查询数与无计划时相同、无 plan_days 查询。先运行 `pnpm test -- tests/coach-overview-alerts.test.ts`：**1 failed / 8 passed**，实际查询 **8 条，期望 3 条**（`/tmp/054-r1-red.log`）；加筛选后运行 `pnpm test -- tests/coach-overview-alerts.test.ts tests/domain/overview-alerts.test.ts`：**2 files / 46 passed，退出 0**（`/tmp/054-r1-green.log`），包含既有后续已发布/草稿与时区回归。
- `pnpm test`（完整默认命令）：**554 failed / 874 passed / 1 skipped（1429），46 failed files / 119 passed files（165），549 errors，退出 1**，日志 `/tmp/054-r1-test.log`。本轮开工基线为 **554 failed / 873 passed / 1 skipped，549 errors**（`/tmp/054-r1-baseline-test.log`）；逐名对照全部 554 条失败名称完全相同，新增/消失均为 0（`/tmp/054-r1-failure-comparison.log`）。失败仍包含沙箱 `listen EPERM` 与后续 Supertest 错误；新增回归通过，不能声明全量绿或功能验收完成。
- `pnpm exec tsc --noEmit`：**退出 0**（`/tmp/054-r1-tsc.log`）；`pnpm lint`：**退出 0**（`/tmp/054-r1-lint.log`）。两份改动 TypeScript 的 Prettier check 与 `git diff --check` 通过。
- code-review 独立只读审查范围为本轮开工快照差分（`/tmp/054-r1-route.diff`、`/tmp/054-r1-test.diff`）：**Standards 0 findings / Spec 0 findings**。本轮无新增口径疑点；全量沙箱限制仍待允许监听的环境验证。沿用用户返修指令作审查来源，不依赖既有缺失的 tracker 配置；正式 tracker 流程仍需 David 调用 `$setup-matt-pocock-skills`。
