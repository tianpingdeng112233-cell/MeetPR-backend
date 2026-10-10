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
