# CODEX Journal

## 2026-07-09 — coached 学员单日顺延后端

- 从 `feat/043-plan-import-backend` 建立 linked worktree 和 `feat/shift-day-backend`，新增 0030 手写迁移、`plan_day_shifts` Kysely 类型、学员本人 POST/DELETE 顺延端点，以及 GET plan day 的 nullable `shifted_to_date` 字段。
- 顺延保持为已发布计划树之外的纯增量覆盖层；校验 UTC 今天、计划活跃期、同 plan-week 休息日和 set log，重复相同目标走 UPSERT 并保留原 `id`/`created_at`。
- 测试覆盖顺延/撤销、角色与归属、日期/休息日/log/draft 拒绝、GET 序列化和幂等；迁移测试验证唯一约束与 day 级联删除。
- 踩坑：旧 plans 集成测试使用手建 schema，GET 新增读表后必须同步执行 0030；同时 `pg-mem` 的 DATE 返回 `Date`，与生产 node-postgres 的 DATE-as-text 不同，因此在 wire 序列化边界统一归一为 `YYYY-MM-DD`。
