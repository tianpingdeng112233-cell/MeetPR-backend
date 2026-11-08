# 057 · 卡 A — 教练解绑 + 学员备注 + 学员栏数据（后端全量）

先读仓根 `CONTEXT.md`（「解绑」「学员备注」是本卡新词；注意「教练叫法」是动作收录用语，与学员备注无关）、`CLAUDE.md`，再完整读 `specs/057-coach-unbind-alias/SPEC.md`——它是唯一验收口径，本卡只补执行细节。分支 `feat/057-coach-unbind-alias`（基于 `origin/staging`），worktree `MeetPR-backend-wt-057`，依赖已装好（pnpm）。

## 为什么一张卡
一条纯新增迁移 + 同一 coach 路由组的解绑 / 备注 / 花名册扩展 + 读权限放宽，同一模块、同一次部署；拆开任何一半都没法单独验收（网页学员栏要的是整套）。

## 目标
1. 迁移 `db/migrations/0082-coach-unbind-alias.sql`（2026-11-02 Opus 已核：staging 头 0081，open PR 占号最高 0073；开工再 `git ls-tree` 全部远端分支复核一次，被占就顺延并在 JOURNAL 写明）。内容见 SPEC §1：`bind_request_status` 加 `ended`、`bind_requests.ended_at`、新表 `coach_student_aliases`。整段可在 DMS SQLConsole 一次执行、可重跑（`IF NOT EXISTS` / `ADD VALUE IF NOT EXISTS`）；脚本内不使用新枚举值；文件尾写 Down 说明。`src/db/types.ts` 手工补类型。
2. `POST /coach/students/:id/unbind`（SPEC §2），推送 `bind_ended` 入队照 055 / `src/routes/bind-requests.ts` 里 `tryEnqueuePushOutbox` 的写法，三语文案走现有 `copy()` / 繁体机制。
3. 对外状态兼容（SPEC §3）：`src/handlers/bind-requests.ts` 与 `src/handlers/coach-bind-requests.ts` 的 `toBindRequest` 及同类序列化，`ended` 一律输出 `cancelled` + `ended_at`。全仓 grep 任何把 `status` 直接吐给客户端的地方，一处都不能漏出字面 `ended`。学员 `/bind-requests/me` 在被解绑、未提交新申请前返回这条行（带 `coach_display_name`）。
4. `src/db/bonds.ts` 新增 `hasCoachReadAccess`（SPEC §4）。逐个审 coach 读接口，按 SPEC §4 清单切到新函数；写接口、聊天发送、`overview-alerts`、每日摘要、活动结算保持只认 accepted。切过的与刻意没切的接口都在 JOURNAL 列表（文件:函数 → 切/不切 + 理由）。
5. `GET /coach/students`（`listCoachStudents`）：默认成员不变；`include_ended=1` 追加 ended；追加字段 `alias` / `bond_status` / `ended_at` / `today` / `pending_video_count`（SPEC §5）。
   - `today` 的「今天」与顺延口径复用 `src/domain/overview-alerts.ts` 与 `src/handlers/plan-day-completions.ts` 现有 `trainingDay` / 时区 / `effectivePlanDays` 工具，不自造。
   - `pending_video_count`：网页反馈按钮角标 = 学员视频中 `viewed_at` 为空的条数（plan-web `PlanEditor.tsx` 里 `videoFeedback.entries.filter(v => v.video.viewed_at == null)`，按当前打开的计划过滤）。后端按「该学员、本教练可见、`viewed_at` 为空」统计；若与网页按计划过滤的口径有差异，在 JOURNAL 写清差异，不要自行扩大范围。
   - 查询条数固定：照 `tests/coach-overview-alerts.test.ts` 里「fifty students constant query count」那条写法。
6. `PATCH /coach/students/:id`（`renameCoachStudent`）改写 `coach_student_aliases`（SPEC §6），兼容旧 body `{display_name}`；不再写 `student_profiles.display_name`；已解绑 → 404。
7. `GET /coach/bind-requests` 追加 `previously_ended_at`（SPEC §7）。

## 约束
- 只加不改：花名册默认响应、bind-requests 现有字段、推送其它 kind、overview-alerts 的行为与形状都不变（CLAUDE.md「只加不改」条）。iOS / 安卓旧客户端必须照常解码。
- 迁移纯新增，不改存量行、不回填。
- 不 commit、不 push、不开 PR、不改锁文件、不碰 `db/MIGRATIONS-APPLIED.md`。
- 守仓内 eslint + prettier 配置（唯一事实源是仓内配置）。

## 测试 seam（先红后绿，红要实际跑出来）
1. `tests/coach-students.test.ts`（主力，路由最高层）：解绑（SPEC 验收 2）、备注（7）、`include_ended` 与 `today` 三态含跨时区与凌晨边界（6）、固定查询条数、重新绑定后 alias 仍在（8）。
2. `tests/bind-requests.test.ts` + `tests/coach-bind-requests.test.ts`：ended → `cancelled` + `ended_at`、`/me` 返回被解绑行（4）、`previously_ended_at`（8）。
3. `tests/push-outbox.test.ts`：`bind_ended` 三语 + 空名兜底 + 入队失败接口仍 200（3）。
4. `bonds.ts`：`hasCoachReadAccess` 单测；挑一个读接口（ended 可读）和一个写接口（ended 403）各一条授权测试，再加聊天发送 403、overview-alerts 不含 ended 学员各一条（5）。
5. 迁移测试按 `tests/migrations/` 现有写法，含「带存量 bind_requests 行执行两遍、行不变」（1）。
6. 全量 `pnpm test` / `pnpm typecheck` / `pnpm lint` 全绿（9 的前半）。

## 交付
写 `docs/journal/2026-11-02-057-card-a.md`（一卡一文件，返修追加在同文件）：改动文件、每个 seam 的红 → 绿证据（命令 + 数字）、三项全量检查结果、最终迁移号、§4 读/写接口切换清单、与 SPEC 不一致或拿不准的地方（尤其 `pending_video_count` 口径、`today` 的顺延计算、`/me` 现行接口路径）。
