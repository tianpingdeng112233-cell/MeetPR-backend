# 053 · 合并 staging（2026-10-22 放行后）

David 已放行 PR #323。合并前 staging 已进了 spec 052 繁体中文（#321，含迁移 0077-users-preferred-locale）等改动，与本分支冲突：`docs/CODEX-JOURNAL.md`、`src/handlers/admin.ts`、`src/handlers/exercise-stats.ts`、`src/routes/exercises/index.ts`、`src/routes/plans/serialization.ts`。

## 要做

1. 在本分支 `git merge origin/staging`，解决冲突：spec 053 全部行为（含不变量 1–4）保留；staging 上 052 及其他改动的行为全部保留。迁移号保持 0078（0077 已在 staging）。
2. JOURNAL 冲突：两边段落都保留，按时间顺序排列。

## 验收

`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、相关测试全绿（沙箱内起不了 supertest 的话如实说明，Claude 会在沙箱外跑全量）。

## 约束

完成合并提交（提交信息写明解决了哪些冲突），但**不要 push、不要开 PR**；不改依赖与锁文件；不改历史数据。JOURNAL 追加「053 合并 staging」一段。
