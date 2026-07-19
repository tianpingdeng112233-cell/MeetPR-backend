# 023 — Exercise usage stats（教练动作使用频次，只读推导制）

- **Status**: InProgress
- **Date**: 2026-07-19
- **Trigger**: 教练反馈 2026-07-18（David 拍板方案 B：频次落后端、跨设备生效，另加管理者全库频次视图）。
- **Companion**: meetpr-plan-web `feat/picker-usage-keyboard`（同日实装波：动作候选按频次排序 + 键盘化 + admin「动作库」tab）。

## Scope

两个**只读**端点，把「某教练把某动作排进计划的次数」暴露给 plan-web：

1. 教练本人频次 → 动作候选排序信号；
2. 管理员全库频次 → admin 工作台「动作库」视图。

**推导制，零迁移零新表**：频次从既有 `plan_exercises → plan_days → plans` 链纯 SQL
聚合而来（`plans.coach_id` 分组），不引入计数表、不在保存链路埋写钩子。计划被删则
计数自然回落——这是特性不是缺陷（反映教练当前习惯）。

## 端点契约

### `GET /exercises/usage-stats`（`requireRole('coach')`）

当前登录教练的动作使用频次。所有 plan status（draft / published / completed / paused）
都计入。响应：

```json
{ "stats": [{ "exercise_id": "<uuid>", "plan_count": 3 }] }
```

- 仅含 `plan_count > 0` 的条目，按 `plan_count` 降序。
- `plan_count` = 该教练计划中含该动作的 `plan_exercises` 行数（同一计划多次出现累加）。
- 路由声明须避开同 router 参数路由（如 `/:id`）吞路径。

### `GET /admin/exercise-usage`（admin 双重鉴权，沿用 022 模式）

全库每个动作的使用情况，`exercises` LEFT JOIN 聚合，**含 0 次动作**。响应：

```json
{
  "exercises": [
    {
      "exercise_id": "<uuid>",
      "name": "…",
      "exercise_type": "accessory",
      "plan_count": 12,
      "coach_count": 2
    }
  ]
}
```

- `coach_count` = 使用过该动作的去重教练数。
- 排序 `plan_count` 降序，次序键 `name`。

## 兼容性

Additive-only：不改 `GET /exercises` 及任何既有端点的响应形状；现役 iOS / plan-web
客户端零影响。两端点纯只读，无写操作（022 的「admin V1 只读」裁决不受影响）。

## 验收

- 教练 A 只见自己的频次，教练 B 的计划不计入；多计划重复动作正确累加。
- `/admin/exercise-usage` 含 0 次动作；`coach_count` 去重正确。
- 匿名 401；coach/student token 访问 admin 端点 403；student 访问 usage-stats 403。
- pg-mem 测试仿 `tests/admin.test.ts` / `tests/exercise-stats.test.ts` 既有模式。
- `pnpm typecheck && pnpm lint && pnpm test` 全绿。
