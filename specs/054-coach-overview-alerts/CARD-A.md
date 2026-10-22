# 054 · 卡 A — 总览提醒汇总接口 + 已看记录

先读仓根 `CONTEXT.md`（「计划快结束」「RPE 超标」「未完成」「落后」「待处理区」是本卡新词）、`CLAUDE.md`，再完整读 `specs/054-coach-overview-alerts/SPEC.md`——它是唯一验收口径。分支 `feat/054-overview-alerts`（基于 `origin/staging` + spec），worktree `MeetPR-backend-wt-054`。

## 为什么一张卡
一个只读汇总路由 + 一个已看写入 + 一张新表，同一模块、同一次部署，拆开没有独立验收价值。

## 目标
1. 迁移 `0079-coach-student-plan-views.sql`（开工先 `git ls-tree` 全部远端分支核实 0076–0078 占用情况，冲突就顺延并在 JOURNAL 说明）；`src/db/types.ts` 手工补表类型。
2. `POST /coach/students/:studentId/plan-viewed`（SPEC §2）。
3. `GET /coach/overview-alerts`（SPEC §3），判定逻辑放纯函数 `src/domain/overview-alerts.ts`，路由只负责一次性批量取数（禁止按学员 N+1）+ 调纯函数 + 序列化。
4. 推荐日期一律复用 `src/domain/plan-calendar.ts` `effectivePlanDays`；「今天」复用 `utils/date` / `utils/timezone` 现有学员时区口径，不自造。
5. 路由挂在现有 coach 路由组旁，鉴权与学员归属校验沿用现有写法（参照 `src/routes/signals.ts`、`coach.ts`）。

## 约束
- 只加不改：不动 `student_signals`、结算任务、推送、`exercise-stats`、bind-requests、会话接口的任何现有行为与响应形状（CLAUDE.md 第 8 条）。
- 迁移纯新增，不回填、不改存量行。
- 不 commit、不 push、不开 PR、不改锁文件、不碰 `db/MIGRATIONS-APPLIED.md`。

## 测试 seam（先红后绿，红要实际跑出来）
1. `tests/domain/overview-alerts.test.ts`（主力）：SPEC 验收清单第 3–7 条每条至少一正一反。
2. `tests/coach-overview-alerts.test.ts`（路由最高层，夹具复用现有 coach 路由测试 helper）：清单第 2、8 条 + 一条端到端（造计划与日志 → GET 出现 → POST plan-viewed → GET 中 rpe_over/incomplete/behind 消失、plan_ending 仍在）。
3. 迁移测试按 `tests/migrations/` 现有写法。
4. 现有全量测试全绿（清单第 9 条）。

## 交付
在 `docs/CODEX-JOURNAL.md` 追加一段：改动文件、红 → 绿证据（命令 + 数字）、`pnpm test` / `pnpm exec tsc --noEmit` / lint 结果（本仓用 pnpm，依赖已装好）、最终迁移号、与 SPEC 不一致或拿不准的地方（尤其时区、`coach_rpe` 覆盖、额外组识别方式）。
