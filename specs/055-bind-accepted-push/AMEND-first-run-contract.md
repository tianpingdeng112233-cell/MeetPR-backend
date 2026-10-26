# 095 修订 · 首次体验判定改由后端计算（2026-10-26，Opus 收货时定）

## 为什么改

收货时核实（后端 staging 代码 `src/routes/plans/index.ts` 学员分支 `GET /students/:id/plans` 与 `GET /plans/:id`）：学员只能读到 `status = published` 的计划。教练把计划标成 `completed` 或 `paused` 后，学员端就看不到它。所以客户端拉列表无法判断 SPEC「判定口径」要求的「本次绑定的计划」和「是否结算过训练日」：第一份计划已被标完成的老学员会被误判成「从没收到计划」，升级后看到欢迎页和新学员卡，违反验收第 5 条。另外门禁上逐个拉计划详情会拖慢每次启动。

产品规则不变（SPEC 共识 1–6 与「判定口径」原文仍有效），只把计算挪到后端。

## 契约（后端 055 补充；三端必须一致）

`GET /bind-requests/mine` 的 `bind_request` 对象新增字段 `first_run`：

```
first_run: null | {
  binding_plan_count: int,        // 本次绑定的计划数
  has_settled_day: bool,          // 这些计划里是否有任何一天已结算
  first_plan: null | {
    id: uuid,
    published_at: timestamp,
    plan_weeks: int,
    day_count: int,               // 该计划的训练日总数（「共 m 节」）
    has_settled_day: bool         // 第一份计划自身是否有已结算的天
  }
}
```

- 「本次绑定的计划」= `coach_id` 等于该绑定教练、`trainee_id` 等于学员、`status` ∈ {published, paused, completed}（不含 draft）、`published_at >= bind_request.responded_at`。第一份 = 按 `published_at` 升序、再按 `id`。
- `status != accepted` 时 `first_run = null`。
- 候选计划（同教练、同学员、非 draft）中只要有 `published_at` 为空的，返回 `first_run = null`（判定不了，宁可不出新东西）。
- 「已结算」按现有 plan_days 的结算字段（与学员端 `completed_at` 同源）。
- `first_plan` 只在第一份计划当前 `status = published` 时返回，否则为 null（学员端打不开暂停/已完成的计划，避免「开始 W1D1」打不开）。`binding_plan_count` 与顶层 `has_settled_day` 不受影响。（2026-10-26 收货补）

## 客户端规则（替换 SPEC「判定口径」里依赖客户端拉计划的做法）

- 只读 `bind_request.first_run`，不再为判定去拉计划列表或详情。
- `first_run` 缺失或为 null（老后端、Global 未部署、判定不了）→ 一律按现状：不出欢迎页、不出两张新卡，首页与今天逐字一致。
- 欢迎页：`has_settled_day == false` 且本机没看过。
- 新学员版等计划卡：首页处于现有等计划状态 且 `binding_plan_count == 0`。
- 第一份计划卡：`first_plan != null` 且 `first_plan.has_settled_day == false` 且本机没关闭。文案 W1–W{plan_weeks}、共 {day_count} 节；「开始 W1D1」打开 `first_plan.id` 的第一个训练日。
- 判定为「已结算/老学员」时可在本机记终态，之后不再判定。

## 埋点名（三端统一，后端白名单同步加）

- `bind_welcome_viewed`、`bind_welcome_continue`：无属性。
- `first_plan_viewed`、`first_plan_start`、`first_plan_dismiss`：属性 `plan_id`。
- `notification_permission_action`（仅 iOS）：属性 `source` ∈ {pending_bind, welcome}、`stage` ∈ {clicked, resolved}、`result` ∈ {allowed, denied}（仅 resolved 时有）。

后端 `src/routes/events/schemas.ts` 白名单补上以上 6 个事件及属性，随 055 一起上线。
