# SPEC 030 — 教练 RPE 校准与 e1RM 低 RPE 口径统一

- **Status: InProgress**
- **级别**: T2（迁移 + 写 API + e1RM 读路径口径变更）
- **来源**: 产品拍板取消 e1RM 低 RPE 拒收门，并允许教练在视频反馈处校准学员 RPE；iOS spec 028 锁定 e1RM 分段口径。
- **端**: backend（本仓）；校准入口 UI 不在本卡。

## 1. 目标与非目标

### 1.1 目标

- e1RM 不再拒收低于 7 的 RPE；无 RPE 或 RPE 低于 6 时使用 Epley，RPE 6...10 时使用既有 RTS 表。
- 教练可为当前绑定学员的单组记录写入或清除独立的 `coach_rpe`，且永不改写学员自报 `rpe`。
- exercise stats、PR detection 计算 e1RM 时优先采用教练校准值。
- 视频元数据 additive-only 暴露学员自报与教练校准 RPE。

### 1.2 非目标

- 不做 iOS / plan-web 校准 UI。
- 不修改 completed / failed / confidence / 次数上限 / 硬拉次数上限等其余 e1RM 入选条件。
- 不修改 e1RM 分级、PR 噪声或跳变门常量。
- 不回填历史数据，不覆盖 `set_logs.rpe`。

## 2. 数据模型与迁移

新增 additive-only 迁移 `db/migrations/0052-add-set-log-coach-rpe.sql`：

```sql
ALTER TABLE set_logs
  ADD COLUMN coach_rpe NUMERIC(3,1) NULL
  CHECK (coach_rpe >= 0 AND coach_rpe <= 10);
```

- 迁移号固定为 0052。
- 既有行 `coach_rpe` 为 NULL。
- `src/db/types.ts` 手工增补 `SetLogsTable.coach_rpe`，读值遵循 NUMERIC 字符串惯例。

## 3. e1RM 口径变更

`calculateEligibleE1RM` 保持签名不变，先执行全部既有非 RPE 入选条件，再按以下分段计算：

| RPE 输入 | 计算                                        |
| -------- | ------------------------------------------- |
| `null`   | Epley：`weight * (1 + reps / 30)`           |
| `< 6`    | Epley                                       |
| `6...10` | 既有 RTS intensity 表；0.5 档位之间线性插值 |
| `> 10`   | 不入选，返回 `null`                         |

- 删除 `E1RM_POLICY.minimumRpe` 与原 `rpe < 7` 拒收分支。
- `maximumReps=10`、`maximumDeadliftReps=5`、rolling window、PR 噪声与跳变常量保持不变。

## 4. API

### `PATCH /coach/set-logs/:id/coach-rpe`

仅 coach 角色可调用。请求体 strict 校验：

```json
{ "coach_rpe": 8.5 }
```

- `coach_rpe` 必填，可为 `null`；`null` 表示清除校准。
- 数值范围 0...10，步进必须为 0.5；非法范围、步进或多余字段返回 400：
  `{ "error": "VALIDATION_ERROR", "issues": [...] }`。
- set_log 必须属于与该教练存在 accepted bind 的学员；未绑定、对象不存在或非 coach 一律返回 403：
  `{ "error": "AUTHORIZATION_FORBIDDEN" }`。
- 成功返回 200：

```json
{ "set_log_id": "<uuid>", "coach_rpe": "8.5" }
```

清除时 `coach_rpe` 为 `null`。数据库只更新 `coach_rpe`，学员自报 `rpe` 原样保留。

成功写入结构化日志事件 `coach_rpe_updated`，字段固定为
`set_log_id` / `coach_id` / `before` / `after`；清除值使用 `null`。

## 5. e1RM 读路径

- `src/handlers/exercise-stats.ts` 查询补出 `coach_rpe`，e1RM 输入使用
  `coach_rpe ?? rpe`；recent session 的既有 `rpe` 响应语义不变。
- `src/handlers/pr-detection.ts` 的触发组与 rolling-window 候选组都补出
  `coach_rpe`，e1RM 输入使用 `coach_rpe ?? rpe`。
- `calculateEligibleE1RM` 签名不变。

## 5.5 set_logs 下发路径（07-28 追加拍板：校准优先为全端显示口径）

学员端与教练端拉取训练记录的 set_logs 响应（`src/handlers/sets-fetch.ts`：`fetchOwnSetLogs` / `fetchCoachSetLogs`）additive-only 新增 `coach_rpe`（NUMERIC 序列化为一位小数字符串，无校准为 `null`）。iOS/RN 学员端本地 e1RM 计算依赖此字段实现 `coach_rpe ?? rpe` 的全端统一口径。

## 6. 视频响应兼容

`GET /students/:id/videos` 每个既有视频项 additive-only 新增：

```json
{
  "rpe": "8.0",
  "coach_rpe": "8.5"
}
```

两字段均为一位小数字符串或 `null`。既有
`exercise_name` / `set_index` / `weight_kg` / `reps` 及其余字段形状不变；无 set_log 的视频两字段均为 NULL。

## 7. 验收

1. Unit：
   - `140kg × 5 @6` 使用 RTS，结果 `200.0`；
   - `140kg × 5 @5` 使用 Epley，结果约 `163.33`；
   - `rpe > 10` 返回 NULL；
   - 既有 `rpe == null` Epley 用例继续通过；
   - completed / failed / confidence / reps≤10 / deadlift reps≤5 门保持。
2. PATCH endpoint：
   - 绑定教练成功写入与清除，学员 `rpe` 不变；
   - 非绑定教练得到 403；
   - 非 0.5 步进得到 400。
3. Exercise stats 集成：
   - rolling window 混合 `@6`、无 RPE、含 coach calibration 的组；
   - e1RM max 使用 `coalesce(coach_rpe, rpe)`，`140 × 5` 学员报 6、教练校准 8 时按 `140 / 0.78 ≈ 179.49`，不得仍按 @6 得 200。
4. PR detection 的触发组与历史候选均采用同一 coalesce 口径。
5. 视频既有字段全部保留，新增 `rpe` / `coach_rpe` 正确序列化。
6. 迁移 additive-only，约束拒绝 0...10 以外的 `coach_rpe`。
7. `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build` 全绿。
