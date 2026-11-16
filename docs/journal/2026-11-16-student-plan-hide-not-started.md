# 学员计划列表隐藏尚未开始的计划

## 范围与现场

- 依据：David 本轮批准的 P0/T1 任务卡；工作区 `MeetPR-backend-wt-plan-by-date`，分支 `fix/student-plan-hide-not-started`，基线 `42194b1`。开工工作区干净。
- 只改 `src/routes/plans/index.ts` 的学员列表分支，新增 `tests/plans/student-plan-visibility.test.ts`，以及本 JOURNAL。
- 有 published 计划覆盖学员当地今天时，列表隐藏未来才开始的 published 计划；否则保持全部返回，原顺序与序列化字段不变。教练列表、按 ID 读取详情均不改。
- 结束日下限为 `end_date`，若存在更晚的实际训练日，则继续覆盖到该日。批量读取非休息日，复用 `planShiftSummaries` 已取到的后移记录及 `effectivePlanDays`，无逐计划数据库查询。

## 日期口径依据

- `src/utils/date.ts` 的 `localCalendarDate` 明确用于非训练日的计划日历规则；`src/routes/plans/index.ts` 的 `lockPlanShiftContext` 读取学员 `users.timezone`，学员后移路径以该时区的 `localCalendarDate` 求今天。本次沿用此口径，当地零点切换。
- 已对照 `src/routes/training-streak.ts`、`src/routes/signals.ts` 的今日会话和 `src/handlers/coach-students.ts` 的今日训练：它们使用 `trainingDay`，当地凌晨 4 点切换，用于训练记录归属。本次控制计划开始日期，沿计划日历规则，不套用训练会话切日。
- DATE 比较前用既有 `normalizeDateOnly` 转为 `YYYY-MM-DD` 字符串，兼容 pg-mem 返回 Date 对象的夹具；未改生产 pg DATE parser，也未改变响应日期字段。
- spec 045 明确后移允许越过 `end_date`，且不修改计划起止日。`plan-extension.ts` 本身是延长合法性判定，允许只加 `plan_weeks`；PATCH 与 batch 写路径不会据此自动同步 `end_date`。因此延长周内的实际训练日也可能超过原结束日。本次读取实际日历，未把 `plan_weeks` 直接当结束日。

## 验证

测试 seam 为 `GET /students/:studentId/plans`，使用学员/教练 token、`tests/helpers/studentActions.ts` 的真实 pg-mem 夹具。日期相对运行日构造，固定 Date 时钟。沿 `tests/plans/plans.test.ts` 已用的 `inMemoryRequest` 发完整 Express HTTP 请求；该 helper 使用 supertest 风格接口，但不是 supertest 包，原因是本环境禁止监听端口。未 mock 路由、鉴权或日历实现。

先红后绿事实：`pnpm test tests/plans/student-plan-visibility.test.ts`，未改生产代码时主回归 1 failed（实际多返回未来计划）；最小过滤后 1 passed；加入后移用例后 1 failed / 5 passed，复用有效日历后 6 passed。日志分别在 `/tmp/plan-hide-red.log`、`/tmp/plan-hide-green-first.log`、`/tmp/plan-hide-red-shift.log`、`/tmp/plan-hide-green-shift.log`。

最终用例覆盖任务卡 6 项，以及结束日当天、延长周内训练日/休息日区别、上海零点前后与 Honolulu 当地日期、完整列表条目字段不变、隐藏计划仍可按 ID 读取，共 13 项。

- `pnpm test tests/plans/student-plan-visibility.test.ts`：13 passed。
- 开工基线 `pnpm typecheck && pnpm lint && pnpm test`：typecheck、lint 通过；测试 147 文件通过 / 43 文件失败，1592 passed / 581 failed / 6 skipped，576 个未处理错误；失败为 supertest/实时连接监听端口遭 `listen EPERM`，含 `Cannot read properties of null (reading 'port')`。
- 最终 `pnpm test`：148 文件通过 / 43 文件失败，1605 passed / 581 failed / 6 skipped，576 个未处理错误。将测试名中的随机 UUID 归一化后，581 个失败用例与改前基线完全一致，无新增失败；日志 `/tmp/plan-hide-final-tests.log`。全量验收仍受端口权限阻塞，不能声称全绿。
- `pnpm typecheck && pnpm lint && pnpm format:check && pnpm build` 全部通过；`git diff --check` 通过。
- `pnpm install` 下载 npm 依赖遭 EPERM；从本机 `rest-day-prescriptions/MeetPR-backend` 复制相同 lockfile 的 node_modules 后验证。`cmp pnpm-lock.yaml /Users/david/.codex/worktrees/rest-day-prescriptions/MeetPR-backend/pnpm-lock.yaml` 一致。未改 package.json 或 lockfile；依赖安装流程及 husky prepare 未能完整运行。

## 同类风险

侦察范围：`src/` 中 `published_at`、`currentPlan` / `latestPlan`、计划读取及日期排序，再读取推送、今日卡、会话、连续训练实现。以下只记录，未修改。

| 位置                                                                   | 现有选择方式与风险判断                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/handlers/bind-requests.ts:fetchFirstRun`                          | 按 `published_at ASC` 取绑定后的首份计划，用于首次使用引导，不是最近发布的当前计划；不会被新发布计划顶掉。它不限制开始日，首份未来计划仍可能进入引导，本卡保留。                                                                  |
| `src/handlers/coach-students.ts:listCoachStudents`                     | 遍历全部 published 计划，以 `effectivePlanDays` 匹配学员今日训练日；不选最近发布一份，无同类覆盖问题。                                                                                                                            |
| `src/handlers/training-streak.ts:getStudentTrainingStreak`             | 合并全部 published 计划的有效训练日期，并只保留 `<= asOf`；不按最近发布选计划，无同类覆盖问题。                                                                                                                                   |
| `src/jobs/activity-settlement.ts` 的缺练判定                           | 逐 published 计划按有效日期判断，再按教练选缺练连续数最高者；不取最近发布一份。`src/jobs/daily-digest.ts` 汇总结算信号，不另选当前计划。                                                                                          |
| `src/routes/signals.ts` 的今日 session                                 | 根据学员本地训练日读取 `training_sessions`，没有从计划列表选当前计划。                                                                                                                                                            |
| `src/routes/conversations/index.ts`                                    | 会话引用按具体 `plan_set_id`、训练记录归属检查，没有按发布顺序推导当前计划；客户端若另选计划不在本次后端侦察范围。                                                                                                                |
| `src/domain/overview-alerts.ts:buildOverviewAlerts`                    | `plan_ending` 按最大 `end_date` 选计划，这是 CONTEXT 的“最晚结束且后续未接上”提醒语义，不是学员当前计划。相关风险：未使用后移后的实际末日，可能在后移后过早提醒；新计划虽已发布但与旧计划存在空档时也不提醒旧计划结束。本卡不改。 |
| `src/routes/plans/index.ts` 发布/修改事件，`src/jobs/push-payloads.ts` | 推送携带本次事件的明确 `plan_id`，不查询最近发布计划。未来计划发布后仍会通知、仍能按 ID 打开，符合本卡保留详情访问的范围；`plan_updated` 英文文案含 “current plan”，对未来计划措辞可能不准确，未改。                              |

未发现后端另有 `ORDER BY published_at DESC` 取一份当前计划的实现。`src/routes/plans/index.ts` 的局部变量 `currentPlan` 表示事务内正在编辑的指定计划，不是按发布时间选择。

## 独立审查

按 `review-loop` 以 HEAD 与未提交变更为范围，Standards 和 Spec 两名只读 reviewer 独立审查。仓内缺 `docs/agents/issue-tracker.md`，已提示 David 日后调用 `$setup-matt-pocock-skills`；本次采用任务卡作为本地 Spec，不声称执行了 tracker 流程。审查记录就地保存在本卡，避免超出文件范围。

- Standards：初审 0 项必须修、0 项建议；符合 DATE-as-text、线上兼容和范围约束。
- Spec：初审 0 项缺做/多做/做错；确认计划日历零点口径，独立运行新增测试 13/13 通过；补核 JOURNAL 的日期、同类风险及未做事项，无额外问题。

## 未做事项

- 未 commit、push、开 PR、合并或部署；所有改动留在工作区。尚未上线止血。
- 未改数据、迁移、环境开关、教练列表、详情接口、其他风险点或客户端。
- 原生 supertest 和全量测试仍需在允许本地监听的环境复验；当前环境不能达成“全量绿”的验收条件。

## 部署（2026-11-16）

- [#412](https://github.com/tianpingdeng112233-cell/MeetPR-backend/pull/412) 已合并，`staging@ef17157`。本机全量 191 文件 / 2186 passed（Codex 沙箱内的 581 个失败为端口监听受限，非代码问题）。
- 国内 SAE 已部署 `sha-ef17157ed9499ea9d9b61a261192b841c52122b8`：[镜像构建](https://github.com/tianpingdeng112233-cell/MeetPR-backend/actions/runs/43806713574)、[部署](https://github.com/tianpingdeng112233-cell/MeetPR-backend/actions/runs/43807254945)（`migrations_applied=true`，无新迁移，沿用已应用的 0087，env 未动）通过；独立请求 `/health` 返回 200。
- 目标场景验收：实装方无学员账号，未亲眼核对。2026-11-16 David 直接联系反馈学员，转述其确认「本周计划回来了」；无截图存档。
- 定位变更：David 随后认定「学员不能提前看下周期」「到开始日仍会顶掉未练完的旧周期」两个代价不可接受，本改动降为旧包临时垫片。根治见 iOS 仓 `specs/110-plan-handoff`（含 `AMENDMENT-2026-11-16.md`），垫片退场由 110 后端卡处理。Global 生产未部署。
