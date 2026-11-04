# 059 卡 A — 服务期：迁移 + 接收带日期 + 设置接口 + 花名册字段

先读仓根 `CONTEXT.md`（「服务期」词条）与 `specs/059-service-term/SPEC.md`，本卡以 SPEC 为准；与 SPEC 冲突时停下写进 JOURNAL，不自行取舍。

- **级别**: T2 / P1。分支 `feat/059-service-term`（已从 `origin/staging` 切好，worktree `~/Projects/apps/MeetPR-backend-wt-059`）。PR 开向 `staging`，不合并。
- **JOURNAL**: `docs/journal/2026-11-04-059-A.md`（一卡一文件，返修追加在同一文件）。

## 目标

教练能在接收申请时、以及之后任何时候，为在训学员设置/修改/清除「服务至」日期；花名册返回该日期。

## 文件范围（预期，不限于）

- `db/migrations/0083-service-term.sql`（开工先 `git ls-files db/migrations | tail` 核实下一个空号）
- `src/db/types.ts`（`bind_requests.service_until`）
- `src/routes/bind-requests.ts`（accept body）及其 domain 函数
- `src/routes/coach.ts` + 对应 db/domain 模块（新 PUT 接口、花名册字段）
- 对应测试文件

## 约束

- 迁移纯新增：`ALTER TABLE bind_requests ADD COLUMN IF NOT EXISTS service_until DATE;`，可重跑，附 Down 注释；不碰存量行。迁移不在本卡执行到任何真实库。
- DATE 一律以 `'YYYY-MM-DD'` 字符串进出（仓规 DATE-as-text，别动 OID 1082 解析器）。
- accept body 仍 `.strict()`；只新增可选 `service_until: date | null`。旧请求体行为逐字节不变（iOS、安卓、网页都在调）。
- `PUT /coach/students/:id/service-term`：body `{ service_until: 'YYYY-MM-DD' | null }`，`.strict()`；只作用于当前 accepted 行；无 accepted 关系（含 ended）→ 404 `COACH_STUDENT_NOT_FOUND`；学员角色 403；非法日期或晚于「今天 + 5 年」→ 400（沿用现有 validation 错误信封）；过去日期允许。返回 `{ service_until }`。
- `GET /coach/students` 每个学员加 `service_until`（当前 accepted 行的值；`include_ended=1` 的 ended 学员为 null）。057 的固定查询条数测试必须继续绿，不得新增按学员数增长的查询。
- 不在后端算剩余天数；不改 overview-alerts、每日摘要、推送、学员端接口。

## 验收标准

即 SPEC「验收清单」1–4 条，全部要有测试覆盖；第 5 条（部署 staging 后 curl）由 Opus 收货时做，本卡不做。另：`npm test`、lint、typecheck 全绿，输出贴进 JOURNAL。

## 测试 seam（先红后绿，红的输出存进 JOURNAL）

1. 现有 bind-requests accept 路由测试：`service_until` 不传 / null / 合法日期 / 非法日期 四例。
2. 现有 coach 路由测试（`/coach/students` 所在文件）：PUT 设置、修改、清除、非本教练 404、ended 404、学员 403、非法与超 5 年 400、过去日期 200；花名册带字段、ended 为 null、解绑后重新申请接受（不传）为 null。

## 交付

改动留在工作区，**不 commit、不 push、不开 PR**（收货后由 Opus 提交并开 PR）。JOURNAL 写明迁移号、改动文件清单、测试输出摘要与任何偏离。
