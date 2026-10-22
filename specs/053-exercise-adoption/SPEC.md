# 053 — 教练自建动作「收录」进官方动作库（数据 + 接口）

- **状态**: Draft（2026-10-22 /grill 共识「确认」，后端卡可先派；网页端 UI 等屏幕稿定稿）
- **来源**: David 2026-10-22：管理后台按出现次数看到教练新建的动作名，可选择加入官方动作库。逐题决策见文末「决策记录」。
- **产品正典**: `meetpr-plan-web` 仓 `specs/017-exercise-adoption/SPEC.md`（管理后台页面）。本 spec 定数据模型、wire 契约与可见性规则。
- **级别 / 节奏**: T2 / P1（迁移 + 新接口 + 可见性规则变化）。分支 `feat/053-exercise-adoption` → `staging`，PR 等 David「放行」。

## 现状（2026-10-22 核实 origin/staging）

- 官方动作与教练自建动作同在 `exercises` 表：官方 = `created_by_coach_id IS NULL`，自建 = 该教练 id。名字不唯一，多位教练可各建一条同名动作。
- `GET /exercises`（`visibleExerciseQuery`）：教练看到官方 + 自己建的；其他角色看到官方 + 自己已发布/进行中计划里出现的动作。
- `PATCH /exercises/:id`、`DELETE /exercises/:id` 只对 `created_by_coach_id = 当前教练` 生效；DELETE 在被任何计划或 `set_logs` 引用时拒绝。
- 计划（`plan_exercises.exercise_id`，ON DELETE RESTRICT）、训练记录（`set_logs.exercise_id`）、算法（`base_exercise_id`）都按动作 id 引用。

## 概念

- **收录（adoption）**：给一条教练自建动作挂上「指向某个官方动作」的链接。被收录的那条**原样保留**（id、名字、历史引用全不动），只是从此被视为该官方动作的一个**教练叫法**。撤销收录 = 去掉链接。
- 两种收录：**收录成新官方动作**（同一事务里新建一条官方动作再挂链接）；**归到已有官方动作**（直接挂到现有官方动作）。

## 变更

### 1. 迁移（编号取实装时所有分支上的下一个空号，PR 描述里写明并核对无撞号）

`exercises` 加可空列 `canonical_exercise_id UUID REFERENCES exercises(id) ON DELETE RESTRICT`，加部分索引 `WHERE canonical_exercise_id IS NOT NULL`。存量全部为 NULL，语义不变，无需回填。约束（handler 层保证，测试覆盖）：只有自建动作（`created_by_coach_id IS NOT NULL`）可以有链接；链接目标必须是官方动作；不允许链到链（目标自身 `canonical_exercise_id` 必为 NULL）。

### 2. 管理员接口（`requireRole('admin')`，挂在现有 `src/routes/admin.ts`）

- `GET /admin/custom-exercises`
  返回两组：
  - `pending`：未收录的自建动作，按**归一名**分组（`lower(name)` 去首尾空白、连续空白压成一个）。每组：`key`、`display_name`（组内计划用量最多那条的原名）、`coach_count`（建过的教练数）、`plan_count`（用到组内任一条的不同计划数）、`rows[]`（每条：`exercise_id`、`name`、`coach_id`、`coach_name`、`plan_count`、全部属性字段）。组按 `plan_count` 降序，再按 `coach_count` 降序。
  - `adopted`：已收录的自建动作，按目标官方动作分组。每组：`official`（`id`、`name`、`name_en`）、`rows[]`（`exercise_id`、`name`＝教练叫法、`coach_id`、`coach_name`、`plan_count`、`adopted_at`）。组按官方名排序。
- `POST /admin/custom-exercises/adopt`
  body：`exercise_ids: string[]`（1–50，全部必须是未收录的自建动作）+ 二选一：
  - `target_exercise_id`：已有官方动作 id；或
  - `new_official`：与 `POST /exercises` 相同的动作属性体（`name`、`name_en`、`exercise_type`、`main_lift_family`、`is_competition_lift`、`muscle_groups`、`equipment`、`movement_pattern`），新建为官方动作（`created_by_coach_id = NULL`）。
  单事务：（新建官方 →）把这些行的 `canonical_exercise_id` 设为目标，记 `adopted_at`（另加可空列 `adopted_at TIMESTAMPTZ`，同一迁移）。返回目标官方动作与已挂行。错误：任一 id 不存在/不是自建/已收录 → 409 `EXERCISE_ADOPTION_CONFLICT`（整体回滚，带出问题 id）；目标不是官方 → 400；`new_official` 校验失败 → 400 沿用现有校验信封。
- `POST /admin/custom-exercises/unadopt`
  body：`exercise_ids: string[]`（1–50，必须都已收录）。单事务把链接与 `adopted_at` 置 NULL。因「收录成新」而新建的官方动作**保留**（它已是官方库的一员，可能已被别人用）。

### 3. 教练可见性与编辑（`/exercises`）

- `GET /exercises`（教练）：官方动作中，**排除该教练已有自建动作链到的那些**；自建动作照常返回。被收录的自建动作在响应里：`name` 保持教练叫法，其余属性字段（`name_en`、`exercise_type`、`main_lift_family`、`is_competition_lift`、`competition_stance`、`muscle_groups`、`equipment`、`movement_pattern`）**取目标官方动作的值**；新增字段 `canonical_exercise_id`（未收录为 null）与 `adopted: boolean`。
- 其他角色（学员等）的 `GET /exercises` 可见集不变；返回的被收录行同样按上条合成属性、带两个新字段。名字仍是教练叫法（学员看到的与计划一致）。
- `PATCH /exercises/:id`（被收录行）：只允许改 `name`；body 里有其他字段且与当前合成值不同 → 409 `EXERCISE_ADOPTED_ATTRIBUTES_LOCKED`。
- `DELETE /exercises/:id`（被收录行）→ 409 `EXERCISE_ADOPTED`。
- `POST /exercises` 不变（不做「已有官方动作」提示）。

### 4. 统计合并

- `GET /coach/students/:studentId/exercise-stats?exercise_id=X`：按 X 查历史时，把「与 X 链到同一官方动作的所有行 + 该官方动作本身」视为同一动作（X 是官方动作时同理，包含链到它的行）。不带 `exercise_id` 的汇总按同一归并键（`coalesce(canonical_exercise_id, id)`）合并。
- `/admin/exercise-usage`：官方动作的 `plan_count` / `coach_count` 计入链到它的自建动作的用量；被收录的自建动作不再单独出现在该列表。

## 不变量（测试必须钉住）

1. 收录/撤销前后，`plan_exercises`、`set_logs`、`exercises.name`、`exercises.id` 全部逐字段不变（数据红线：不改历史）。
2. 未收录的教练与学员，`GET /exercises` 响应与改动前逐字段一致（除新增的两个字段）。
3. 撤销收录后，该行在教练 `GET /exercises` 中的属性恢复为它自己的原始值（原始值从未被覆盖）。
4. 教练 A 的收录不影响教练 B 的可见集（B 若没有链到该官方动作的行，照常看到官方动作）。

## Out of Scope

- 教练新建动作时提示「已有官方动作」；通知被收录的教练。
- 把官方动作导出回 iOS 仓 `exercise-catalog-v2.json`（另开小卡）。
- `sets-log` 的 PR / e1RM 基线比较、算法 `base_exercise_id` 按收录合并（本期只合并只读统计与后台用量）。
- App 端（iOS / 安卓）任何改动：它们经 `GET /exercises` 自动得到新可见集；若 App 尝试改被收录行的属性，会收到 409，现有通用错误提示即可。
- 删除官方动作。

## 验收清单

1. 迁移可重复执行（遵循仓内迁移惯例），存量行 `canonical_exercise_id` 全为 NULL；回滚说明写在 PR。
2. `GET /admin/custom-exercises` 分组、计数、排序如 §2；非管理员 403。
3. 「收录成新」：官方库多一条，所选行全部挂上；「归到已有」：所选行挂到目标；任一冲突整体回滚并 409。
4. 撤销：链接清空，新建的官方动作仍在。
5. 教练可见性与编辑规则如 §3；不变量 1–4 有测试。
6. 统计合并如 §4，有测试。
7. 仓内 lint / typecheck / 全量测试绿；PR 描述写明迁移号与核对过的分支列表。

## 测试 seam

- **路由级集成测试**（仓内现有 admin 与 exercises 路由测试所用的测试库 + supertest 方式，优先复用其夹具）：`/admin/custom-exercises*` 三个接口、`/exercises` 的 GET/PATCH/DELETE 新规则、不变量 1–4。
- **`exercise-stats` 现有测试文件**：加「链到同一官方动作的历史被合并」用例。
- **`/admin/exercise-usage` 现有测试**：加计入链接用量的用例。
先写这些用例跑红，再实装。

## 决策记录（2026-10-22 /grill）

1A 归一名分组、显示教练数 + 计划数、按计划数排；2 教练照常用自己的叫法，但指向同一个官方动作（取代「合并删除重复行」）；3A 收录成新时弹窗预填属性可改；4A 以数据库为准，iOS 正典文件以后导出回填；5 现状：教练只能改删自己建的、被用过不能删 → 8A 收录后只能改名、属性以官方为准、不能删；6A 后台「动作库」页加分段；7A 学员看教练叫法；9A 本期同时支持「归到已有官方动作」；10B 不做新建提示；11A 可撤销；12A 被链到的官方动作对该教练隐藏。
