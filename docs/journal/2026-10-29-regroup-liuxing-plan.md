# 刘星计划重分周：脚本与本地演练

2026-10-29；执行者 Codex；原始任务是本次 David 消息（已批准的一次性修正，不新增产品行为）。

## 范围与现场

- worktree `MeetPR-backend-wt-regroup`，分支 `chore/regroup-liuxing-plan`，HEAD `7606c37`。开工 git status 干净；已读 CONTEXT、AGENTS、CLAUDE、FOLLOWUPS、DMS 注意事项、engineering-workflow。F-001 的 shift FK reconciliation 不在本次范围。
- **未连接 staging 或任何远端数据库；未读凭证；未 commit/push。真实 plan_id、真实行数及创建来源尚未取证。** SQL 留 UUID 占位，David 在 DMS 手动执行。本地结果不是线上执行或产品验收结论。
- 文件：[DMS SQL](../../scripts/oneoff/2026-10-29-regroup-liuxing-plan.sql)、[一次性演练](../../scripts/oneoff/2026-10-29-regroup-liuxing-plan.test.mjs)。不加入迁移序列、不改业务代码或正典部署台账。

## Schema 与日期语义

`plans` 有 `start_date DATE`、`end_date DATE`、`plan_weeks SMALLINT`（0020 放宽至 1–52）、`anchor_weekday SMALLINT NULL`（ISO 周一=1，周六=6）、`status`、`published_at`、`updated_at`。没有另一份周数列。`kind=adaptation` 限一周，本脚本只接受已发布的 regular 六周计划。

`plan_days.week_number` 为从起点起每七天的 1-based 周序；`day_of_week` 是周内相对偏移 **1..7，不是 ISO 星期**。确切公式：

```text
actual_date = start_date + (week_number - 1) * 7 + day_of_week - 1
new_week    = (actual_date - 2026-10-31) / 7 + 1
new_day     = (actual_date - 2026-10-31) % 7 + 1
```

先删除获准的早期空行，所以除法只处理非负整数。`sort_order` 和保留天的 `id` 不变。

证据：backend `src/domain/plan-calendar.ts:27–39` 的 `plannedDate` 明文说明 ordinal；`src/routes/plans/serialization.ts` 及 `index.ts:875` 使用该函数。plan-web `origin/main=a56da09`，`mapping.ts:92` 的 `planDayDate(startDate, weekNumber, dow)` 加 `(weekNumber-1)*7+dow`，`mapPlanToWeeks` 将后端 `day_of_week-1` 映射到前端 `dow`。没有按星期一重对齐。

周数取保留天 `max(new_week_number)`；结束日沿用客户端 `planEndISO` / iOS `persistDraft` 的整周规则：`start_date + plan_weeks*7 - 1`。这不是后端 POST 强制的日期约束。给定形状最后训练日是 **12/06**，但六周区间结束日为 **12/11**。新 W1 为 10/31、11/01、11/03、11/04；新 W6 只有 12/05、12/06。`anchor_weekday` 改 6；`published_at/status`、处方内容及所有存续父子 ID 不改。

本地用全部 73 份迁移重建 schema，查询 `pg_catalog.pg_constraint` 得到下面的引用路径；数据库没有计划树触发器/物化快照。SQL 对未知的新增计划树入向 FK 中止，不能代替未来 schema 的重新审查。

| 表/字段或语义依赖                                                                                                                                 | 本次处理                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan_days.plan_id` → plans；`plan_exercises.plan_day_id` → days；`plan_sets.plan_exercise_id` → exercises                                        | 四张全列备份；仅改计划时间字段、天的周/日序，删早期零动作占位天。动作即使零 sets 也算内容，禁止删除。                                                                                                                                                          |
| `set_logs.plan_exercise_id`（RESTRICT），`plan_day_id`（0074，学员自加）                                                                          | 任意记录都中止，含 `completed=false`、failed、assumed、额外组及 adhoc。不仅检查 completed。无归属记录另按该学员日期窗口保守拦截。                                                                                                                              |
| `plan_day_completions.plan_day_id`，`source/completed_at`                                                                                         | 任意完成标记中止。                                                                                                                                                                                                                                             |
| `plan_day_shifts.plan_day_id/student_id/shifted_to_date/batch_id/seq`；`plan_shift_batches.plan_id/anchor_date/offset_days`                       | spec 045、0037/0038/0070：推荐日期可被后移覆盖。任一天级行或计划批次都中止，包括无父批次旧行、无子行父批次；不尝试重写后移。                                                                                                                                   |
| spec 092「换天练」                                                                                                                                | iOS `specs/092-flexible-day-self-added/SPEC.md`（`MeetPR-wt-092b`）明确后端零改动，本周=游标日的 `week_number`；只是选择同周另一日记组/结算，不交换计划行。落库结果由上述 logs/completions 覆盖；只点击未提交的客户端选择无法在 SQL 识别，执行时须关闭客户端。 |
| `training_sessions.plan_day_ids UUID[]`（无 FK）、`student_id/session_date`                                                                       | 同时查 ID 数组和学员日期窗口，有会话即中止，防止无现存组记录的已结算/归档状态漏检。                                                                                                                                                                            |
| `feedback.plan_exercise_id/day_date/video_id`                                                                                                     | 沿动作、学员日期、视频来源备份；存在即保守中止。                                                                                                                                                                                                               |
| `attachments.source_plan_id/set_log_id`，`video_markers.video_id/attachment_id`                                                                   | 备份视频和打点、标注图片（即使图片无 source_plan_id/set_log_id）；存在即中止。图片也可能被 messages 引用。                                                                                                                                                     |
| `messages.video_id/attachment_id/set_ref`                                                                                                         | 沿附件及 JSON `plan_set_id/set_log_id` 备份并中止。`src/domain/set-ref.ts` 存日期、组序和 ID，不存 week/day 序。                                                                                                                                               |
| `plan_pending_revisions.plan_id/version/content_hash/content`                                                                                     | 待发布 JSON 可携带旧位置，存在即中止，不丢弃草稿、不随意改 hash/version。后端没有独立 published-plan 版本表；当前已发布树就是 plans/days/exercises/sets。                                                                                                      |
| `session_reviews.student_id/review_date`，`student_events.student_id/session_date/payload`，`student_signals.student_id/payload`                  | 备份并中止；signals 仅纳入该学员 `opened_at >= DATE '2026-10-26'` 的行（仍不限状态）；更早信号不依赖计划周/日位置，日期未动，保留原样且不拦截。                                                                                                                |
| `notification_outbox.aggregate_id/payload.plan_id`                                                                                                | 备份并原样保留。发布 payload 仅 plan_id/trainee_id（`index.ts:1666`），更新 payload 为 ID/名字（`:1974`）；不存周/日位置。无需重发发布通知。                                                                                                                   |
| readiness、评估及 `student_evaluation_versions`、body weight、`coach_student_plan_views`、digest watermarks、`variation_logs.last_used_week DATE` | 按用户/自然日期或评估自身版本归属，没有 plan_day FK 或 week_number/day_of_week 键；日期未移动、记录未改，不需重写。查看水位不冒充新发布。                                                                                                                      |
| analytics `events.props`、通用反馈                                                                                                                | 历史事件/自然时间，不是当前计划位置的权威副本；不重写历史埋点。                                                                                                                                                                                                |
| 游标、behind/settlement、训练可写周、统计/视频/反馈读取                                                                                           | 从当前计划树和原始记录派生；保留日期/ID且拒绝已有训练状态，按新分周自然重新计算。                                                                                                                                                                              |

B 建立 **9 张** `public.rglx_*_20261029` 表：四张 typed 原图、十四类关联表的 JSONB 全列行副本、两张 C 后图、run 元数据、scope 清单。空表也在 B 计数中显示；没有删除或覆盖备份的 SQL。未修改的 exercise/set/关联行无需 E 重插，E 先证明它们仍与 B 相同，再原位恢复修改字段和早期占位行，并逐行比较原图。

### 网页非数据库状态

`draftMirror.ts` 有 localStorage 草稿；已发布计划即使 `updated_at` 较新仍可能提示恢复旧本地副本（`PlanEditor.tsx:531–545`）。SQL 无权修改浏览器缓存。执行前教练保存好需要保留的草稿并关闭所有编辑页；若 B 查出 pending revision 则停止。执行后重新打开并使用服务器版，**不要恢复旧待发布草稿**；若不能确认旧副本是否有未保存工作，停止并交回，不清空浏览器数据。

`blockPlanSettings.ts` 的 weekday/extra-weekday 是本地视图元数据（0=周一）；实际星期没有变化。`blockGridModel.ts:67–76` 会按新 startDate 对列进行日历排序，正常显示应为六、日、二、三。历史/撤销栈是编辑器内存状态，关闭重开重建；不能把仍开着的旧编辑页当成核验结果。

## 本地演练与限制

仓内 `tests/helpers/migrations.ts` 主要使用 pg-mem；本次 DO/RAISE/事务必须用 PostgreSQL 引擎。先尝试本机 PostgreSQL 17：

```sh
/opt/homebrew/opt/postgresql@17/bin/initdb -D /private/tmp/meetpr-regroup-pg -A trust --no-locale -E UTF8
```

结果：`could not create shared memory segment: Operation not permitted`；初始化自动清掉未成功目录，本地 5432 无可用服务。未提升权限，也未转远端。随后从已有 npm 缓存离线解出 PGlite 0.5.10（归档 10,206,211 bytes）到 `/private/tmp/regroup-pglite`，**实际版本 PostgreSQL 18.6 / wasm**；不是 pg-mem，也不是 staging 所用原生进程。此前 `/private/tmp/meetpr-052-pglite.HAfrhl` 仅残留空目录，未作为成功安装证据。

```sh
node scripts/oneoff/2026-10-29-regroup-liuxing-plan.test.mjs \
  /private/tmp/regroup-pglite/package/dist/index.js
```

演练程序不读取 DATABASE_URL/dotenv，不建网络连接；仅 new PGlite() 的独立内存库，按序运行仓内全部 **73** 个 SQL migration。每个 fixture 都将 `search_path` 设为 `information_schema`，直接执行从交付 SQL 抽取的完整 A/B/C/D/E；只替换 UUID 占位。不 mock 守卫。

TDD 第一轮用占位 SELECT，日期断言确实红：实际 10/26、12/06、anchor=1，期望 10/31、12/11、anchor=6。随后完整实现转绿。审查新增的标注图片备份测试亦先对旧 SQL 复现遗漏，再验证补丁。

| 演练                        | 输出/断言                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 有 10/27、10/28 空天        | days **24→22**，删除 **2**；exercises **22→22**，sets **66→66**；逐 ID 日期差 **0**、处方/组差 **0**，原父 ID 不变                       |
| 无空天                      | days **22→22**，删除 **0**；各周天数 **4,4,4,4,4,2**                                                                                     |
| 两种形状的日历              | W1=**10/31,11/01,11/03,11/04**；6 周；end=**12/11**；W6 两天为 12/05、12/06                                                              |
| E 恢复                      | 原 start=**10/26**、end=**12/06**、weeks=**6**、anchor=**1**；分别恢复 **24/22** 天；原行 JSONB 全相等，差 **0**                         |
| 训练守卫                    | 普通未完成组、额外组、自加动作、完成标记、孤儿天级 shift、空父 shift batch、pending revision、无组会话：各自 **RAISE**，整棵树修改 **0** |
| 早期内容                    | 10/27 新增 1 条零 sets 动作仍 **RAISE**，删除 **0**                                                                                      |
| B 后新增训练 / C 后新增训练 | 分别阻断 C / E：`related rows changed since backup: set_logs`；失败事务树差 **0**                                                        |
| 最后日期校验                | 测试用 trigger 故意把 UPDATE 日期加一天，触发 `per-ID date invariant failed`；整事务回滚，树差 **0**                                     |
| 唯一性、重复 B              | 2 个匹配计划时 A count=**2**、B 中止；已有备份重复 B 中止且不覆盖                                                                        |
| 实际周数变化                | 去掉原 W6 的变体算得 **5** 周、end=**12/04**；E 恢复原 6 周。脚本没有硬写新周数=6                                                        |
| 视频关联备份                | **1** 视频 + **1** 无计划来源的标注图 + **1** marker + **1** image message 均备份；C 中止                                                |

限制：PGlite 验证了 SQL/PLpgSQL、约束、事务回滚和 search_path；未验证原生多连接锁竞争、阿里云 PG 具体版本/权限、DMS 执行器的会话处理。B/C/E 使用同一显式事务及 `SHARE ROW EXCLUSIVE ... NOWAIT` 锁住相关业务表，拒绝并发写入；这会短暂影响其它用户写入，单条语句限时 30 秒（主要修改位于一个 DO 块），遇锁立即停；报错后仍须显式 ROLLBACK 释放事务锁。B→C、C→E 分段空隙另以全行前/后图检测漂移。执行窗口须由 David 安排。

环境基线：按要求尝试 `npm ci`，受网络限制未完成并已停止；`npm ci --offline --ignore-scripts` 报 ENOTCACHED。借用同机已有 node_modules 后，typecheck 缺 compression/ws/AWS SDK 等；全仓测试 **90 文件通过、79 文件因缺依赖失败，492 tests 通过**。全仓 ESLint 另报 72 个错误（缺依赖造成类型解析失败及既有类型断言检查）；本次 JS 在现有 ESLint 配置中被忽略，另以 node --check/Prettier 检查。不能称全仓绿。专项 SQL 演练独立于这些依赖；没有为本任务改 package/lock 文件。

## 给 David 的 DMS 顺序

1. 确认 SQLConsole 连接的是目标 staging 数据库；计划处于无人编辑/训练的窗口。此处只有 David 操作远端。**不要全选整文件执行**，E 是备用回滚。DMS 默认 `information_schema` 已处理：全部业务/备份表带 `public.`，事务内另设 search_path。
2. 粘贴整个 **A**。首结果 `candidate_count=1` 才继续；核对 coach/trainee/name/status/published/六周区间和全部天。应看到 22 个有内容日及可能的 2 个早期空行（真实动作/组数不应套用 fixture 的 22/66）。重复姓名/多份计划、任何 shift、日期形状不符：停。
3. 在工作副本把 **B 两处、C 一处、E 一处，共四个** `FILL_PLAN_ID_FROM_A` 替换为同一 A 返回 UUID。占位未替换会 UUID 解析失败；即使手填错误 B/C 仍重新验证唯一性。不要按行号截掉 DO、BEGIN 或 COMMIT。
4. 粘贴完整 **B**，确认 COMMIT 成功并保存结果。plans=1；days/动作/组行数应与 A/实际相符；十四类关联表均列出计数。**除 notification_outbox 外任何关联计数非零都停**，包括 `opened_at >= DATE '2026-10-26'` 的 student_signals、反馈/视频、pending revision；10/26 前的历史信号不纳入该计数、不阻断执行。不为通过守卫删除这些数据。B 是该计划范围备份，不是全库备份；保留表，按仓库现有获准备份渠道另行保障全库备份，Codex 本次没有执行远端 backup-db。
5. 粘贴完整 **C**。预期 NOTICE：deleted empty days=0 或 2、old weeks=6、new weeks=6、end=2026-12-11，随后 COMMIT。若实际周数变化，脚本按数据维护并在 NOTICE/D 显示；先保留输出并交回核对，不继续客户端编辑。任何异常/超时/锁冲突立即停，显式 `ROLLBACK;`；不要因后面的 COMMIT 字样忽略前面的错误。备份漂移或已有备份异常，保留证据交回，不能覆盖 B 重试。
6. 粘贴 **D**（只读），确认日期差/动作缺失/组缺失均 **0**；核对 W1 四日期、W6 两日期、start/end/weeks/anchor、22 个内容日及 status/published_at 保持。再重新打开教练网页/学员客户端查看服务器计划，不恢复旧草稿。D 不会清除备份。
7. **仅需撤回且没有后续训练/编辑时**，粘贴完整 **E**。预期恢复 10/26–12/06、6 周及 B 原天数。E 若报状态漂移/新记录就停，不能删真实训练记录来绕过。本地“移除新记录后重试”只用于 synthetic fixture。E 后不要把 D 的新起点预期用于旧计划；用 E 末尾输出与 B 比对。备份表继续保留，清理由另行授权处理。

## 为什么开始日可能是周一

以下均为本地代码证据，不以 repo 中存在函数推断客户端当前入口一定可达。

| 路径                                      | 对 start_date 的决定及结论                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| plan-web 新建弹窗，`origin/main=a56da09`  | `PlanDialogs.tsx:89–101` 要求 `weekdayIndex(startDate)===first`（新建路径无 settings 兼容豁免）；`PlanWorkspace.tsx:692–704` 原样发 start_date 与整周 end_date。因此选择 D1=周六的新计划不能直接填周一。**仍可能**先建一个周一起点空计划、后来删除/未填写最早日；验证的是起点星期，不是第一个有处方日。                                                                                                                                                                                                                                          |
| 已在 origin/main 的旧表格导入（spec 002） | `import/index.ts:660–693` 的 `importStartDate` 取首个有日期周的 `dateSerial - columnIndex`，即列 0 日期，不取第一个有动作格；`buildWeeks` 保留窗口内空周/日期位置。因此周一列 10/26、有内容从周六 10/31 才开始，是直接可生成的形状。没日期则沿用原计划 start_date。                                                                                                                                                                                                                                                                              |
| plan-web 015 / backend 052 的 AI 导入     | 两者**不在本任务 backend 7606c37 / web origin/main a56da09**；为回答明确问题，另只读本机既有分支：web wt-015 `8e309c1`、backend wt-052 `e8f7dfc`。backend `services/plan-import/prompts.ts:6` 明确“有日期返回这周周一”，`ground-week.ts:386/408` 按日期落周一；识别接口本身不创建 plans。web `ImportPlanDialog.tsx:195–208` 有日期时取 `goodWeeks[0].start_date`，设置 end/anchor 并调用 POST /plans；无日期/顺序日则用教练确认的 firstDate。**有日期路径也会得到周一起点，哪怕首次有内容是周六。**不能据此声称 015/052 已部署或刘星实际走过它。 |
| iOS 原生                                  | 查旧主工作树 `c3d27cc` 及 release-1.0-24 `f2d4439`。保留了创建向导与 `BackendPlanRepository.publishPlan`→`api.createPlan`；旧 `PlanningViewModel.persistDraft` 用保存当天零点作为 start_date，而非第一个训练日；这条历史路径也可能起点无处方。**当前 release 壳只有 today/messages/students/profile，没有编排 tab；`CoachEvaluationSeal.isSealed=true` 封住评估入口，原生表格导入 `PlanImportCapability.isEnabled=false`**。不能说当前正常入口能新建六周计划；休眠向导普通计划只给 4 周（`Step1SelectDurationView`），也不能直接解释本案六周。   |
| Android RN                                | 主工作树 `87c5535` 的 `src/app/(coach)/planning.tsx` 是 FeaturePlaceholder；另查 build22 acceptance `a203d9c`，`api/domains/plans.ts` 只有读取/完成等，没有 POST /plans 创建接口。未见可创建计划的原生流程；浏览器访问网页属于上述 web 路径。                                                                                                                                                                                                                                                                                                    |
| 后端 POST /plans                          | `schemas.ts:113–140` 只验合法日期、end>=start、weeks 范围、source 和 adaptation 一周；不要求 start=首训练日、不要求周一、不验证 anchor 与 start 星期一致，也不强制 end=start+weeks\*7-1。`index.ts:1127–1141` 原样写入，创建时尚无 days；之后再写入/删改 days，自然可以让起点无内容。                                                                                                                                                                                                                                                            |

结论：**“周一开始”符合表格按自然周锚定的实现，不等于日期被移动；仅凭日期不能锁定创建路径。** 真正来源要由 David 的操作回忆或另行获准的真实计划/审计证据确认。本次没有查远端，也没有更改任一创建路径。

## 自审与独立审查

使用 tdd（SQL A–E 为用户指定 seam）及 review-loop。本地未配置 Matt issue tracker，未运行依赖 tracker 的 code-review 命令；若今后启用该工作流需 `$setup-matt-pocock-skills`，不阻断本次独立本地双轴审查。

初审 Standards：SQL/test 无实质 finding。Spec：发现标注图片 `video_markers.attachment_id` 漏备份一项，已补附件链与 image-message 路径及回归演练。最终复审结果与验证见本文件追加记录。

### 最终验证与复审

- 最终专项命令再次退出 0；最后增加同学员的第二份 2027 计划，C/E 前后全行相等，证明不误改另一份计划；W6 日期显式断言为 12/05、12/06。
- 标注图回归红证据：旧 SQL 实得 attachments=1（应为2）、messages=0（应为1）；补丁后 2/1/1（attachments/messages/markers）通过。这个反例只在本地合成数据运行。
- Standards 复审：0 个实质问题；已按建议把 statement_timeout 改述为单条语句限时，而不是整个事务截止时间。Spec 复审：初审 1 个备份缺口已关闭，无未决 finding；reviewer 独立复跑专项通过。未把代码自测称为线上验收。
- `node --check`、新增 JS/JOURNAL 的 Prettier 检查通过。最终业务 SQL 仅补 annotation/message 备份，不涉及远端执行。实际 DMS schema/权限及客户端服务器版复核仍由 David 按上述步骤进行。

### 收货返修：student_signals 日期范围

按 David 本次收货意见，只改 SQL `rglx_scope` INSERT 第 13 项的一行：增加 `AND t.opened_at >= DATE '2026-10-26'`。B/C/E 继续共用同一 scope；其它守卫逐字未改。同步上方依赖说明和 DMS 第 4 步，避免旧“全部历史信号中止”的说明残留。

本地新增两个同学员 `missed_training / expired` fixture，以验证日期过滤而非状态过滤：

- **先红**：只加测试、不改 SQL，整套命令退出 **1**。10/27 信号已按预期备份 **1** 行、C 中止、计划树差 **0**；随后 10/01 历史信号在 C 被错误拒绝，报 `STOP: training/completion/added/swap/shift/revision/feedback/video/activity exists; inspect B counts`。
- **转绿**：收窄这一行后整套专项退出 **0**。10/01 信号备份 **0** 行，C 正常 **24→22** 天、日期差 **0**；E 恢复 **24** 天、计划树全行差 **0**，历史信号本身差 **0**。10/27 信号备份 **1** 行，C 中止且计划树差 **0**、信号差 **0**。测试读取日期用 `::text`，兼容 PGlite 的 DATE 返回 Date 对象，不更改业务 SQL。
- **整套复跑**：本地 PGlite PostgreSQL 18.6，全部 **73** 份迁移；有/无空天 **24→22 / 22→22**，动作 **22**、组 **66** 原样保留，日期/处方差 **0**；各周 **4/4/4/4/4/2** 天，仍 **6** 周、end **12/11**；E 精确恢复 **24/22** 天。五周变体、已有全部中止守卫、视频关联备份（**2** 附件/**1** 打点/**1** 消息）及第二份计划不变断言全部通过。

```sh
# 与上一轮相同的离线专项命令；没有 DATABASE_URL 或远端连接。
node scripts/oneoff/2026-10-29-regroup-liuxing-plan.test.mjs \
  /private/tmp/regroup-pglite/package/dist/index.js
```

本轮未重跑已知受缺依赖阻塞的全仓门禁；保留上文环境限制。未 commit、未 push、未连接任何远端数据库。

定向 Spec 复审：无 finding；reviewer 独立复跑整套专项退出 0，确认 SQL 仅此一行变更、两种信号均未修改。新增测试的 `node --check` 与 JS/JOURNAL Prettier 检查通过。

## DMS 版（2026-10-29）

本节取代上文旧脚本的 DMS 执行指引与 **22 天、6 周、12/11** 的假设；旧 SQL 原样保留，不再向 DMS 粘贴旧版 B/C/E。David 已现场确认目标 `02db605c-d113-47ef-9303-1bcabf7b431d` 为 published，原起点 10/26、终点 12/06、6 周，**20 天、0 空天、0 shift**。本地 fixture 按 W1 六日、W2–W5 二三六日、W6 **12/01、12/02** 构造。本轮未连接任何远端数据库，真实动作数 E、组数 T 仍由 DMS 只读输出核对。

交付文件：

- [DMS 专用 SQL](../../scripts/oneoff/2026-10-29-regroup-liuxing-plan-dms.sql)
- [分号拆句演练](../../scripts/oneoff/2026-10-29-regroup-liuxing-plan-dms.test.mjs)

### DMS 粘贴顺序与停止条件

**不要全文件执行。** SQL 内 `-- SECTION S0` 等标记划分粘贴范围：从该标记后第一条语句，到下一标记前结束。S1/S1b 内四条各自以分号结尾，逐条粘贴。S4 仅为备用，不接着 S3 自动执行。所有日期均为 2026 年。

| 段落         | 粘贴内容与预期输出                                                                                                                                                                                                         | 停止条件 / 已有备份处理                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0           | 一条只读语句、一行输出。`target_missing=0`、十类风险计数全 **0**。首次无备份时九个 `backup_*` 也全 **0**。四个原图加旧版五个辅助表均用 `to_regclass` 探测，缺表安全。                                                      | 目标缺失、风险任何非零立即停止。备份标志为 **1** 先核对，不代表训练风险；旧版辅助表不参与本版，不删除。                                                               |
| S1           | 四条创建语句逐条粘贴，依次备份 plans、plan_days、plan_exercises、plan_sets 全列，行数为 **1、20、E、T**。                                                                                                                  | 任一已有表会明确报 `already exists`，不会覆盖。停止批量执行，转 S1b 对应查询核对已有表，再只创建 S0 显示缺失的表。不得删除/清空/改名原备份来绕过错误。                |
| S1b          | 四条独立只读计数，各返回一行 `table_name / backup_rows / current_rows`。已存在的表只粘贴其对应查询；四表齐备后四条均跑。前两对分别 **1=1、20=20**，后两对 **E=E、T=T** 且大于 0。                                          | 缺表报错但零修改。任何计数不符停止。同行数还不够，S2 会逐表用双向 `EXCEPT ALL` 比对完整行（包括 ID、父 ID、处方、updated_at）。旧备份内容不符则 S2 报错，不自动修补。 |
| S2           | 整段是一条修改语句。预期唯一一行：`guard_ok=1`、`start_date=2026-10-31`、`end_date=2026-12-04`、`plan_weeks=5`、`status=published`、`changed_days=20`、`deleted_days=0`、`date_mismatches=0`。                             | 缺备份表在解析时报错；状态、原图、20 天/内容、风险、schema 任一不符，报含 `STOP: S2` 的整数转换错误，整条回滚。错误、空结果或摘要偏差都停止。不重跑已成功的 S2。      |
| S3           | 一条只读语句、一行输出。起止 **10/31–12/04**、**5** 周、`anchor_weekday=6`、published、days **20**，`date_mismatches / missing_exercises / missing_sets` 全 **0**。`week_dates` 按 W1–W5 排列，每周 **4** 天，见下方日历。 | 行数、日期、差异任何不符停止，保留输出交回，不继续编辑。核对后重新打开客户端使用服务器版，不恢复旧本地草稿。                                                          |
| S4（仅备用） | 整段是一条恢复语句。预期 `guard_ok=1`、起止 **10/26–12/06**、**6** 周、`restored_days=20`，anchor_weekday 与 updated_at 精确回到备份值。随后 S3 应显示旧起止/周数，days **20**、三项差异仍 **0**。                         | 只允许当前全行内容符合本次修改后的预期且风险仍全零；缺表、已恢复、处方或计划/天被再编辑、新增训练均停止报错。不要为通过守卫而删除训练或修改备份。                     |

S3 的日期串应为：

```text
W1=2026-10-31,2026-11-01,2026-11-03,2026-11-04
W2=2026-11-07,2026-11-08,2026-11-10,2026-11-11
W3=2026-11-14,2026-11-15,2026-11-17,2026-11-18
W4=2026-11-21,2026-11-22,2026-11-24,2026-11-25
W5=2026-11-28,2026-11-29,2026-12-01,2026-12-02
```

### 原子性、备份依据与边界

- DMS 已在旧版 B 报 `Unterminated dollar quote`，且拆句改写会话设置。本版不用 dollar quote、过程块、显式多句事务、会话设置或显式锁。`UPDATE` 语法必需的 `SET` 子句独占一行，**不是会话设置命令**；这是对任务“禁止 SET”与“必须 UPDATE”的语法兼容解释，已在开工说明。全文件大小写不敏感断言不含 `$`、`DO `、`BEGIN`、`COMMIT`、`SET `、`LOCK `，结果 **0**。
- S2/S4 各自为一条 data-modifying CTE。`MATERIALIZED guard` 对非恒定 CASE 结果转 integer：成功为 `1`，失败为包含 `STOP` 的文本。两个 UPDATE 的 WHERE 和最终输出都依赖该值，即使待更新输入为空也必须求值。缺表直接解析失败。后续计划更新通过 day UPDATE 的 `RETURNING` 计数形成依赖；摘要读取 `RETURNING`，不会误读同一语句的旧快照。
- 迁移 `0003-init-plans.sql:36–48` 定义 `plan_days` 仅有 ID 主键和非唯一 `plan_days_plan_id_idx`；全部 **73** 迁移重建后目录验证唯一索引仅 `plan_days_pkey`，`condeferrable=false`。没有 `(plan_id,week_number,day_of_week[,sort_order])` 唯一约束，直接改键可行；S2/S4 现场若发现任何额外非主键唯一索引则拒绝，避免假定线上约束和本地一致。
- 只备份四张计划树原图。按本轮明确范围，S0 的 set_logs（天/动作/学员窗口）、completion、shift、batch、pending revision、feedback（动作/学员窗口）、training session（天数组/学员窗口）、events、reviews、signals 必须全零，S2/S4 各自重查同一风险口径，因此这些关联表没有可备份的命中行，也不写入或恢复它们。窗口为 **10/26–12/11（含边界）**；signals 为 `opened_at>=10/26`，不按状态排除。10/01 历史信号不拦截、也不修改。
- 四条建表并非同一事务，失败可能只留下部分表。**16** 种存在/不存在组合均演练过；补齐缺表后 S2 再验证完整原图，不能仅凭 S1 成功就认为备份一致。关联表取舍以本轮 S0 明确要求为准，不声称旧版视频/消息 JSON 备份仍在执行。
- **执行窗口内必须停止该计划的训练和编辑，关闭教练/学员所有旧页面并等在途请求结束。** 无显式锁的快照守卫不能排除语句开始后并发插入训练记录；本地演练也没有证明并发写入安全。成功后重开并使用服务器版，保留有价值的本地草稿，不盲目清缓存。
- S4 对比预期后图时忽略 plans.updated_at（本版没有第五张后图表），但其余计划字段、所有天字段、动作和组的完整内容均核对；恢复时 updated_at 使用原图。仅更新时间戳、未改业务内容的写入不能单独识别。已有旧版辅助表不会给本版赋予额外执行状态。
- PGlite 验证的是 PostgreSQL 语法与逐分号提交，不是阿里云 DMS 改写器的现场验收。DMS 若仍报语法/权限错误，停下保存完整错误，不用旧脚本重试。

### 本地演练证据

```sh
node scripts/oneoff/2026-10-29-regroup-liuxing-plan-dms.test.mjs \
  /private/tmp/regroup-pglite/package/dist/index.js
```

PGlite **0.5.10 / PostgreSQL 18.6 wasm**，全部 **73** 迁移。新脚本按分号拆为 **12** 条，各次调用只送一条 `db.query`，不把目标步骤包进测试事务；schema/fixture 建立另行执行。所有永久表均显式 public，测试会话 search_path 为 information_schema。

- **先红**：占位 S2 只读，断言实际仍 10/26、12/06、6 周，期望 10/31、12/04、5 周；进程退出 1。
- **转绿**：S0 全零；S1 **1/20/20/60**；S2/S3 **20→20 天、20→20 动作、60→60 组**，删除 **0**，日期/处方/组差 **0**，每周 **4/4/4/4/4** 天；S4 全行恢复原状（含 updated_at），差 **0**。
- **14 条风险路径**：三种 set_log 归属、completion、孤儿 shift、空 batch、revision、两种 feedback、两种 session、event、review、10/26 信号，逐个证明 S0=1、S2/S4 都报错、失败后计划树差 **0**；包含关联 ID 的窗口外记录，以及无关联 ID 的窗口边界记录。
- 状态/start/end/weeks/name/处方/组被改、目标缺失、空备份、10/31 前有内容、未知唯一索引均拒绝；S2 重跑、S4 重跑均拒绝。**16** 种部分备份组合中，缺表 S2/S4 报错零修改；已有表创建报错且原内容不变，补齐后正常修改/恢复。
- 总计 **72** 次守卫失败均零修改；所有专项断言通过。真实数据库的 E/T 不由 fixture 的 **20/60** 推断。

全仓基线仍受既有依赖缺失限制：`pnpm typecheck` 缺 compression、ws、AWS SDK；`CI=true pnpm install --offline` 在 AWS SDK 缓存缺失处失败。已恢复借用本机主工作树的现有 node_modules，没有改 package/lock 文件。专项不依赖这些包。

### DMS 版最终自测与审查

- `review-loop` 两名只读 reviewer 独立运行专项并核对 JOURNAL：**Standards 0 finding；Spec 0 finding**。未运行缺 tracker 的完整 Matt 工作流；没有私建 tracker。依据是 David 本轮明确的一次性修正要求，不新增产品行为。
- 最终专项、`node --check`、`git diff --check` 与全仓 `pnpm format:check` 均通过。原 SQL 与原演练文件未改。
- 全仓 `pnpm lint` 仍为既有 **72 errors**；typecheck/build 受 compression/ws/AWS SDK 缺依赖阻塞；最终 `pnpm test` 为 **90 文件通过、79 文件加载失败、492 tests 通过**。首次测试另遇借用 node_modules 的缓存写权限问题，已将依赖链接放在本地目录并用本地缓存复跑，最终不再有该权限错误。不能声称全仓门禁通过。
- 仅在 `chore/regroup-liuxing-plan` 做本地提交，不 push；未连接远端数据库，未执行真实修正。

本地提交尝试未完成：`git add` / `git commit` 报 `Unable to create .../MeetPR-backend/.git/worktrees/MeetPR-backend-wt-regroup/index.lock: Operation not permitted`。共享 Git 目录不在当前可写根内，当前会话不允许提权。三个文件保留在本分支工作区，较早版本已暂存、末尾验证记录尚未暂存；**没有新 commit，没有 push**。在具有该 Git 目录写权限的本机终端可执行：

```sh
cd /Users/david/Projects/apps/MeetPR-backend-wt-regroup
git add scripts/oneoff/2026-10-29-regroup-liuxing-plan-dms.sql \
  scripts/oneoff/2026-10-29-regroup-liuxing-plan-dms.test.mjs \
  docs/journal/2026-10-29-regroup-liuxing-plan.md
git commit -m "fix: add atomic DMS-compatible plan regroup script"
```
