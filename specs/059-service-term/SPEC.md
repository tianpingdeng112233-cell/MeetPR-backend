# 059 — 学员服务期（服务至）

- **状态**: Ready（2026-11-04 /grill 共识「确认」）
- **产品正典**: `meetpr-plan-web` 仓 `specs/024-service-term-countdown/SPEC.md`。本 spec 只定后端改动。
- **级别 / 节奏**: T2 / P1（一条迁移 + 一个新接口 + 两处附加字段）。分支 `feat/059-service-term` → `staging`。合并后必须部署国内 staging；迁移由 David 在 DMS 执行。

## 现状

- 没有任何服务期字段。计划 `end_date` 与总览 `plan_ending` 是另一回事，不复用。
- 师生关系 = `bind_requests` 中 `status='accepted'` 的行；057 起解绑把该行改 `ended`，重新绑定新建一行。
- `POST /coach/bind-requests/:id/accept` 的 body 是 `.strict()` 的 `{ skip_evaluation, skip_reason? }`；iOS、安卓、网页都在调。
- `GET /coach/students` 每个学员已带 `alias`、`bond_status`、`today` 等附加字段（057）。

## 变更

### 1. 迁移（下一个空号，派卡时现场核实；2026-11-04 staging 已到 0082，应为 0083）

- `bind_requests` 增加 `service_until DATE NULL`。
- 放在绑定行上而不是 (教练, 学员) 键上：解绑后随旧行留存但不再展示，重新绑定的新行为 null，天然满足「重新绑定要重填」。
- 纯新增，不改存量行、不回填（老学员 = null = 不显示）。附 Down 说明。

### 2. 接收时可带服务期

- accept body 增加可选 `service_until: 'YYYY-MM-DD' | null`。缺省或 null = 不设。仍保持 `.strict()`。
- 写入新建（或被接受）的 accepted 行。旧客户端不传，行为与现网完全一致。

### 3. 设置 / 修改 / 清除

- `PUT /coach/students/:id/service-term`，body `{ service_until: 'YYYY-MM-DD' | null }`（null 即清除）；返回 `{ service_until }`。
- 只作用于该 (教练, 学员) 当前 accepted 行。没有 accepted 关系（含已解绑）→ 404 `COACH_STUDENT_NOT_FOUND`，与 rename 一致。学员角色 → 403。
- 日期校验：合法日历日期；不限制必须晚于今天（允许补录已过期）；上限 今天 + 5 年，超出 400。

### 4. 花名册字段

- `GET /coach/students` 每个学员追加 `service_until: 'YYYY-MM-DD' | null`，取自当前 accepted 行。`include_ended=1` 追加的 ended 学员一律 null。
- 只返回日期，不在后端算剩余天数（天数按教练浏览器本地日期在网页端算）。
- 查询条数保持固定（057 的固定条数测试继续绿）。

## 验收清单

1. 迁移在空库与带存量数据的库上都能整段执行、可重跑；存量行 `service_until` 全为 null。
2. accept：不传 / 传 null / 传合法日期三种都 200，DB 值对应；传非法日期 400；旧请求体（只有 `skip_evaluation`）行为不变。
3. PUT：设置、修改、清除生效；非本教练学员 404；已解绑学员 404；学员角色 403；非法日期与超 5 年 400；过去日期允许。
4. 花名册：带 `service_until`；ended 学员为 null；解绑后重新申请并接受（不传）→ null。
5. 全量测试绿；部署国内 staging 后用一对测试师生 curl 走一遍：接受带日期 → 花名册可见 → 修改 → 清除 → 解绑重绑后为 null。

## 测试 seam

- 现有 bind-requests accept 路由测试：补 `service_until` 三种入参与非法值，先红后绿。
- 现有 coach 路由测试（`/coach/students`）：补 PUT service-term 各分支与花名册字段、ended 为 null、重绑为 null。

## Out of Scope

- 后端计算剩余天数、总览提醒接口新增服务期类型、每日摘要、推送。
- 学员端接口暴露服务期。
- 服务期历史、续费记录、按课次计数。
- 到期后的任何权限变化。
