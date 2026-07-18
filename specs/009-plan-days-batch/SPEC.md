# 009 — plan days 批量写端点（`POST /plans/:id/days/batch`）+ plan-web reconcile 单请求化

- **状态**: InProgress（2026-07-18 实装开工；David 2026-07-02 拍板轻量 spec 先行、0.2 已按 016 修订）
- **来源**: web 教练计划 xlsx 导入的速率限制风暴。`meetpr-plan-web` 保存时把一张计划 reconcile 成几百个逐条写请求（`POST /plans/:id/days`、`/days/:id/exercises`、`/exercises/:id/sets`），撞穿全局限流（`RATE_LIMIT_MAX` 默认 100/min，`createGlobalRateLimit` in `src/middleware/rateLimit.ts`）。一张 12 周计划 ~200–300 个写 → 429。现有 stopgap：`meetpr-plan-web/src/api/client.ts` 对 429 做有界 backoff 重试（commit 3e19e71），能过但大计划要几分钟。
- **批准语境**: David 2026-07-02 选「轻量 spec 先行」。端点形状已在会话中锁定：**批量「变化的天」**，不是整盘 replace（见下警示框）。限流不动。

> ⚠️ **这是把现有 `reconcile.ts` 的 N 个 HTTP 请求压成 1 个（每块），差量语义完全不变——仍只重建「变化的天」，没变的天原地不动。**
>
> **不做整盘 `POST /plans/:id/replace`。**（数据事实 2026-07-11 更新，结论不变）0031 起 `set_logs.plan_exercise_id` 已从 `ON DELETE CASCADE` 改为 nullable + `ON DELETE SET NULL`：删 `plan_exercise` 不再抹掉学员打卡，而是使其**脱链**（orphan，历史经 `exercise_id` 存续但失去处方关联，学员端已完成的天显示为未练）。`feedback.plan_exercise_id` 仍 `ON DELETE SET NULL`（`0006`）。同时 spec 016 把树写门定为**动作级历史锁**（冻结动作 409 `EXERCISE_HISTORY_IMMUTABLE`）。批量端点仍复刻天级差量语义,但**含冻结动作的天不入批**（步骤 4.0 整事务拒绝）——此类天的小编辑走逐条端点，由 016 的门管辖。
>
> **限流不动。** 它是真 gate（防爆破/滥用）。正解是不再产生 N 个请求，而不是提高/豁免 `RATE_LIMIT_MAX`（那是削真 gate）。`client.ts` 的 429 backoff 保留当安全网（此后基本闲置）。

## 范围

一个后端端点 + plan-web 客户端切换。**无 migration**（纯路由 + 客户端改动，不动 schema）。两个 PR（backend 一个、plan-web 一个）。

### 1. `POST /plans/:id/days/batch`（`plansRouter`，`src/routes/plans/index.ts`）

挂载点已定：`plansRouter` 在 `src/routes/index.ts:38` 挂 `/plans` + `deps.requireAuth`。新路由加在 `plansRouter` 内，`requireRole('coach')`，Express 路径 `'/:id/days/batch'`（三段，与既有 `'/:id/days'`(两段) / `'/days/:dayId/exercises'` 不冲突）。

请求 body（`delete_day_ids` + `upsert_days` + 可选 `plan_patch`，一次一个事务）：

```json
{
  "plan_patch": {
    "plan_weeks": 12,
    "start_date": "2026-07-06",
    "end_date": "2026-09-27"
  },
  "delete_day_ids": ["…day-uuid…", "…"],
  "upsert_days": [
    {
      "week_number": 1,
      "day_of_week": 1,
      "sort_order": 0,
      "exercises": [
        {
          "exercise_id": "…uuid…",
          "is_main_lift": true,
          "sort_order": 0,
          "notes": "……|null",
          "sets": [
            {
              "set_number": 1,
              "target_reps": 5,
              "target_reps_max": null,
              "intensity_mode": "weight",
              "target_value": "100",
              "set_type": "working",
              "rest_seconds": null,
              "coach_note": "……|null"
            }
          ]
        }
      ]
    }
  ]
}
```

**zod（`src/routes/plans/schemas.ts`，复用同文件已有 sub-schema，一字不改单条校验）：**

```ts
// DoS 真 gate：数组硬上限（远高于任何真实计划）。
const MAX_UPSERT_DAYS = 100; // 客户端按天数分块，见 §3；单块 <<1mb body
const MAX_DELETE_IDS = 400; // 覆盖 52 周整盘缩短
const MAX_EXERCISES_PER_DAY = 30;
const MAX_SETS_PER_EXERCISE = 30;

const BatchExerciseSchema = z.object({
  exercise_id: UuidSchema,
  is_main_lift: z.boolean(),
  sort_order: SortOrderSchema,
  notes: z.string().max(500).nullable().optional(),
  // 复用单条 set 校验（含 target_reps_max/RPE/weight 的 superRefine）——批量不放水。
  sets: z.array(CreatePlanSetBodySchema).max(MAX_SETS_PER_EXERCISE),
});

const BatchDaySchema = z.object({
  week_number: WeekNumberSchema, // 1..52
  day_of_week: DayOfWeekSchema, // 1..7
  sort_order: SortOrderSchema,
  exercises: z.array(BatchExerciseSchema).max(MAX_EXERCISES_PER_DAY),
});

// plan_patch 只准 name/日期/plan_weeks —— 显式排除 status / source_template_id，
// 批量路径不能改状态（不能借批量端点偷发布/绕过 evaluation gate）。真 gate。
const BatchPlanPatchSchema = z
  .object({
    name: NameSchema.optional(),
    start_date: DateSchema.optional(),
    end_date: DateSchema.optional(),
    plan_weeks: PlanWeeksSchema.optional(),
  })
  .strict()
  .superRefine(validateDateOrder);

export const BatchDaysBodySchema = z
  .object({
    plan_patch: BatchPlanPatchSchema.optional(),
    delete_day_ids: z.array(UuidSchema).max(MAX_DELETE_IDS).default([]),
    upsert_days: z.array(BatchDaySchema).max(MAX_UPSERT_DAYS).default([]),
  })
  .strict();
```

**行为（按序）：**

1. **归属真 gate（一次）**：`selectOwnedPlan(deps.db, planId, coach.id)`。不属于该教练 → `404 PLAN_NOT_FOUND`。之后所有子写入天然限定在这张计划内。
2. **body 校验**：`BatchDaysBodySchema.safeParse` → 400 `validationEnvelope`。
3. **动作可见性真 gate（批量，一次）**：收集 `upsert_days` 里全部去重 `exercise_id`，走**一次** `visibleExerciseQuery(db, coach.id, 'coach').where('id', 'in', ids)`（见 §2 helper）。任一 id 不在可见集 → `400 EXERCISE_NOT_FOUND_OR_HIDDEN`（附缺失 id 列表），**整批拒、零写入**。空集跳过。
4. **一个事务**（`deps.db.transaction().execute(async (trx) => {…})`，沿用 `/:id/publish` 已有事务范式）：0. **冻结检查（016 联动，0.2 起）**：对 `delete_day_ids` 覆盖的天按 016 锁梯取锁（day 行 `FOR UPDATE` → 其全部 `plan_exercises` `FOR UPDATE`）后查 `set_logs`——任一含冻结动作 → 整事务 409 `DAY_HISTORY_IMMUTABLE` + `details.day_ids`，零写入。`plan_patch` 含日历字段（`start_date`/`end_date`/`plan_weeks`）时，另按 016 计划级历史锁（整树锁梯 + `planHistoryLocked`）检查 → 锁则 409 `PLAN_HISTORY_IMMUTABLE`。判定 helper 与逐条端点共用（spec 016）。
   1. `plan_patch` 若在：合并现值算日期序（同 `PATCH /plans/:id`：`mergedStart/End`），`updateTable('plans').set({…, updated_at: now()})`。
   2. **删**：`delete_day_ids` 非空 → `deleteFrom('plan_days').where('plan_id','=',planId).where('id','in',delete_day_ids)`。`plan_id` 兜底 = 客户端传别的计划的 day id **删不动**（静默 no-op，不 trust client id）。级联删 exercises/sets；`set_logs.plan_exercise_id` 自 0031 起 `ON DELETE SET NULL`（脱链非删除）——且步骤 4.0 已保证这些天无打卡，实际不会产生脱链。
   3. **插**：按 `upsert_days` 顺序，每天 `insertInto('plan_days').values({plan_id, week_number, day_of_week, sort_order}).returning(['id'])`；每个 exercise `insertInto('plan_exercises')…returning(['id'])`；该 exercise 的 sets **批量** `insertInto('plan_sets').values([...])`，`target_value` 逐条过 `normalizeTargetValue`（同单条 POST，2 位小数）。
5. **响应**：事务提交后 `getPlanWithChildren(deps.db, plan)` 重读整棵树，`200` 返回 `PlanWithChildrenResponse`（与 `GET /plans/:id` 同序列化）。客户端可拿它当**新 baseline**（分块时以最后一块的返回为准），省一次 GET。
6. **日志**：一条 `logger.info({ planId, daysDeleted, daysUpserted, exercisesCreated, setsCreated }, 'plan_days_batched')`。

> **不跨表校验 `week_number ≤ plan_weeks`。** DB 无此 CHECK（`plan_days_week_number_check` 只是静态 `BETWEEN 1 AND 52`），发布门（`POST /:id/publish` 的 `weeks-overflow`）仍是唯一 gate。客户端保证 payload 自洽（不会在 `plan_weeks<N` 时发 week-N 天）。这与现状一致，不新增也不削门。

### 2. 批量可见性 helper（`src/routes/exercises/index.ts`）

现有 `visibleExerciseForCoach(db, exerciseId, coachId)` 是单条。加并列批量版，复用同一 `visibleExerciseQuery`：

```ts
export async function visibleExercisesForCoach(
  db: Kysely<Database>,
  exerciseIds: string[],
  coachId: string,
): Promise<Set<string>> {
  if (exerciseIds.length === 0) return new Set();
  const rows = await visibleExerciseQuery(db, coachId, 'coach')
    .select('id')
    .where('id', 'in', exerciseIds)
    .execute();
  return new Set(rows.map((r) => r.id));
}
```

端点 step 3 用它：`missing = ids.filter((id) => !visible.has(id))`；非空 → 400。

### 3. plan-web：`reconcile.ts` 单请求化 + `api/plans.ts` + 分块

`meetpr-plan-web/src/features/plan-editor/reconcile.ts` 保留**全部差量逻辑**（仍 `getPlan` 取 live baseline、逐天 canon 比对）——只把「逐天发请求」换成「攒好 payload 一次（每块）POST」。

- **冻结天分流（0.2，016 联动）**：变化的天若含 `has_logs` 锁定行（混合天）→ **不入 batch**，走**逐条端点**做动作级 diff（完整契约 = plan-web spec 004：锁定行零写请求、未锁行删/改/增、409 行级处理）；纯无锁天 → 按下列原逻辑入 batch。调用序：**batch 先行**（其返回树作为新 baseline），混合天逐条随后（既有 day/exercise id 不受 batch 影响）；`changedDays` = 两路之和。
- **`reconcilePlan(planId, weeks)`**（无锁天路径）：遍历 (week, dow)，对每个**变化的天**：
  - 有 orig → `deleteDayIds.push(orig.id)`（无论 desired 是否为空）；
  - `desired.length > 0` → `upsertDays.push({ week_number, day_of_week: dow+1, sort_order: 0, exercises: desired.map(…) })`。
  - 没变的天：都不进（原地保留，保住其 set_logs）。
- **`reconcileImportedPlan(planId, weeks, startDate)`**：额外把 `day.week_number > weeks.length` 的 orig 天推进 `deleteDayIds`；`planPatch = { plan_weeks: weeks.length, start_date: startDate, end_date }`。
- **分块（`CHUNK_DAYS = 60`）**：`upsertDays` 切成 ≤60 的组，顺序 `await` 发送。**第一块**带 `plan_patch` + 全部 `delete_day_ids` + 第 1 组 upsert；后续块只带各自的 upsert 组。若 `upsertDays` 空但有删/patch → 仍发一块。`changedDays === 0`（全无变化）→ 不发网络请求。
  - 每块一个事务、独立提交。中途失败：草稿导入 = 部分写入，用户重存重算差量补齐（草稿对学员不可见，无害）；已发布计划的日常保存 = 每个变化的天各自完整替换或不动，与今日逐请求循环失败中途**同等**语义，无回归。真实 ≤12 周计划 ≤84 天 → ≤2 块，远低于 100/min。
  - **0.2 补注（016 联动）**：冻结检查（步骤 4.0）逐块在各自事务内执行；含冻结动作的天客户端本就不得放进 `delete_day_ids`/`upsert_days`（plan-web spec 004 的 diff 基线含 `has_logs`，锁定天走逐条端点），4.0 是服务端兜底。published 计划的跨块中间态（先删后插的窗口）与既有逐条 reconcile 同级残余，接受不新解。单天不跨块（既有语义）。
- 返回 `SaveResult { changedDays, skippedRows }` 计法不变（客户端仍算差量，故计数照旧）。
- **`api/plans.ts`** 加：

```ts
export const batchDays = (
  planId: string,
  body: { plan_patch?: {…}; delete_day_ids: string[]; upsert_days: BatchDay[] },
) => api.post<PlanWithChildren>(`/plans/${planId}/days/batch`, body)
```

`client.ts` 的 `rawRetrying`（429 backoff）不动，透明包住这几个请求当安全网。旧的 `createDay/deleteDay/createExercise/createSet` 若 reconcile 外无其它调用方，随之删除（impl 时 grep 确认）。

### 4. tests

**backend `tests/plans/plans-batch.test.ts`（supertest + 真 Kysely，镜像 `tests/plans/plans.test.ts`）：**

1. **upsert**：N 天 → N 天 + exercises + sets 落库，形状/排序正确；`target_value "100"` 存成 `"100.00"`（归一）。
2. **delete**：`delete_day_ids` 删对应天，级联 exercises/sets。
3. **数据安全核心（crown jewel）**：种一张 `published` 计划，A 天挂学员 `set_logs`；batch 只改 B 天（`delete_day_ids=[B.id]` + upsert 新 B）→ **A 天及其 `set_logs` 完好**。证明非整盘 wipe。
4. **归属**：非 owner 教练的 planId → 404；`delete_day_ids` 塞**别的计划**的 day id → 该 day **不被删**（scoping no-op），owner 自己的改动照常提交。
5. **可见性真 gate**：upsert 含隐藏/他人私有 `exercise_id` → 400，且**零行写入**（断言事务回滚：无新 day/exercise/set）。
6. **plan_patch**：`plan_weeks`/日期同事务更新；`end_date < start_date` → 400（且无任何写入）。
7. **bounds**：`upsert_days > 100` / 某 exercise `sets > 30` → 400。
8. **角色**：student token → 403（`requireRole('coach')`）。
9. **空 body**：`delete=[]`、`upsert=[]`、无 `plan_patch` → 200，计划不变。
10. **冻结天 409（0.2）**：`published` 计划 A 天挂 `set_logs`；`delete_day_ids=[A.id]`（+ 任意 upsert）→ 409 `DAY_HISTORY_IMMUTABLE` + `details.day_ids=[A.id]`，**整事务零写入**（断言 upsert 的天未入库、`plan_patch` 未生效）。
11. **plan_patch 日历锁（0.2）**：计划内任一天挂 `set_logs`，`plan_patch` 含 `start_date`/`plan_weeks` → 409 `PLAN_HISTORY_IMMUTABLE`，同批 delete/upsert 全回滚；`plan_patch` 仅 `name` → 200 照常。

无 migration test（不动 schema）。

**web `reconcile.test.ts` / `reconcile-import.test.ts` 扩展（vitest，mock `batchDays`）：**

1. 给 weeks + server baseline → 产出正确 `{ deleteDayIds, upsertDays, planPatch }`：只变的天进 upsert；没变的天都不进；清空的天只进 delete。
2. **分块**：>60 变化天 → 多请求；`plan_patch` + `delete_day_ids` **只**在第一块。
3. `reconcileImportedPlan`：`week_number > weeks.length` 的天进 `deleteDayIds`；`planPatch` 含 `plan_weeks`/`start_date`/`end_date`。
4. **回归**：`skippedRows` / `changedDays` 计数与改造前一致（沿用现有用例断言）。
5. 断言 POST body 形状（mock `batchDays` 收到的参数）。
6. **冻结天分流（0.2）**：baseline 含 `has_logs` 锁定行的天被改动 → 该天**不进** `deleteDayIds`/`upsertDays`（断言 batch body 不含它），分流到逐条路径；`changedDays` 计入两路之和。

## 真 gate

1. **不 trust client id**：删按 `plan_id = :id AND id IN (...)` 兜底；归属只查一次。别人的 day id 删不动。
2. **动作可见性**：批量一次校验，任一不可见 → 整批拒 + 零写入（不是逐条 skip）。
3. **一个事务（每请求/每块）**：半路失败全回滚，不留半盘脏数据——比现状逐请求循环更强。
4. **校验不放水**：复用 `CreatePlanSetBodySchema`（含 superRefine）+ `normalizeTargetValue`，批量与单条 POST 逐字一致。
5. **plan_patch 白名单**：只 name/日期/plan_weeks，**排除 status/source_template_id**——不能借批量端点改状态/偷发布/绕 evaluation gate。
6. **DoS 上限**：数组 caps + `express.json({ limit: '1mb' })`（`src/app.ts:39`，已存在）+ 客户端主动按天数分块（**不依赖** spec 008 未落地的 413 修复）。
7. **限流不动**：真 gate 保留（防爆破/滥用），只是不再产生 N 请求。

## 不做

- **整盘 `POST /plans/:id/replace`**：使已打卡动作的 `set_logs` 脱链（0031 后不再是 cascade 删除，但脱链同样不可接受），且会被 016 的动作级门整单拒绝。天级/动作级差量是硬约束。
- **天内 exercise/set 级 in-place 保 id**：天级替换、不改进，YAGNI——_2026-07-11 按 spec 016 补边界_：该结论仅覆盖**无冻结动作的天**;含冻结动作（有 `set_log`）的天**不入批**（步骤 4.0 整事务 409 `DAY_HISTORY_IMMUTABLE`），其编辑走逐条端点、由 016 的动作级门管辖。批量端点始终不承载冻结树部件，body schema 不加 id 字段。
- **提高/豁免 `RATE_LIMIT_MAX`** 或给 plan 写路由开限流豁免：削真 gate。
- **乐观锁/版本号并发控制**：单教练编辑自有计划，低并发。
- **server 端重算 diff**：客户端保留差量逻辑，server 只忠实执行 delete + upsert。
- **依赖 413 拆批**：改客户端主动分块（`CHUNK_DAYS=60`），不碰 `errorHandler`。
- **动 `client.ts` 的 429 backoff**：保留当安全网，几乎不再触发。

## 下游

- **`meetpr-plan-web`**：`reconcile.ts` 单请求化 + `api/plans.ts` 加 `batchDays` + 分块（独立 PR，backend 端点先合）。
- 未来若 in-app 导入解封（现置灰，MeetPR #203），同端点可复用。
- `client.ts` 的 429 backoff 此后基本闲置——保留，不删。

## 修订记录

| 日期       | 版本 | 变更                                                                                                                                                                                                                                                                                                                                     | 作者   |
| ---------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 2026-07-02 | 0.1  | 起草：`POST /plans/:id/days/batch`（天级差量批量、一个事务、归属+可见性+plan_patch 白名单真 gate、数组 DoS 上限）+ plan-web reconcile 单请求化 + 分块 + tests。限流不动，不做整盘 replace。                                                                                                                                              | Claude |
| 2026-07-11 | 0.2  | 按 spec 016 修订：数据事实对齐 0031（CASCADE→SET NULL，删除后果=脱链非数据丢失）；事务新增步骤 4.0 冻结检查（含冻结动作的天整事务 409 `DAY_HISTORY_IMMUTABLE`，`plan_patch` 日历字段受计划级历史锁）；分块补注（4.0 逐块执行、冻结天不入批、published 跨块中间态接受）。含冻结天的编辑走逐条端点（016），批量 body schema 不加 id 字段。 | Claude |
