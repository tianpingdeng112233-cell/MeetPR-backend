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

## 2026-10-09 — 046 体重记录（未提交交付，待 Opus 收货）

- 工作树 `MeetPR-backend-wt-046`，分支 `feat/046-body-weight-records`，HEAD `e855758`；启动写入探针成功。缓存 `origin/staging=1d4eb8c` 的迁移头为 0070；David 转达 Opus 当日核查：0071 空闲，PR #267 占 0069。未联网。
- 依赖按任务说明使用已安装版本，未重装。基线 typecheck、lint 成功；`pnpm test`：51 failed / 102 passed files，553 failed / 610 passed tests，548 errors，存在 `listen EPERM` 的沙箱端口限制。
- 第一组 red：`pnpm exec vitest run tests/migrations/0071-body-weight-records.test.ts`，5 failed / 4 skipped；迁移文件尚不存在（ENOENT）。PG17 的完整 SQL/时区/回填与老用户首屏用例留为显式 opt-in，本机不具备执行条件。
- David 已授权补齐手建 schema 的共享测试夹具，仅新增本表，不改旧数据或断言。

### 待 Opus 决定

- SPEC 验收提到 `GET /students/me/onboarding`，现有代码仅支持 `GET /students/:id/onboarding`（id 必须 UUID）。本次不新增未定义的 GET 别名，测试通过本人 UUID 的现有端点验证档案与首屏兼容。

### 实装 red / green 证据

- 迁移 DDL green：同上命令，`Test Files 1 passed (1)`，`Tests 5 passed | 4 skipped (9)`。4 个跳过项是完整 PG17 迁移（含时区与首屏），不能视为通过。
- 第二组 red 尝试：`pnpm exec vitest run tests/body-weights.test.ts`，`Tests 28 failed (28)`，`Errors 28 errors`；全部在 HTTP listen 处遇到 EPERM，尚未抵达业务断言，不能视作已证明功能性 red。
- 第三组 red 尝试：`pnpm exec vitest run tests/onboarding.test.ts`，20 failed / 20 errors（11 旧用例 + 9 新用例），同样被 `listen EPERM` 阻塞，不能视作功能性 red。旧断言未改。
- 原样 SQL 的 pg-mem 探针返回 `Error: relation "pg_timezone_names" does not exist`；没有用 UTC 替换生产 SQL，也没有用模拟时区函数冒充 PostgreSQL 验证。
- 返修 red 尝试（先补测试再修改实现）：`pnpm exec vitest run tests/body-weights.test.ts tests/onboarding.test.ts -t 'invalid calendar dates|invalid user timezone'`；2 个新用例均因 listen EPERM 未抵达业务断言。

### 交付文件（全部未提交）

- `db/migrations/0071-body-weight-records.sql`：新增表、按用户时区回填、无效时区 UTC 回退、可重跑；不改任何旧行或列。
- `src/db/types.ts`：手工新增表类型。
- `src/handlers/body-weights.ts`：记录查询、同日 upsert、删除、档案最新值同步；所有体重写者先锁用户行，写记录与档案在同一事务。
- `src/routes/body-weights.ts`、`src/routes/index.ts`：三条本人学生路由及挂载、日期/数值校验、既有鉴权及错误信封。
- `src/handlers/onboarding.ts`：只新增体重联动；保留 §3“未来记录存在时档案仍取请求值”的例外。
- `tests/migrations/0071-body-weight-records.test.ts`、`tests/body-weights.test.ts`、`tests/onboarding.test.ts`：三个约定 seam；旧断言全部保留。
- `tests/helpers/bindEval.ts`：按 David 补充授权只新增表 schema，原 fixture 行不变。
- `docs/CODEX-JOURNAL.md`：本节证据与交接。

### 验收 1–7 对应测试（映射，不代表已验收）

| SPEC 验收项                    | 测试位置与名称                                                                                                                                                                                                                      | 本机证据                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1 干净库/存量回填/档案逐行不变 | migration：`creates an empty table and permits one record per user and date`；PG17：`applies the full migration to a clean database`、`backfills by each user timezone, falls back to UTC, skips nulls and preserves every profile` | DDL 用例通过；完整迁移与回填待 PG17                                                      |
| 2 重跑幂等                     | PG17：`reruns without duplicates or overwriting an existing record`                                                                                                                                                                 | 已写、未执行                                                                             |
| 3 接口状态码与响应             | body-weights 的全部 29 个用例：GET 空/升序/隔离，三动词角色与未登录，PUT 新增/覆盖/数值与日期验证，DELETE 非法日期/无记录/非本人/旧日期                                                                                             | 均被 listen EPERM 阻塞，未执行到业务断言                                                 |
| 4 最新日期同步档案             | body-weights：`PUT and DELETE keep the profile at the newest remaining date in any order`；`PUT creates a profile when missing and normalizes numbers to two decimals`                                                              | 已写、未执行到业务断言                                                                   |
| 5 旧 schema/响应及 §3 联动     | onboarding 原 11 项旧测试无断言改动；新增 10 项覆盖首次、相同值有记录/无记录、改值同日覆盖、无 weight、跨时区、无效时区、未来日期例外；`first weight save creates today’s record and preserves every response field` 逐字段比对     | 21 项均被 listen EPERM 阻塞；请求 schema/响应序列化未修改已经 diff 检查                  |
| 6 老用户第一屏                 | PG17：`preserves the old user first profile screen and exposes exactly one backfilled record`                                                                                                                                       | 已写、未执行；使用现有本人 UUID GET 路径，路径差异见待决定                               |
| 7 工程门禁与禁改范围           | lint、typecheck、test、build、format 检查；`git diff --check`；禁改路径 diff 检查                                                                                                                                                   | lint/typecheck/build/format 通过；全量测试未绿，计数见原始输出；部署台账等禁改路径无修改 |

### 拍板、审查与剩余验证

- David 转达 Opus 的两项补充已实现：onboarding 遇无效 `users.timezone` 回退 UTC，不因时区值使保存失败；DELETE 非法日历日期返回 400 既有 `VALIDATION_ERROR` 信封，合法日期不存在才返回 404。PUT 保持 SPEC 专用日期错误码。正典 SPEC 的补录由 Opus 负责。
- 独立 Standards 初审 2 项 P2：无效时区兼容性、PG17 测试 search_path 的 public 删除风险；均已修复，定向复审 0 项遗留。
- 独立 Spec 初审 2 项 P2：测试时钟导致 JWT 过期、PG17 测试 DATE parser 未初始化。已先设时钟再签 token；SQL 日期显式 text，HTTP 测试连接改用仓内 `createPool` 初始化 DATE parser。第二轮复审提示的 parser 余项也已按建议修正并静态复核。
- 本机缺 `docs/agents/issue-tracker.md`，未声称执行 Matt tracker 工作流；使用 review-loop 的本地双轴独立审查，未替代 Opus 收货。
- **已写但未实际执行到业务断言**：body-weights 最初 28 项 + DELETE 非法日期 1 项，共 29 项；onboarding 11 项既有 + 10 项新增，共 21 项。supertest 必须监听本地端口，沙箱 `listen EPERM` 在请求进入 Express 前就阻断。它们在原始测试输出中为 failed，绝非 passing。
- **已写但未执行（skip）**：上表 PG17 的 4 项（干净库完整迁移；用户时区/UTC 回退/空值跳过/旧档案不变；重跑幂等；老用户第一屏）。pg-mem 不提供 `pg_timezone_names`；Docker socket 权限被拒，未发现可用 PG17。未用本机 PG18.4 当证据、未生成 PG17 verification 文档。
- Opus 后续可在本工作树内启动隔离 PG17（默认端口的 Unix socket），设置 `BODY_WEIGHT_PG17_SOCKET` 为树内 socket 目录运行 migration 测试；测试仅使用随机 schema，搜索路径不含 public，不读取 DATABASE_URL 或 .env。需再执行完整 HTTP 测试。真实 PostgreSQL 上的事务回滚/并发锁尚无运行证据。
- 实际本机 Node 为 `v25.9.0`，不是目标 Node 22；Node 22 环境验证留待收货。
- 未联网、未部署、未 commit/push/开 PR；未修改现有迁移、部署台账、web、.github 或 onboarding 请求 schema/响应形状。

### 最终命令原始输出

`pnpm lint && pnpm typecheck && pnpm test`（按最后指示先 lint 再 typecheck；前两步 exit 0，test exit 1）。全量比基线新增 5 个通过 DDL 用例、39 个被 socket 权限阻断的 HTTP 用例、4 个 PG17 skipped；未发现新增非环境类失败。

```text
> meetpr-backend@0.0.1 lint /Users/david/Projects/apps/MeetPR-backend-wt-046
> eslint .


> meetpr-backend@0.0.1 typecheck /Users/david/Projects/apps/MeetPR-backend-wt-046
> tsc --noEmit


> meetpr-backend@0.0.1 test /Users/david/Projects/apps/MeetPR-backend-wt-046
> vitest run
...
 Test Files  52 failed | 103 passed (155)
      Tests  592 failed | 615 passed | 4 skipped (1211)
     Errors  587 errors
   Start at  08:31:20
   Duration  50.22s (transform 2.88s, setup 2.01s, collect 133.07s, tests 169.22s, environment 132ms, prepare 31.39s)

 ELIFECYCLE  Test failed. See above for more details.
```

最终测试夹具修正后再次 `pnpm lint && pnpm typecheck`，均 exit 0；typecheck 原始输出：

```text

> meetpr-backend@0.0.1 typecheck /Users/david/Projects/apps/MeetPR-backend-wt-046
> tsc --noEmit
```

最终单独运行 `pnpm exec vitest run tests/migrations/0071-body-weight-records.test.ts`，exit 0：

```text
 Test Files  1 passed (1)
      Tests  5 passed | 4 skipped (9)
   Start at  08:32:00
   Duration  4.82s (transform 1.11s, setup 30ms, collect 3.05s, tests 265ms, environment 0ms, prepare 231ms)
```

`pnpm build` exit 0：

```text
> meetpr-backend@0.0.1 build /Users/david/Projects/apps/MeetPR-backend-wt-046
> tsc -p tsconfig.build.json
```

仓级 `pnpm format:check` 和最终变动代码文件的 `pnpm exec prettier --check ...` 均 exit 0：

```text
Checking formatting...
All matched files use Prettier code style!
```

原始尾部已经移入本节，`.codex-046-*.log` scratch 日志在交付前删除；不会进入 change set。

### 返修一 — 2026-10-09

- 本轮仅修改 `tests/migrations/0071-body-weight-records.test.ts`、`db/migrations/0071-body-weight-records.sql` 和本 JOURNAL；保留 Opus 的 SPEC 修改，未读取或触碰 `.pgverify/`。
- 两个测试连接池共用带显式 socket 路径和 user 的连接串；只设 `BODY_WEIGHT_PG17_SOCKET` 即使用 `postgres` 角色，也可用 `BODY_WEIGHT_PG17_USER` 指定角色。继续使用仓内 `createPool` 注册 DATE parser，运行命令已写入测试块上方注释；不读取 DATABASE_URL 或 .env。
- 先补 `does not backfill again after a profile timestamp moves to another calendar day`，再为回填加按 `user_id` 的 `NOT EXISTS`，保留 `ON CONFLICT`。该用例在迁移后推进一个档案的 `updated_at`，重跑并逐字段比较整个记录集合。PG17 不可用，未在本机运行此用例的 red/green。
- 无连接参数检查复现旧配置的 host=`localhost`、user=`david`；修后从测试源码提取连接串表达式，用 pg 参数解析验证两池配置的 socket、database，以及默认 `postgres` / 自定义 `test_role` 均通过。没有发起连接。
- `pnpm lint && pnpm typecheck` exit 0；变动测试文件 Prettier 检查与 `git diff --check` 通过。DDL 命令：`env -u BODY_WEIGHT_PG17_SOCKET pnpm exec vitest run tests/migrations/0071-body-weight-records.test.ts -t 'migration 0071 table'`，exit 0，原始尾部：

```text
 ✓ tests/migrations/0071-body-weight-records.test.ts (10 tests | 5 skipped) 58ms

 Test Files  1 passed (1)
      Tests  5 passed | 5 skipped (10)
   Start at  08:40:19
   Duration  1.31s (transform 409ms, setup 9ms, collect 941ms, tests 58ms, environment 0ms, prepare 62ms)
```

- 本轮 5 个真实数据库用例均未执行，supertest 用例也未运行：仍受沙箱连接/监听限制。用户转达的返修前验收为 155 文件、1207 passed / 4 skipped，以及 PostgreSQL 17.10 上借助连接 workaround 的 4 项通过；这些不是本轮改后验证结果。修后的实际 socket 连接及新增跨日幂等用例仍需 Opus 在沙箱外验证。
- 未生成 scratch 文件；无 commit、push 或 PR。
