# 067 — 旧周期练完再接新计划

Status: InProgress · T2 / P1 · 2026-11-16

产品规则以 [110 快照](IOS-SPEC-110-SNAPSHOT.md) 与 David 本轮修订第 3 项为准；后者覆盖快照旧包过滤条款。仅工作区交付，不 commit / push / 部署 / 连库。

## 契约

`GET /students/:studentId/plan-handoff` 返回 `{ current_plan_id: string | null, plans: [...] }`。
计划按 start_date、created_at、id 升序，条目沿用 `toPlan` 全部字段，增加 `completed_training_days`、`total_training_days`、`handoff_status: current | upcoming | past`。计划自身 `status` 保留 published。

学员只读本人当前有效绑定的教练计划；旧数据多绑定时复用 canonical accepted bond。教练只读自己有效绑定学员、自己名下计划。无有效绑定的学员返回空；教练无有效绑定返回 403 `BIND_NOT_ACCEPTED`；跨学员读返回 403 `AUTHORIZATION_FORBIDDEN`。UUID 错误沿用 400 `VALIDATION_ERROR`。

同教练/学员 pair 为现有存储可表达的绑定边界：plans 无 bind_request_id；重新绑定后保留该 pair 历史，不以重新绑定时间切掉旧记录。不得跨教练选锚。

## 推导和旧包

纯函数 seam：`src/domain/plan-handoff.ts`。最新记录时间取组记录 logged_at 与结算 completed_at 最大值，所有组（含额外组、自加动作）均可建立锚；无计划关联的自由训练不算。休息日不计训练日；结算行存在即已结算，不以组是否做完或日期判断。

锚有未结算日则留在锚；否则在 start_date 严格晚于锚的计划中找最早未完计划。完全无记录取最早未完；其余回退最近 published_at（null 最小），再 created_at、id 最大。空计划不参与前三支。锚时间并列按 created_at、id 最大；接续日期并列按 created_at、id 升序。当前之外，在接续顺序之后且有未结算日的为 upcoming，其余 past。

原 `GET /students/:studentId/plans` 删除 #412 日期过滤。学员分支仅隐藏同一教练范围内排在 current 后面、没有任何记录的其他 published 计划；保留所有有记录计划及所有排在 current 之前的计划。`include_all=true` 返回完整列表；false/缺省启用兼容过滤，其他值 400。保持原排序、字段和教练分支。旧列表保留历史教练的计划读取，不增绑定读限制。

已接受边界：更早计划恢复发布、发布时间更晚时，旧包可能仍错选它；未来计划应用内未读提示延至接续（待产品知会），推送照常；教练对未触碰待接续计划的留言，旧包学员可能无法跳转；旧教练包仍取最近发布，规则 7 仅对新客户端成立。不改 published_at、不加额外补丁。垫片退场：三端改用新契约，完整列表消费者显式使用 include_all 后，待旧包退场另卡移除默认过滤。

## 日期冲突

同 coach_id / trainee_id 的 published 计划闭区间不得新重叠。结束范围为 end_date 与 effectivePlanDays 非休息日最大日期的较晚者；仅增 plan_weeks 而没有实际日不凭空扩范围。发布、恢复发布、PATCH 日历、batch、旧单日 POST/PATCH、双方后移及撤销后移在事务内校验；按学员锁再计划锁串行化竞争写入。

409 `{ error: "PLAN_DATES_OVERLAP", conflicts: [{ id, name, start_date, end_date }], required_shift_days?: number }`，end_date 为冲突计划有效末日。后移冲突附下一份需要顺延的最小天数，不执行联动。新交集不包含于旧交集才阻止，存量相同或缩小的交集允许，不相关编辑不受影响。不改存量数据。

## 验收与边界

测试 seam 已由任务卡确认：纯函数四支、并列、空/休息日与撤销；HTTP 新契约权限、修订过滤和发布/PATCH/batch/shift 冲突；fixtures 为三端公开 JSON。先红后绿，全量 gates 及独立双轴审查证据见 JOURNAL。

Out of Scope：客户端 UI/缓存/写入门禁改造、后移联动、plan_ending、线上修复或数据迁移、服务端保存选择指针。只读清单脚本只写不运行。A–F、H、J、M、P 覆盖和不能覆盖的端侧行为逐项记 JOURNAL。
