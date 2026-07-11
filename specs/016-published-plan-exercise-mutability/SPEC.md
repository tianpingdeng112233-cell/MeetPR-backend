# 016 — 计划树历史锁收窄到动作颗粒度(published plan exercise-granularity mutability)

**Status:** InProgress(冻结时点 = 本 spec PR 合并;合并前的 PR review 修改照常,后续改动写后续 spec——满足 AGENTS.md 开工门)
**Date:** 2026-07-11
**P 档:** P1(下一班车)
**拍板:** David 2026-07-11 —— 已发布计划就地编辑按**动作颗粒度**落地(B 方案);plan-web PR #5 的「已发布 · 只读弹窗」降级为过渡态,本 spec + plan-web spec 004 落地后替换。组级颗粒度、session 内动态调整均已议未采(见「不做」)。

> ⚠️ 迁移号纪律:本 spec **不含 migration**(纯路由层 + 序列化)。若实装中发现需要索引,现场取号,勿照任何文档写死。
>
> ⚠️ 本 spec 以 2026-07-11 的 staging(head 651840a,restage 合并后)为现状基线,不是以 feat/043 分支为基线——门函数名/行为以下文「现状」为准。

## 背景与现状(2026-07-11 现场核实)

- **0031 已根治级联删打卡**:`set_logs.plan_exercise_id` 现为 nullable + `ON DELETE SET NULL`,并新增 `exercise_id NOT NULL`(直挂动作库)与 `logged_date`。删除 plan_exercise 不再抹掉学员历史,而是使打卡**脱链**(orphan:`plan_exercise_id → NULL`,历史经 `exercise_id` 继续参与 e1RM)。脱链是 0031 为「删除整份计划」设计的合法终态,但对「编辑在用计划」是坏结果:学员端已完成的天会显示为未练、教练时间线丢失处方关联。
- **现行门 = 计划级**:`planHistoryLocked(planId)`(`src/routes/plans/index.ts:468`)——树内存在**任意一条** set_log,全部 9 个树写端点(days/exercises/sets 的 POST/PATCH/DELETE)一律 409 `PLAN_HISTORY_IMMUTABLE`,与 plan.status 无关。后果:学员打第一组卡起,教练连**未来周**都改不了,只能新建整份草稿——这就是本 spec 要解的产品问题。
- `planDayHasLogs(dayId)`(`:282`)已存在(shift-day 引入),动作级 helper 尚无。
- **既有缺口(顺手补)**:`PATCH /plans/:id` 的历史锁仅在 `status === 'draft'` 时检查(`:660-665`)——published + 有打卡的计划,当前可以改 `start_date`/`plan_weeks`,会重释已打卡历史的日期语义。
- 序列化 `getPlanWithChildren`(`:128`)/`toPlanExercise` 无任何打卡状态字段,plan-web 无从知道哪行该锁。

## 锁规则(单一规则,status 无关)

**「plan_exercise 名下有任一条 set_log → 该动作及其全部 plan_sets 冻结;其余一切可改。」**

对 draft 同样生效(imported-history 会向草稿注入打卡,构成同样的冻结)。树写操作不看 status(现状已如此,维持);publish 端点自身的 draft 门(`PLAN_NOT_DRAFT`)不变——放开的是编辑,不是重复发布。

| 操作 | 016 行为 |
|---|---|
| PATCH / DELETE `plan_exercise`(冻结) | 409 `EXERCISE_HISTORY_IMMUTABLE` |
| POST / PATCH / DELETE 冻结动作下的 `plan_sets` | 409 `EXERCISE_HISTORY_IMMUTABLE` |
| 未冻结动作的增删改(含已发布计划) | ✅ 允许 |
| POST 新动作到任意天(含有冻结动作的天) | ✅ 允许(加东西不碰历史) |
| POST 新天 | ✅ 允许 |
| PATCH / DELETE `plan_day`(天内含冻结动作) | 409 `DAY_HISTORY_IMMUTABLE`(挪天/删天会重释已打卡历史的位置语义;学员侧单日顺延不受影响,走 `plan_day_shifts` 覆盖层) |
| PATCH / DELETE `plan_day`(天内无冻结动作) | ✅ 允许 |
| PATCH `/plans/:id`:`name` | ✅ 恒可 |
| PATCH `/plans/:id`:`start_date` / `end_date` / `plan_weeks` / `source_template_id`,且计划内存在任何打卡 | 409 `PLAN_HISTORY_IMMUTABLE`(**去掉 `status==='draft'` 前置**,补上述缺口) |
| status 流转 / publish 门 / `PATCHABLE_PLAN_STATUSES` | 不变 |

错误码语义:`PLAN_HISTORY_IMMUTABLE` 从「整树锁」收窄为「仅计划级日历元数据锁」;新增 `EXERCISE_HISTORY_IMMUTABLE`、`DAY_HISTORY_IMMUTABLE`,409 body 附 `details`(如 `{ "exercise_ids": [...] }` / `{ "day_id": ... }`)供 plan-web 行级报错。

## 竞态与锁协议(教练编辑 × 学员同刻打卡)

原则:**凡需历史冻结判定的端点,判定与写操作同事务、判定前先取行锁,无裸 check-then-act**(POST 新天/新动作无需判定,不在此列;显示层竞态见下方豁免)。物理基础:并发插入 `set_logs` 对其引用的 `plan_exercises` 行持 FK `KEY SHARE`;`POST …/exercises` 对 `plan_days` 行、`POST …/days` 对 `plans` 行同理——`SELECT … FOR UPDATE` 与 `KEY SHARE` 互斥,锁住父行即阻断新 child 的诞生。

**锁梯**(均在写事务内,锁全部 `FOR UPDATE`,按层级自上而下取锁避免死锁):

| 端点 | 锁序 | 然后 |
|---|---|---|
| exercise PATCH / DELETE;其下 sets POST / PATCH / DELETE | 目标 `plan_exercise` 行 | 查 `set_logs` → 冻结则 409;否则执行 |
| day PATCH / DELETE | `plan_day` 行(阻断并发新增 exercise)→ 该天全部 `plan_exercises` 行(阻断并发打卡) | 查 `set_logs` → 含冻结则 409;否则执行 |
| plan PATCH(日历字段 `start_date`/`end_date`/`plan_weeks`/`source_template_id`) | `plans` 行(阻断并发新增 day)→ 全部 `plan_days` → 全部 `plan_exercises` | `planHistoryLocked` → 锁则 409;否则执行(低频端点,重锁可接受;phantom 天/动作/打卡被逐层阻断) |

- 删除已提交后才到达的打卡:FK 复查失败,学员端按既有错误处理重取计划树——不产生脱链。
- 显示层竞态不在本 spec 范围:学员手机已渲染旧目标、教练同刻改了**未冻结**动作的内容——打卡存实际完成值,历史不失真;mid-session 实时刷新契约见「不做」。
- **不改外键为 RESTRICT**:0031 的 `SET NULL` 是「删除整份计划保历史」的刻意语义,RESTRICT 会破坏它。已议,否。

## 序列化

`getPlanWithChildren` 返回的每个 exercise 增加 **`has_logs: boolean`**(整树一次聚合查询,禁 N+1)。plan-web 用它渲染锁定行;iOS 忽略新增字段(向后兼容,不需要发版配合)。

## 与 spec 009(批量端点,Draft 未实装)的关系 — 同 PR 修订 009(0.2)

修订主旨:**冻结的树部件永不进批量端点**——不给批量端点发明带既有 id 的 in-place 协议,009 的天级替换语义对无冻结天原样保留:

1. 009 事务新增前置冻结检查(在其步骤 4.1 之前):`delete_day_ids` 覆盖的天按锁梯(day 行 → 其 exercises)检查,任一含冻结动作 → 整事务 409 `DAY_HISTORY_IMMUTABLE` + `details.day_ids`,零写入;`plan_patch` 含日历字段时受计划级历史锁(整树锁梯)约束。
2. **含冻结动作的天的编辑走逐条端点**(本 spec 的门管辖):此类编辑天然小量(在一个已打卡的天内改几个未冻结行),无 429 风险,不需要批量通道。
3. 009 的数据事实同步修订(CASCADE→SET NULL,「删记录」→「脱链」),分块残余语义补注(冻结检查逐块在各自事务内执行;published 计划跨块中间态与既有逐条 reconcile 同级,接受)。
4. 实装顺序无约束:016 先落则逐条端点已按新粒度放行;009 后落时复用 016 的判定 helper 与锁梯。

## 真 gate

1. **部署序**:016 合 staging 并部署**之后**,plan-web 才允许恢复已发布计划的编辑入口(spec 004)。中间态只许更保守(整树锁多锁一阵),不许出现「web 放开、后端还没收窄」的漏。
2. 冻结判定与写操作同事务 + `FOR UPDATE`(上节),不做 check-then-act 裸检查。
3. `has_logs` 聚合一次查询,禁逐 exercise 子查询。
4. plan_patch 白名单(排除 `status`)、限流、publish 门均不变。

## 不做

- **组级(set)颗粒度**:`set_logs` 无 `plan_sets` 外键,组身份是位置(`set_index`),删插会静默错位历史。备查路线:(a) 高水位规则(锁 `max(logged set_index)` 及之前,之后可改,禁高水位下删插);(b) `set_logs` 加 `plan_set_id` 外键 + 回填(动最热表,T3)。均不做。
- **session 内动态调整**(按当日 RPE 调剩余组):归算法引擎 override 层(Brain `algo-engine/03-adaptation-loops`),形态参照 `plan_day_shifts` 覆盖表——**勿改 plan_sets**。
- unpublish / duplicate 端点(A 方案组件,已否)。
- iOS 教练端编辑能力(维持「发布后回看」;plan-web 是唯一编写端)。
- 学员端 mid-session 实时刷新契约。
- `feedback.plan_exercise_id ON DELETE SET NULL` 行为(有反馈无打卡的动作仍可删,反馈脱链——既有语义,不动)。
- 整份计划删除:`plansRouter` **现无** `DELETE /plans/:id` 端点(勿找落点);若未来引入,0031 的 `SET NULL` 已保历史,不属本 spec。

## 落点(实装时核实)

| 件 | 位置 |
|---|---|
| 动作级 helper(`planExerciseHasLogs` / 复用 `planDayHasLogs`) | `src/routes/plans/index.ts:282` 附近 |
| 9 个树写端点门改造 + `PATCH /plans/:id` 缺口 | `src/routes/plans/index.ts`(现有 `planHistoryLocked` call sites 逐个按上表换判定) |
| `has_logs` 序列化 | `getPlanWithChildren`(`:128`)+ `toPlanExercise` + 响应类型 |
| 009 修订 | `specs/009-plan-days-batch/SPEC.md`(修订记录留痕) |
| 测试 | 规则表逐行(含 draft imported-history 同规则、published 无打卡可编辑、天内混合冻结/未冻结)+ 锁梯竞态用例(三层各一)+ `has_logs` 序列化(orphan 打卡 `plan_exercise_id IS NULL` 不计入任何行;无打卡整树全 `false`) |

## 下游

- **plan-web spec 004**(同波):锁定行 UI / reconcile 动作级 / 恢复「更新计划」/ 替换只读弹窗。
- plan-web PR #5 弹窗文案与客户端 `PLAN_NOT_DRAFT` 闸在 004 落地时移除。
- 算法引擎 wave:动态调整走 override 层的接口约定已锚 Brain(`03-adaptation-loops`)。

## 修订记录

| 日期 | 版本 | 修订 | 作者 |
|---|---|---|---|
| 2026-07-11 | 0.1 | 起草:计划级历史锁收窄为动作级(David 拍板 B·动作颗粒度·P1);补 published 元数据锁缺口;`has_logs` 序列化;009 同波修订;组级/动态调整两条已议未采路线存档 | Claude |
