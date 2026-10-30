# 056 · rpe-mode 自重补漏 · 2026-10-30

## 授权与现场

- 用户本轮任务是实施依据：生产 DMS 发现第三种自重编码，David 已拍板按自重处理。本会话未访问 DMS 或真实数据库；生产事实来自任务交接，未冒充现场复核。
- worktree：`/Users/david/Projects/apps/MeetPR-backend-wt-056`；branch：`fix/056-rpe-mode-bodyweight`；初始与最终 HEAD：`05cb5d72919fe8ff94cbf0a1944b98296d43bf30`，缓存 `origin/staging` 同 SHA。开工工作区干净。
- 已读 AGENTS、CONTEXT、CLAUDE（hard rule 8）、056 SPEC、0080、intensity / serialization、FOLLOWUPS、memory/INDEX、engineering-workflow。SPEC 仍为 Ready，本次明确修复授权优先，不改正典状态；FOLLOWUPS 无本轮触发项。
- 运行 `git worktree list`、`git status --short`、`git log --oneline -10`。本地及缓存 origin/staging 迁移最高 0080；`rg --files -g '*0081*'` 开工无结果。未执行 git 写命令、commit/push 或真实库操作。
- `git ls-remote origin refs/heads/staging` 失败：`Failed to connect to 127.0.0.1 port 18083`；`gh pr list --state open --json number,title,headRefName --limit 100` 失败：`proxyconnect tcp ... connect: operation not permitted`。0081 的远端 HEAD / open PR 占号需要 Opus 复核。
- 依赖安装：首次 `pnpm install --offline --frozen-lockfile --ignore-scripts` 仅返回重装提示，没有安装；按已有 store 重试 `pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir /Users/david/Library/pnpm/store/v3` exit 0：`Already up to date`。禁用 lifecycle 是为了遵守本次禁止 git 写操作，未运行 Husky 的 git config。

## 改动

- `db/migrations/0081-rpe-mode-bodyweight.sql`：依赖 0080，事务内新增无 FK 备份表，保存 id / coach_note / load_mode / target_rpe。仅整动作每组均匹配 rpe / 10 + 旧 rpe / 10 + 独立标记时回填 bodyweight，target_rpe 清空；沿用 0080 的正则、只去第一个标记，不 trim。保留旧强度字段，末尾 SQL 可准确还原备份字段，不撤销 0080。
- `src/routes/plans/intensity.ts`：保留旧 NULL-mode 归一，增加整动作第三编码归一；缺省旧字段允许，显式旧字段只接受 rpe / 10。去标记时清空新编码的 target_rpe。
- `src/routes/plans/index.ts`：必要接线，持久化 target_rpe；三写路径把原请求旧字段传给归一入口，防止 intensityWrite 覆写冲突字段后误识别。
- `src/routes/plans/serialization.ts`：bodyweight 的 load_mode 与九个新负荷/强度字段一律投影 null，保留旧 rpe / 10.00 + 备注标记。共享投影覆盖计划树、写响应和 pending snapshot；不修改存储处方，free_weight 保持原行为。
- `tests/plans/load-types-api.test.ts`：整对象严格断言（教练/学员）、pending snapshot，create/PATCH/batch 有/无旧字段正例、混合 sibling 和显式冲突旧字段负例。
- `tests/migrations/0081-rpe-mode-bodyweight.test.ts`：11 项 pg-mem 测试，先应用 0080，再验证全组正例、原文/备份/回滚，以及 RPE 8、weighted、NULL、新旧目标冲突、自由文本、canonical sibling 不误改。
- `db/MIGRATIONS-APPLIED.md`：新增 0081 未应用条目；未变更 0080 已应用事实。

## Red → green

保留仓内 supertest import 和默认测试配置。沙箱禁止监听，真实 supertest 无法给出业务断言结果。补充验证使用仓内已有 `tests/helpers/inMemoryRequest.ts`，通过 `/tmp` 临时 Vitest alias 运行同一 HTTP 路由测试（真实 Express handlers + pg-mem），未改仓内测试工具或绕过端口限制。以下 red/green 均为该无端口补充执行，不能替代正式 supertest 验收。

临时 `/tmp/056-supertest-memory.mjs`：

```js
export { request as default } from '/Users/david/Projects/apps/MeetPR-backend-wt-056/tests/helpers/inMemoryRequest.ts';
```

临时 `/tmp/056-vitest.config.mjs`：

```js
export default {
  root: '/Users/david/Projects/apps/MeetPR-backend-wt-056',
  resolve: { alias: { supertest: '/tmp/056-supertest-memory.mjs' } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
  },
};
```

命令前缀：`pnpm exec vitest run --config /tmp/056-vitest.config.mjs tests/plans/load-types-api.test.ts`。

| 行为                           | selector                   | Red                                                         | Green                                         |
| ------------------------------ | -------------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| 旧网页第三编码写入             | `-t 'old web rpe-mode'`    | 1 failed / 38 skipped，exit 1；库内仍为 rpe、10、带标记备注 | 1 passed / 38 skipped，exit 0                 |
| 自重响应清空全部新字段         | `-t 'clears all new-only'` | 1 failed / 38 skipped，exit 1；九个新字段泄漏               | 与上项一起执行，2 passed / 37 skipped，exit 0 |
| 审查返修：显式冲突旧字段不归一 | `-t 'conflicting old web'` | 6 failed / 49 skipped，exit 1；误投影为 null / null         | 定向四文件共 99 passed，exit 0                |

首轮 red 测试随后扩展为 create/PATCH/batch × 旧字段有/无，未通过先实现再声称 red。日志保存在 `/tmp/056-write-red.log`、`056-write-green.log`、`056-projection-red.log`、`056-projection-green.log`、`056-conflict-red.log`、`056-conflict-green.log`；以下摘录保留长期证据。

写入 red 原始差异：

```text
-   "coach_note": " 慢下放",
-   "load_mode": "bodyweight",
-   "target_rpe": null,
+   "coach_note": "自重 慢下放",
+   "load_mode": "rpe",
+   "target_rpe": 10,
Test Files  1 failed (1)
     Tests  1 failed | 38 skipped (39)
```

投影 red 原始差异（节选；完整严格对象还覆盖 weight_low/high、RPE range、pct_anchor 等）：

```text
-   "target_rpe": null,
+   "target_rpe": "10.0",
-   "target_weight": null,
+   "target_weight": "20.00",
Test Files  1 failed (1)
     Tests  1 failed | 38 skipped (39)
```

冲突字段 red 原始差异：

```text
    "coach_note": "自重",
-   "load_mode": "rpe",
-   "target_rpe": "10.0",
+   "load_mode": null,
+   "target_rpe": null,
Test Files  1 failed (1)
     Tests  6 failed | 49 skipped (55)
```

## 审查

- 使用 tdd 与 code-review。Standards / Spec 分别由只读独立子代理审查本次未提交 diff + 新增文件（固定点 HEAD）；没有新增提交。
- Standards：首轮 0，定向返修复审 0；Spec：发现 1 项 P2（原请求冲突旧字段被新强度映射覆盖后误归一），先补六项红测试，再修复。独立定向复审已关闭，0 未解决。
- 仓内无 `docs/agents/issue-tracker.md`，已提示 `/setup-matt-pocock-skills`；本次按用户提供的 spec/任务审查，不依赖 tracker，不创建配置。
- 以上属于开发自测/独立代码审查，不是 Opus 终验或发布放行。

## 检查结果

基线 `pnpm typecheck` / `pnpm lint` 均 exit 0。基线 `pnpm test` exit 1：49 failed / 126 passed 文件；630 failed / 1185 passed / 1 skipped 项；625 unhandled errors，全部监听 EPERM 或其派生 supertest port 错误。

首轮完整检查（返修前）：typecheck、lint、format:check、build 均 exit 0；test exit 1，49 failed / 127 passed 文件，641 failed / 1196 passed / 1 skipped 项，636 unhandled errors；仍全部为监听限制。返修后最终结果见下方。

| 最终命令            | exit | 结果                                                                                    |
| ------------------- | ---- | --------------------------------------------------------------------------------------- |
| `pnpm typecheck`    | 0    | 无 TypeScript 错误                                                                      |
| `pnpm lint`         | 0    | 无错误或警告                                                                            |
| `pnpm format:check` | 0    | All matched files use Prettier code style                                               |
| `pnpm build`        | 0    | 编译通过                                                                                |
| `pnpm test`         | 1    | 176 文件：127 通过、49 失败；1844 项：1196 通过、647 失败、1 跳过；642 unhandled errors |
| `git diff --check`  | 0    | 无 whitespace 错误                                                                      |

全量测试所有失败仍为 `listen EPERM`（0.0.0.0 / 127.0.0.1）及 supertest 派生 `Cannot read properties of null (reading 'port')`，未把失败改为 skip。最终日志：`/tmp/056-final-typecheck.log`、`056-final-lint.log`、`056-final-format-check.log`、`056-final-build.log`、`056-final-test.log`。

最终无端口补充命令（exit 0）：

```sh
pnpm exec vitest run --config /tmp/056-vitest.config.mjs tests/plans/load-types-api.test.ts tests/plans/load-types-contract.test.ts tests/migrations/0080-load-types.test.ts tests/migrations/0081-rpe-mode-bodyweight.test.ts
```

原始摘要：

```text
RUN  v2.1.9 /Users/david/Projects/apps/MeetPR-backend-wt-056

 ✓ tests/plans/load-types-contract.test.ts (25 tests) 9ms
 ✓ tests/migrations/0080-load-types.test.ts (8 tests) 71ms
 ✓ tests/migrations/0081-rpe-mode-bodyweight.test.ts (11 tests) 87ms
 ✓ tests/plans/load-types-api.test.ts (55 tests) 1044ms

 Test Files  4 passed (4)
      Tests  99 passed (99)
   Start at  04:22:19
   Duration  1.68s (transform 296ms, setup 18ms, collect 644ms, tests 1.21s, environment 0ms, prepare 99ms)
```

最终全量原始摘要：

```text
Test Files  49 failed | 127 passed (176)
      Tests  647 failed | 1196 passed | 1 skipped (1844)
     Errors  642 errors
   Start at  04:24:01
   Duration  23.26s (transform 2.72s, setup 921ms, collect 64.37s, tests 95.92s, environment 24ms, prepare 8.86s)

 ELIFECYCLE  Test failed. See above for more details.
```

## 交付差异摘录

以下为实际 diff 摘录（不代替上方完整变更清单）：

```diff
diff --git a/src/routes/plans/serialization.ts b/src/routes/plans/serialization.ts
index c2f0d65..90b954d 100644
--- a/src/routes/plans/serialization.ts
+++ b/src/routes/plans/serialization.ts
@@ -289,6 +289,15 @@ function projectBodyweight<T extends { load_mode?: unknown; coach_note?: unknown
   return {
     ...set,
     load_mode: null,
+    pct_anchor: null,
+    target_pct: null,
+    target_rpe: null,
+    rir_target: null,
+    rpe_low: null,
+    rpe_high: null,
+    weight_low: null,
+    weight_high: null,
+    target_weight: null,
     intensity_mode: 'rpe' as const,
     target_value: '10.00',
     coach_note: bodyweightCoachNote(typeof set.coach_note === 'string' ? set.coach_note : null),
```

## 待后续环境复核

- Opus 在允许监听的环境运行未替换 supertest 的 `pnpm test`，本轮不宣告正式 HTTP 验收通过。
- 合并/执行前复核远端 0081 占号；本地及缓存 origin/staging 无占用证据，不等于实时远端确认。
- 0081 未应用、未部署；未访问真实数据库。无待决定的产品问题，未 commit/push。
