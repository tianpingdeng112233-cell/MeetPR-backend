# 015 — coached 学员单日顺延覆盖层

- **状态**: InProgress
- **来源**: iOS coached 学员需要把 UTC 当天的训练顺延到同一 plan week 内的休息日；2026-07-09 后端契约已锁定。

## 范围

本功能是纯增量覆盖层：新增 `plan_day_shifts` 表、新增 POST/DELETE 端点，并在现有计划 day 序列化中新增 nullable 字段。不得修改 `plan_days` 槽位、计划日期派生规则、已发布计划树不可变门或任何现有端点行为。

## 数据模型

手写迁移 `0037-add-plan-day-shifts.sql`：

- `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
- `plan_day_id UUID NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE UNIQUE`
- `student_id UUID NOT NULL REFERENCES users(id)`
- `shifted_to_date DATE NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`

同步手工扩展 `src/db/types.ts` 的 `Database` 接口。`DATE` 继续按文本 wire format 返回。

## API

### `POST /plans/days/:dayId/shift`

请求：

```json
{ "shifted_to_date": "YYYY-MM-DD" }
```

仅计划绑定的 `coached_student` 本人可调用；其他学员和 coach 返回 `403 AUTHORIZATION_FORBIDDEN`。不存在的 day 返回 `404 PLAN_DAY_NOT_FOUND`。请求体格式不合法返回现有 `VALIDATION_ERROR` envelope。

业务校验失败返回 409 和以下机器码：

1. 计划必须为 `published`，且 UTC 今天在 `start_date..end_date`（闭区间）内，否则 `PLAN_NOT_ACTIVE`。
2. day 的当前有效日期（已有 shift 优先，否则由 `plannedDayDate()` 派生）必须是 UTC 今天，否则 `SHIFT_ONLY_TODAY`。完全相同目标的重复请求视为幂等重试，仍继续其余校验并返回同一 shift。
3. day 下任何 exercise 存在 `set_logs` 时返回 `SHIFT_DAY_HAS_LOGS`。
4. 目标必须大于 UTC 今天、落在该 day 的同一 7 天 plan-week 内，且没有其他 day 派生或覆盖到目标日，否则 `SHIFT_TARGET_NOT_REST_DAY`。

通过后按 `UNIQUE(plan_day_id)` UPSERT，仅更新 `shifted_to_date`；保留既有 `id`/`created_at`。返回：

```json
{
  "id": "uuid",
  "plan_day_id": "uuid",
  "shifted_to_date": "YYYY-MM-DD",
  "created_at": "ISO-8601"
}
```

成功状态固定为 201。

### `DELETE /plans/days/:dayId/shift`

仅计划绑定的 `coached_student` 本人可调用。day 下已有 `set_logs` 时返回 `409 SHIFT_DAY_HAS_LOGS`。删除 shift；不存在 shift 也幂等返回 204。该端点不修改计划树。

### `GET /plans/:id`

每个 day 增加：

```json
{ "shifted_to_date": "YYYY-MM-DD" }
```

无 shift 时为 `null`。其余字段和鉴权行为不变。

## 测试

- 迁移声明、外键、唯一约束和 DATE 字段。
- happy path 顺延到休息日并撤销。
- 非本人和 coach 均为 403。
- 非今天、非休息目标、已有 log、draft 计划分别拒绝且返回指定机器码。
- GET 返回 shift/null。
- 同一目标重复 POST 返回同一记录且数据库只有一行。

## 不做

- 不写 offset，不修改 `plan_days`、plan tree 或 `plans`。
- 不改变 `planTreeMutationError` 或任何 coach 写路径。
- 不允许跨 plan-week 顺延，也不允许覆盖另一训练日。
