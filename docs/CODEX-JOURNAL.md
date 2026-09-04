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
