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

## 2026-10-12 · spec 049 卡 A（未提交实装）

- 当前目录 `/Users/david/Projects/apps/MeetPR-backend-wt-049a` 已用 mktemp 创建并删除临时文件，退出 0；全程不切换仓库。
- HEAD `054c954`，分支 `feat/049-coach-pages-backend`，依赖沿用已安装版本。
- 本地文件及 `origin/staging` 树最大迁移号 0072；卡指定 open PR #289=0071、#267=0069。选择 0073。`gh pr list --state open` 被沙箱拒绝：`proxyconnect tcp: dial tcp 127.0.0.1:18083: connect: operation not permitted`，未独立核实最新远端占号。
- 基线 typecheck / lint 退出 0；基线 pnpm test：51 failed | 104 passed，553 failed | 640 passed，548 errors（主要 listen EPERM），不能称全绿。
- 测试 seam：默认 supertest；沙箱用 `COACH_PAGE_IN_MEMORY=1` 选择仓内 `tests/helpers/inMemoryRequest.ts`，仍走完整 Express HTTP 路由和 pg-mem，不连接真实数据库。

### 红阶段（实现前）

默认 supertest：`Serialized Error: { code: 'EPERM', errno: -1, syscall: 'listen', address: '0.0.0.0' }`。
同一测试改用仓内内存 HTTP helper：`creates an empty draft for a new coach` → `expected 404 to be 200`。

### SPEC 歧义与实装解释

- SPEC 头仍为 Draft；依据 David 本轮与 CARD 明确实装授权继续，未修改 specs。

红阶段追加：生命周期测试最初 `expected 404 to be 200`；核实数据单测最初 `Failed to load url ../../src/domain/coach-page-stats`；招生申请组最初读取列表 404/缺少 enquiries，邮件 mock 调用 0 次。对应实现后，内存 HTTP 与纯函数定向测试达到 21/21（后续继续补边界）。

### 实装结果与接口约定

- 迁移号 0073 经 David 本轮在沙箱外再次确认：staging 0072、open #289 占 0071、#267 占 0069。本地不用网络补证，不改他人迁移。
- §1–§4 新接口均已接线；主页状态值为 `draft/pending/published/hidden/suspended`，申请状态为 `new/contacted/closed`。管理员子 router 挂在已有 token role + live DB role 双校验之后；教练角色 gate 只作用于新增 endpoint。
- 编辑字段为 `slug/headline/bio/specialties`；招生申请字段为 `name/contact/squat_kg/bench_kg/deadlift_kg/goal/consent`，诱饵为 `website`（非空字符串返回空 201，不入库、不发信、不消耗招生名额）。有效提交同样返回空 201。
- 公开详情/预览用 `verified_stats: {scale, progress, response}`。`scale` 包含 `training_duration: {value,unit}|null`、`active_student_count/total_student_count/completed_session_count`；`progress` 为 `{pr_count, students:[{display_name,lifts:{squat/bench/deadlift:{change_kg,weeks}}}]}|null`；`response` 为 `{median_minutes,value,unit,sample_count}|null`。管理员额外保留各 lift 的 `baseline_kg/current_kg`，公开与教练预览不保留这两项；头像恒 null，详情带 `data_as_of/accepting_enquiries`。
- 提交缺项回 409 `COACH_PAGE_SUBMIT_REQUIREMENTS` + `missing` 数组（slug/headline/subscription）；非法状态迁移 409 `COACH_PAGE_INVALID_STATE`；不存在/不可见均 404 `COACH_PAGE_NOT_FOUND`；招生记录越权 404 `COACH_ENQUIRY_NOT_FOUND`。
- 无缓存。匿名只经过显式字段白名单投影，未返回学生名、id 或训练日期；唯一公开时刻为 spec 要求的 `data_as_of`。
- 招生配额按 coach_id + 来源 IP 的 HMAC-SHA256 摘要持久化在新表，不保存原始 IP。事务锁住主页与订阅行后计数、写入，并在取锁后复核自然到期；重启与改 slug 不重置配额。
- 邮件通过现有 Resend 服务；仅使用 `PUBLIC_BASE_URL`，无配置时不放链接，中文正文为「你有一条新的招生申请，请登录教练网页端查看」；英文按 MAIL_LOCALE。无邮箱/未配发信/投递失败均记不含联系信息的结构化日志并保持 201。

### SPEC 歧义与解释（供收货裁定）

1. Draft 与启动要求 InProgress 冲突：按 David 明确授权及 CARD 执行，spec 文件保持原样。
2. 原 e1RM 曲线默认 90 天与全历史起点冲突：按 David 明确批准，给 `buildE1RMSeries` 增加可选 `startDate`；旧调用默认值不变。主页沿用原取数、比赛项过滤、coach RPE 优先级和公式，取所有记录日点；上界为最后源 `logged_date`，避免学员当地已跨日但 UTC 未跨日时漏记录。
3. 一行多项周数不同：按该行各项最大周数降序，平局以内部学生 id 排序稳定输入（id 不出响应），再赋「学员 A…Z、AA…」。每项周数分别计算。
4. 带训月份取完整 UTC 日历月，未满一月取完整周数（刚开始为 0 周）；没有可靠接受时刻则 duration=null，不用注册时间猜。无有效进步/反馈时对应整块 null，规模仍返回实数（可为 0）。
5. 历史人数依据现存 accepted 绑定去重；在带人数再调用既有 canonical resolver 归属。完成课数按该教练计划的完成行；成长点位严格沿用 published/paused/completed 范围，排除 draft/他人计划。
6. 近 90 天视频按 `created_at` 且状态 ready，归属用已有不可变 `source_coach_id`；无来源证明的旧视频不猜归属。首次反馈只取该教练的 feedback/video_markers 最早时间，忽略早于视频创建或晚于数据截至的无效时刻。
7. 独立公开请求限流为每来源 60 次/分钟，与登录工具的全局桶分开；真实招生另按滚动 24 小时最多 3 条。配额摘要复用现有 JWT_ACCESS_SECRET 做 HMAC；此密钥轮换会改变来源摘要，属于需部署方注意的已有密钥生命周期影响（未读任何真实值）。
8. 全部接口新增字段名、错误码中 spec 未逐字指定的部分见上方约定；reject 理由上限取 500 字。无效角色/UUID/输入沿用现有鉴权与校验信封。
9. 管理员「全部教练主页」读取会给尚无主页的教练补空草稿；不触发公开、不改变订阅或带训工具。
10. 邮件入口歧义已由 David 裁定：仅复用 PUBLIC_BASE_URL；不配则只发无链接提示，未新增 env 或硬编码入口。

### 先红后绿补充与独立审查

- 邮件新要求测试先红：原硬编码入口不等于 PUBLIC_BASE_URL；无配置正文不等于指定无链接提示。实现调整后四种 locale × URL 情形均通过。
- Standards 初审 1 项：新 router 全局 requireRole 改了旧 dashboard 返回值。新增测试红摘录：`expected 403 to be 501`；限定角色 gate 到新增 endpoint 后，student/self-train/admin 均返回原 501 `{error:'not_implemented', endpoint:'GET /coach/dashboard'}`。Standards 复核该 finding 已关闭。
- Spec 初审 1 项：订阅可在等锁期间自然到期。通过 DB adapter 的 afterQuery 模拟等待后时钟前进，HTTP 红摘录：`expected 201 to be 404`；锁后复核后返回统一 404 且列表仍空。Spec 复核已关闭。
- UTC 跨日纯函数回归红摘录：`expected undefined to deeply equal {baseline_kg:100,current_kg:100,change_kg:0,weeks:1}`。上界使用实际记录日后转绿。
- `review-loop` 两个独立只读 reviewer 分别审 Standards/Spec；无未决 finding。缺 `docs/agents/issue-tracker.md`，未声称跑过依赖 tracker 的 Matt code-review；后续配置入口为 `$setup-matt-pocock-skills`，不阻塞本卡本地双轴审查。审查不等于 Opus 产品验收。

### 验收清单 → 测试名

下表 HTTP 测试均在 `tests/coach-pages.test.ts`，另行注明纯函数文件；每项都已纳入实际定向运行。

| 清单 | 测试名                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | `creates an empty draft for a new coach`；`returns identical 404 for %s`（draft/pending/hidden/suspended/no-subscription/expired 六行）                                                                                                                                                                                                                                                                                                                                                                      |
| 2    | `publishes an approved page and preserves listed_at across expiry, hide and suspension`                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3    | `keeps directory ordering when the earliest coach expires and renews`；上述发布生命周期测试包含主页/目录/招生三闸；`rejects an enquiry if subscription expires while waiting for the page lock`                                                                                                                                                                                                                                                                                                              |
| 4    | `hides and restores without another review and rejects coach restoration after suspension`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5    | `publishes self-description edits immediately and clears the moderation flag`                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 6    | `rejects malformed, reserved, duplicate and locked slugs; admin can change a locked slug`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 7    | `tests/unit/coach-page-stats.test.ts`：`matches hand-calculated scale, lifetime baselines, 28-day current values, negative progress and median response`；`omits empty progress and response blocks and shows weeks below one month`；`includes the latest recorded training day across UTC boundaries and keeps one-day progress`；`uses an inclusive 28-day window, half-kilo changes and the coach RPE override`；HTTP 接线 `scopes source records to the coach and returns only anonymous public fields` |
| 8    | `scopes source records to the coach and returns only anonymous public fields`（逐字段白名单，并检查来源姓名/id/日期不出现）                                                                                                                                                                                                                                                                                                                                                                                  |
| 9    | `stores enquiries, silently discards the honeypot, caps the fourth submission and isolates coaches`；`uses a rolling persisted 24-hour quota across app instances and renamed slugs`；`requires consent and validates all limits without accepting writable verified stats`                                                                                                                                                                                                                                  |
| 10   | `sends localized mail with optional PUBLIC_BASE_URL: $locale / $url`（zh/en × 有/无 URL）；`keeps 201 when mail is unavailable: %s`（no-email/no-config/send-failure）                                                                                                                                                                                                                                                                                                                                       |
| 11   | `preserves byte-identical existing HTTP responses before and after additive migration and page use`（/coach/students、/me、/admin/overview 的 response.text 逐字节比较）；补充 `keeps the existing dashboard response for authenticated non-coaches`                                                                                                                                                                                                                                                         |

迁移另有 `tests/migrations/0073-coach-pages.test.ts`：`is additive and reentrant and cascades pages and enquiries on account deletion`，验证无回填、存量行不变、新数据重跑保留及用户删除级联；沿用仓内 migration helper 的 pg-mem noAstCoverageCheck，以避开 CREATE IF NOT EXISTS 重跑的模拟器 AST 限制。

### 实际运行的定向测试

- 卡 A 默认仍使用 supertest；`COACH_PAGE_IN_MEMORY=1 pnpm exec vitest run tests/coach-pages.test.ts tests/unit/coach-page-stats.test.ts tests/migrations/0073-coach-pages.test.ts`：截至审查返修后 31/31，后补半公斤/28天边界一项。
- 最终合并定向命令：`pnpm exec vitest run --config .049-vitest.config.ts tests/coach-pages.test.ts tests/unit/coach-page-stats.test.ts tests/migrations/0073-coach-pages.test.ts tests/exercise-stats.test.ts tests/unit/exercise-stats-aggregates.test.ts tests/unit/e1rm.test.ts tests/services/mail.test.ts`，7 文件 **89 passed (89)**，退出 0；最后输出行 `Duration 1.92s (transform 421ms, setup 50ms, collect 1.41s, tests 1.58s, environment 1ms, prepare 426ms)`。
- 临时 config 仅将精确模块名 `supertest` alias 到仓内 `inMemoryRequest` 的 default re-export，并 merge 原 vitest.config；测试断言和生产路由不变。两个 `.049-*` 临时文件已删除。此结果证明 HTTP 应用层和既有成长曲线断言通过，**不等于真实监听端口下 supertest 全量通过**。
- 分文件：coach-pages 27、coach-page-stats 4、0073 migration 1、exercise-stats 15、exercise-stats-aggregates 10、e1rm 24、services/mail 8。既有 exercise-stats 三文件合计 49/49，符合保留原输出的回归检查要求。

### 最终检查与实际末行

最终代码定向复跑（lint 修正之后）：上述七文件 89/89，退出 0，实际非空末行 `Duration 1.75s (transform 428ms, setup 35ms, collect 1.38s, tests 1.71s, environment 1ms, prepare 317ms)`。
随后为清单 4 增补独立可见性测试，再跑卡 A 三文件：**33 passed (33)**（coach-pages 28、stats 4、migration 1），退出 0。该次实际非空末行为 `Duration 1.56s (transform 247ms, setup 17ms, collect 592ms, tests 902ms, environment 0ms, prepare 95ms)`。与既有四文件 57 个回归一起，共 90 个不同定向用例通过。没有宣称它们在默认监听式传输下通过。

| 命令                | 退出码 | 实际非空末行（不计捕获脚本附加 EXIT_CODE）            |
| ------------------- | ------ | ----------------------------------------------------- |
| `pnpm lint`         | 0      | `> eslint .`                                          |
| `pnpm typecheck`    | 0      | `> tsc --noEmit`                                      |
| `pnpm format:check` | 0      | `All matched files use Prettier code style!`          |
| `pnpm build`        | 0      | `> tsc -p tsconfig.build.json`                        |
| `pnpm test`         | 1      | `ELIFECYCLE Test failed. See above for more details.` |

全量最后运行（含独立清单 4 用例）：52 failed / 106 passed 文件，581 failed / 645 passed 用例，576 errors；错误为 0.0.0.0 或 127.0.0.1 的 `listen EPERM`，supertest 随后无法取得端口。基线同类问题已存在。最终检查日志保存在 `/tmp/049-final-*.log`（本机临时证据，未入仓）。

### 改动文件清单

- `db/migrations/0073-coach-pages.sql`
- `docs/CODEX-JOURNAL.md`
- `src/db/types.ts`
- `src/domain/coach-page-stats.ts`
- `src/handlers/coach-enquiries.ts`
- `src/handlers/coach-page-stats.ts`
- `src/handlers/coach-pages.ts`
- `src/handlers/exercise-stats.ts`
- `src/middleware/rateLimit.ts`
- `src/routes/admin-coach-pages.ts`
- `src/routes/admin.ts`
- `src/routes/coach-enquiries.ts`
- `src/routes/coach-page-http.ts`
- `src/routes/coach-page.ts`
- `src/routes/index.ts`
- `src/routes/public.ts`
- `src/services/mail.ts`
- `tests/coach-pages.test.ts`
- `tests/migrations/0073-coach-pages.test.ts`
- `tests/unit/coach-page-stats.test.ts`

### 未做 / 未验证

- 按要求未 commit、push、开 PR、合并、部署；未动 specs/、web/、既有迁移、CARD；未读取 .env 或真实凭证；未连接真实数据库。
- 默认全量 supertest/真实 socket 测试受 sandbox listen EPERM 阻止，需要协调方在沙箱外重跑。
- 迁移仅用 pg-mem 验证，未在真实 PostgreSQL 执行；事务行锁、跨实例并发竞争与真实索引执行计划未实测。HTTP 已模拟等锁时间流逝、复建 app、slug 变更和跨 24 小时边界，但不替代真实并发证明。
- 邮件只 mock 网络边界验证地址/本地化/正文隐私/失败降级，未发送真实邮件；公网代理来源地址配置、真实配额行为与公开上线均未验证。
- 本卡没有未实现的清单 1–11 项；上述自测与静态双轴复核不等于 Opus 验收放行。网页端与官网仍属卡 B/C，不在本卡执行范围。

## 返修第 1 轮

同一 worktree、同一未提交工作区继续，遵循 5 项定向返修。未 commit/push；不碰 specs/、signals-api.test.ts，不加缓存。

### 1. 官网地址配置

测试：`R1.1 public_url uses the configured site: $site`（默认/自定义，教练与管理员 HTTP）；`R1.1 coach site config defaults to HTTPS and rejects insecure custom values`。
红命令：`COACH_PAGE_IN_MEMORY=1 pnpm exec vitest run tests/coach-pages.test.ts tests/unit/config.test.ts -t R1.1`。
红摘录：`expected 'https://meetpr.cn/c/coach-one' to be 'https://preview.example.test/cn/c/coach-one'`；`expected undefined to be 'https://meetpr.cn'`。结果 2 failed / 1 passed。

### 2. 来源摘要用途隔离

测试：`R1.2 quota recognizes only purpose-prefixed hashes: $prefix`（带前缀的三条历史申请阻止第四条；裸 IP 摘要不占该用途配额）。
红命令：`COACH_PAGE_IN_MEMORY=1 pnpm exec vitest run tests/coach-pages.test.ts -t R1.2`。
红摘录：带前缀 fixture `expected 201 to be 429`；裸 IP fixture `expected 429 to be 201`，2 failed。测试从 HTTP 验证预置 DB 配额，不读取真实凭证。

### 3. SQL 聚合计数

测试：`R1.3 verified counts use SQL aggregates and preserve scoped totals`。
红命令：`COACH_PAGE_IN_MEMORY=1 pnpm exec vitest run tests/coach-pages.test.ts -t R1.3`。
红摘录：计数值正确，但 DB 边界看到 `select "c"."id" from "plan_day_completions" ...`，不匹配 `^select count\(\*\) as "count"`，1 failed。

### 4. 目录缩小绑定取数范围

测试：`R1.4 empty directory performs no bond queries`；`R1.4 invisible coaches do not broaden candidates or change visible counts`。
红命令：`COACH_PAGE_IN_MEMORY=1 pnpm exec vitest run tests/coach-pages.test.ts -t R1.4`。
红摘录：空目录查询绑定的数组不等于 `[]`；候选查询 `select "student_id" from "bind_requests" where "status" = $1` 不匹配 `"coach_id" in (`，2 failed。

### 5. 非草稿简介不可清空

测试：`R1.5 %s rejects a blank headline without changing any page fields`（pending/published/hidden/suspended）；`R1.5 draft may clear its headline`。
红命令：`COACH_PAGE_IN_MEMORY=1 pnpm exec vitest run tests/coach-pages.test.ts -t R1.5`。
红摘录：四个非 draft 状态 `expected 200 to be 409`，4 failed / 1 passed。测试同时提交 bio/specialties，并比较前后除数据截至时刻外的全部字段，验证失败不改任何字段。

### 逐项 green 命令与实际末行

下列测试走 HTTP 应用边界；第 3/4 项额外通过已有 afterQuery helper 观察 SQL，因为返修明确要求 SQL 聚合和候选取数范围，仅比较相同响应不足以检出旧实现。未 mock handler。

- 第 1 项 green：`COACH_PAGE_IN_MEMORY=1 pnpm exec vitest run tests/coach-pages.test.ts tests/unit/config.test.ts -t R1.1`；3 passed，退出 0。实际末行：`Duration  791ms (transform 222ms, setup 7ms, collect 491ms, tests 131ms, environment 0ms, prepare 57ms)`。红命令的实际末行：`Duration  910ms (transform 244ms, setup 15ms, collect 538ms, tests 132ms, environment 0ms, prepare 93ms)`。
- 第 2 项 green：`COACH_PAGE_IN_MEMORY=1 pnpm exec vitest run tests/coach-pages.test.ts -t 'R1.2|rolling persisted|stores enquiries'`；4 passed，退出 0。实际末行：`Duration  971ms (transform 238ms, setup 5ms, collect 528ms, tests 217ms, environment 0ms, prepare 34ms)`。红命令的实际末行：`Duration  903ms (transform 230ms, setup 5ms, collect 500ms, tests 134ms, environment 0ms, prepare 39ms)`。
- 第 3 项 green：`COACH_PAGE_IN_MEMORY=1 pnpm exec vitest run tests/coach-pages.test.ts -t 'R1.3|scopes source records'`；2 passed，退出 0。实际末行：`Duration  910ms (transform 233ms, setup 7ms, collect 503ms, tests 184ms, environment 0ms, prepare 29ms)`。红命令的实际末行：`Duration  833ms (transform 227ms, setup 5ms, collect 498ms, tests 116ms, environment 0ms, prepare 38ms)`。
- 第 4 项 green：`COACH_PAGE_IN_MEMORY=1 pnpm exec vitest run tests/coach-pages.test.ts -t R1.4`；2 passed，退出 0。实际末行：`Duration  879ms (transform 232ms, setup 6ms, collect 502ms, tests 129ms, environment 0ms, prepare 41ms)`。红命令的实际末行：`Duration  876ms (transform 231ms, setup 5ms, collect 501ms, tests 125ms, environment 0ms, prepare 34ms)`。
- 第 5 项 green：`COACH_PAGE_IN_MEMORY=1 pnpm exec vitest run tests/coach-pages.test.ts -t R1.5`；5 passed，退出 0。实际末行：`Duration  870ms (transform 217ms, setup 4ms, collect 475ms, tests 212ms, environment 0ms, prepare 24ms)`。红命令的实际末行：`Duration  953ms (transform 237ms, setup 5ms, collect 517ms, tests 219ms, environment 0ms, prepare 34ms)`。

### 本轮实现与歧义解释

- 地址默认值只在 config 模块定义；`COACH_SITE_BASE_URL` env 可不填，ConfigSchema 用既有 HttpsUrlSchema 校验并给默认值。为兼容仓内直接构造的 Config 注入对象，该类型字段保留 optional，集中 helper 使用相同默认值；末尾所有 `/` 去掉后拼接 `/c/<slug>`，保留自定义地址的路径前缀。所有教练/管理员预览调用均传递 config；邮件仍只读 PUBLIC_BASE_URL，不受此配置影响。
- HMAC 严格采用 `coach-enquiry-source:` + IP；不兼容识别本卡此前未部署的裸 IP 摘要，也不进行数据回填。既有按 coach_id、滚动 24 小时、锁后到期复核的行为不变。
- 两个 count(\*) 查询沿用原 join/where，用 Number 统一 pg 返回的 int8 字符串与 pg-mem 数字；不缓存、不搬运记录到进程里计数。
- 目录仅对可见教练查候选学生，但 canonical resolver 仍可看这些学生与其他教练的竞争绑定，避免错误归属。没有可见教练时不查 bonds。
- 非 draft 只有明确提交空白 headline 才拒绝；省略该字段照常允许修改其他字段，null 仍走现有输入校验。检查在行锁内、UPDATE 前，409 不改变任何字段。draft 允许空白并存为空字符串。

### 本轮完整定向验证

1. `COACH_PAGE_IN_MEMORY=1 pnpm exec vitest run tests/coach-pages.test.ts tests/unit/config.test.ts tests/unit/coach-page-stats.test.ts tests/migrations/0073-coach-pages.test.ts tests/unit/exercise-stats-aggregates.test.ts tests/unit/e1rm.test.ts tests/services/mail.test.ts`：**7 文件 113/113**，退出 0。分文件分别 40、26、4、1、10、24、8。实际末行 `Duration 3.54s (transform 707ms, setup 108ms, collect 1.49s, tests 2.38s, environment 0ms, prepare 416ms)`。
2. `pnpm exec vitest run --config .049-r1-vitest.config.ts tests/admin.test.ts tests/coach-students.test.ts tests/exercise-stats.test.ts`：**3 文件 48/48**，退出 0；分别 24、9、15。实际末行 `Duration 1.07s (transform 238ms, setup 12ms, collect 1.25s, tests 915ms, environment 0ms, prepare 66ms)`。临时 config 只将 supertest 替换为仓内 inMemoryRequest 传输；它和 re-export 文件均已删除。
3. 上述共 **161 个不同用例**；lint 提示只需等价改成 `edit.headline?.trim() === ''`，修正后又跑第 5 项 5/5，计入原用例、不重复加总。
4. Standards 与 Spec 两个独立 reviewer 审 `/tmp/049-r1-source.diff` 及 R1 测试，均无 finding；静态审查不等于真实数据库验证。

### 本轮改动文件

- `src/config.ts`
- `src/handlers/coach-pages.ts`
- `src/handlers/coach-enquiries.ts`
- `src/handlers/coach-page-stats.ts`
- `src/routes/coach-page.ts`
- `src/routes/admin-coach-pages.ts`
- `src/routes/admin.ts`
- `src/routes/index.ts`
- `src/routes/public.ts`
- `tests/coach-pages.test.ts`
- `tests/unit/config.test.ts`
- `docs/CODEX-JOURNAL.md`

### 本轮未做 / 未验证

- 5 项全部实现；保持此前已接受的成长曲线范围参数、角色中间件、锁后复核、状态机和公开白名单；未修改迁移。
- 未运行默认全量 suite：本沙箱上一轮已实证 `listen EPERM`，本轮依要求运行内存 HTTP 定向测试。协调方报告沙箱外 157/158 文件、1225/1226 用例，唯一 signals 并发 flaky 在单跑和基线上通过；这是协调方证据，本代理未重新验证、未改 `tests/signals-api.test.ts`。
- 未读取凭证或 .env，未连接真实数据库，未测试真实 PostgreSQL 锁竞争/执行计划或真实邮件。未 commit/push/PR/部署；未碰 specs/，未新增缓存。

### 本轮最终检查命令与末行

| 命令                | 退出码 | 实际非空末行                                 |
| ------------------- | ------ | -------------------------------------------- |
| `pnpm lint`         | 0      | `> eslint .`                                 |
| `pnpm typecheck`    | 0      | `> tsc --noEmit`                             |
| `pnpm format:check` | 0      | `All matched files use Prettier code style!` |

日志 `/tmp/049-r1-lint.log`、`/tmp/049-r1-typecheck.log`、`/tmp/049-r1-format.log` 的捕获脚本末行均为 `EXIT_CODE=0`。上述两组完整定向日志 `/tmp/049-r1-targeted.log`、`/tmp/049-r1-regression.log` 的捕获末行也均为 `EXIT_CODE=0`；原始 Duration 末行已在上方逐项保留。
