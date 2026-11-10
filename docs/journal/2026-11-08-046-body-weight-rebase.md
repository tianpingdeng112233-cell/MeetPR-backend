# 046：合并 staging 的执行记录（2026-11-08）

## 当前状态：三处文件冲突已解决，检查仍被依赖安装阻塞

David 转达：Opus 已完成 fetch，并执行 `git merge --no-ff --no-commit origin/staging`，合并进行中。本轮 Codex 仅编辑文件；**没有执行任何 Git 命令**，也不 add / commit / push。Opus 负责暂存与提交。以下当前状态取代首轮阻塞状态；保留首轮日志与 046 原条目用于追溯。

### 冲突处理

- `docs/CODEX-JOURNAL.md`：保留冲突区的 staging 原文及区外公共内容，移除本分支冲突区；确认本分支 046 条目已完整存在于本文末尾。未对旧总账做格式化或另加内容。解决后 SHA-256：`85a7bd7f113ac62073a8283c35e2796d608746972fff2b62085118e5fbbcda9b`。
- `CONTEXT.md`：原文合并双方全部术语，保留体重记录与 staging 额外组、自加动作、收录、教练叫法、计划快结束、RPE 超标、未完成、落后、自选重量、自重、解绑、学员备注、服务期等；共 16 个不同术语，不改定义。
- `src/routes/index.ts`：保留 staging 全部新路由及依赖，在 `studentOnboardingRouter` 后挂载 `bodyWeightsRouter({ db: deps.db })`，仍经 `deps.requireAuth`；随后的视频路由保留 `studentVideosRouter({ db: deps.db, oss: deps.oss })`，没有退回旧的仅 db 版本。其他前置 `/students` 路径不会吞掉 `/me/body-weights`，无重复挂载。
- 扫描上述三文件与四个自动合并文件，7/7 无冲突标记。此处仅指文件内容，Git index 的冲突状态留待 Opus add。

### 自动合并语义复核（静态）

- `src/db/types.ts`：保留 `BodyWeightRecordsTable` 和唯一 `Database.body_weight_records` 映射；DATE / NUMERIC 为 string，时间戳沿用 TimestampColumn。staging 的导入计数、入驻、邮箱验证码、总览访问记录、解绑备注、service_until 等类型仍在。
- `src/handlers/onboarding.ts`：046 的用户行锁、按差值或无记录写入、时区/UTC 回退与档案 upsert 仍处于同一事务；无体重字段时不写记录；未来记录场景仍保留 SPEC §3 的请求体重例外。staging 的 coached 必填项收缩为 12 项、self-train unit-only 完成、完成后的 coached 1RM 锁都保留，没有改请求 schema 或响应字段。
- `tests/helpers/bindEval.ts`：保留体重表、时区和 staging preferred_locale，仍执行 0082（仅移除 pg-mem 不支持的 enum 语句）与原始 0083；没有丢掉别名、服务期测试前置。
- `tests/onboarding.test.ts`：staging 的必填 12 项/放宽 5 项/competition_date 条件测试与 046 的联动、同值跨日不增、无效时区、响应逐字段及未来记录例外用例均保留。未删改这些自动合并文件。
- 静态复核未发现合并引入的行为偏移；未以静态核对替代测试或验收。

### 在当前合并工作区重新核对迁移

本次直接读取工作区 `db/migrations/0071` 与 0072–0083 内全部 11 份现存后续迁移，不再沿用首轮缓存判断。0073 无文件，号段缺口未填补；0071 未重排、未修改，SHA-256 仍为 `7b46049b54ba4fd9f9c6e7616b876b127917c0ef7f2e2ef4c0833cb23cce957d`。

逐份核对对象：0072 → email_signup_codes；0074 → set_logs 列/约束/索引；0075 → coach_applications 与 password_reset_codes.purpose；0076 → plan_import_runs；0077 → users.preferred_locale；0078 → exercises 列/索引；0079 → coach_student_plan_views；0080 / 0081 → plan_sets 约束/回填及各自备份表；0082 → bind_requests、bind_request_status、coach_student_aliases；0083 → bind_requests.service_until。

**结论：0071 的表 `body_weight_records`、主键/索引 `body_weight_records_pkey`、外键 `body_weight_records_user_id_fkey`、CHECK `body_weight_records_weight_kg_check` 均不与这些迁移对象重名；后续迁移也不改动回填依赖的 users.id/timezone 与档案表字段。0071 保留按档案最后修改日、用户时区、无效时区 UTC 回退、NOT EXISTS 与 ON CONFLICT 双重防重的原 SQL。** 完整 SQL 仍见下方首轮记录。

### 当前命令结果与遗留

- `HUSKY=0 pnpm install`：exit 1。HUSKY=0 仅用于遵守本轮不执行 Git 命令（避免 prepare/husky 调用 Git），不修改 hook 配置、不绕过 commit 检查。依赖下载仍被沙箱网络策略阻止：`connect EPERM 127.0.0.1:18083`，目标 registry.npmjs.org；安装未完成。
- `HUSKY=0 pnpm lint`：exit 1，`eslint: command not found`。
- `HUSKY=0 pnpm typecheck`：exit 1，`tsc: command not found`。
- `HUSKY=0 pnpm test`：exit 1，`vitest: command not found`。**测试实际执行 0 项，未收集用例，无 passed/failed suite 数；不是业务测试失败，也不是已知 5 秒超时。** 依赖补齐后必须重新运行，不能报绿。
- 本轮再次运行本地 PostgreSQL 17.11 initdb，目录 `/tmp/meetpr-046-pg-merge-20261108`，exit 1：`could not create shared memory segment: Operation not permitted`，`shmget(key=113379338, size=56, 03600)`。initdb 自动移除未完成目录；没有启动数据库或执行任何 SQL。按 David 本轮允许跳过的条件，**0083 schema 上 dry-run 跳过，仍未验证**。
- 原始本轮日志：`/tmp/046-merge-install.log`、`/tmp/046-merge-lint.log`、`/tmp/046-merge-typecheck.log`、`/tmp/046-merge-test.log`、`/tmp/046-merge-initdb.log`；这些临时文件不是仓内交付内容。
- 已请 David 协调 Opus 补装依赖或接手测试；待依赖可用后续跑 lint / typecheck / 全量 test，并记录实际数字。未改锁文件、业务行为或迁移；无远端数据库访问、无部署。Opus 最终 add/commit 前仍须补齐检查结果。

## 首轮记录（历史，尚未由 Opus 发起 merge 时）

## 状态：环境阻塞，尚未 merge / commit

文件名沿用 David 指定的 `rebase`，实际要求与后续操作均为 merge，不 rebase、不 force-push、不 push。没有连接远端数据库，没有部署。

- 工作分支：`feat/046-body-weight-records`，初始 HEAD `2c0050a`，启动时工作区干净。
- 已读 CONTEXT、CLAUDE、AGENTS、046 SPEC/CARD、迁移账本与 FOLLOWUPS。SPEC 为 InReview；本次按 David 明确授权维护已实装 PR #289，不改产品行为。
- 缓存 `origin/staging`：`e0c27c6a0bf833982cee3339fb7643e2ba7580ae`（2026-11-08）。fetch 失败，不能把缓存称为已核实的远端最新 SHA。
- `git fetch origin staging` 被沙箱拒绝：`cannot open '/Users/david/Projects/apps/MeetPR-backend/.git/worktrees/MeetPR-backend-wt-046/FETCH_HEAD': Operation not permitted`。当前可写范围不包含主仓 Git 元数据，不能完成目标分支的 merge / commit；未绕过权限。
- 尚未开始 merge，故不存在已解决冲突的结论。旧 `docs/CODEX-JOURNAL.md` 未改；本分支 046 历史条目已预先复制到本文末尾，后续 merge 时旧总账须取 staging 原文，完成迁移。

## 0071 与缓存 staging 的 0072–0083 静态核对

保留 `0071-body-weight-records.sql`，未重排或改写迁移。账本 0072 条目明确 0071 属在途 046，未应用、缺号符合预期。

逐份读取缓存 staging 的 SQL：0072 新建 `email_signup_codes`；0074 修改 `set_logs`；0075 新建 `coach_applications` 并扩展 `password_reset_codes`；0076 新建 `plan_import_runs`；0077 扩展 `users.preferred_locale`；0078 扩展 `exercises`；0079 新建 `coach_student_plan_views`；0080 / 0081 修改 `plan_sets` 并各建备份表；0082 扩展 `bind_requests` / 枚举并新建 `coach_student_aliases`；0083 扩展 `bind_requests.service_until`。0073 在该缓存分支无文件，未虚构或补号。

0071 仅新建 `body_weight_records`，自动对象名为 `body_weight_records_pkey`（主键及索引）、`body_weight_records_user_id_fkey`、`body_weight_records_weight_kg_check`；上述迁移无同名表、索引或约束，也不修改回填所依赖的 `users.id/timezone` 与 `student_onboarding_profiles.user_id/weight_kg/updated_at`。静态结论：无对象命名冲突，无已发现的顺序依赖；此结论仅覆盖上述缓存 SHA，待成功 fetch 后复核。

## 存量回填 SQL 与本地 PostgreSQL dry-run

迁移原文如下；档案表没有 UPDATE。`updated_at AT TIME ZONE` 按用户时区取档案最后修改日，无效时区通过 `pg_timezone_names` 左连接回退 UTC；按 user_id 的 NOT EXISTS 防止跨日重跑产生第二条，复合键 ON CONFLICT 防止覆盖。

```sql
-- Spec 046: one body weight record per user and calendar date.
BEGIN;

CREATE TABLE IF NOT EXISTS body_weight_records (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recorded_on DATE NOT NULL,
  weight_kg NUMERIC(5,2) NOT NULL CHECK (weight_kg > 0 AND weight_kg < 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, recorded_on)
);

-- Backfill only the new table; preserve every existing profile column.
INSERT INTO body_weight_records (user_id, recorded_on, weight_kg, created_at, updated_at)
SELECT p.user_id,
       (p.updated_at AT TIME ZONE COALESCE(tz.name, 'UTC'))::date,
       p.weight_kg,
       p.updated_at,
       p.updated_at
FROM student_onboarding_profiles AS p
JOIN users AS u ON u.id = p.user_id
LEFT JOIN pg_timezone_names AS tz ON tz.name = u.timezone
WHERE p.weight_kg IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM body_weight_records AS r WHERE r.user_id = p.user_id
  )
ON CONFLICT (user_id, recorded_on) DO NOTHING;

COMMIT;
```

本地版本为 PostgreSQL 17.11（Homebrew）。尝试初始化仅用于合成数据的一次性集群：

```sh
/opt/homebrew/opt/postgresql@17/bin/initdb -D /tmp/meetpr-046-pg-20261108/data -U postgres -A trust
```

结果 exit 1，初始化已自动清除未完成的数据目录：

```text
FATAL: could not create shared memory segment: Operation not permitted
DETAIL: Failed system call was shmget(key=113336348, size=56, 03600).
```

**0083 schema 上 dry-run 未执行**：没有成功启动集群，没有应用 schema 或 0071，不能证明回填条数、档案逐行不变或可重入。此前 `docs/verification-0071-pg17-2026-10-09.md` 为历史证据，前置并非完整 0083 schema，不能替代本轮验证。

恢复环境后须在隔离本地库应用 staging 现有迁移至 0083（不补缺号），再跑 0071 的空库、有体重/空体重、时区/无效时区、档案逐字段不变、同日及档案更新时间跨日后重跑测试，并补记录实际输出。

## 本轮检查结果

- `pnpm install`：依赖下载被网络策略阻止，多个 registry.npmjs.org 请求报 EPERM；未成功安装依赖或验证 husky。
- `pnpm typecheck`：失败，`tsc: command not found`。
- `pnpm lint`：失败，`eslint: command not found`。
- `pnpm test`：失败，`vitest: command not found`；未进入测试用例，不能归类为已知 5 秒超时。
- 当前只有本 JOURNAL 新增，无代码或迁移修改；没有 merge commit，没有 push。
- 待恢复权限后继续：fetch → merge 与冲突解决 → 本地 0083 schema 迁移验证 → install / lint / typecheck / 全量 test（必要时单跑超时项）→ 审查 → merge commit。远端数据库、部署与 push 仍禁止。

## 046 历史条目（原文预迁入）

以下来自 `2c0050a:docs/CODEX-JOURNAL.md`，只保留历史证据，不代表本轮结果。旧总账现已在冲突处理时采用 staging 内容。

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
