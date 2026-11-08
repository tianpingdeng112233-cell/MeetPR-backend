# 058 — 有打卡的计划允许「只延长」

- **状态**: Ready（2026-11-02 /grill 共识「确认」）
- **产品正典**: `meetpr-plan-web` 仓 `specs/023-cross-student-paste/AMEND-auto-extend.md`（粘贴超出计划末尾时自动延长）。本 spec 只定后端改动。
- **级别 / 节奏**: T2 / P1。无迁移。分支 `feat/058-plan-extend` → `staging`。**合并后先部署国内 staging，再上网页 023 补充。**

## 现状（staging@6d2e285 已核实）

- `PATCH /plans/:id` 与 `POST /plans/:id/days/batch`（`plan_patch`）只要涉及 `start_date / end_date / plan_weeks`，就先 `planHistoryLocked`；计划里有任何打卡即 409 `PLAN_HISTORY_IMMUTABLE`（batch 为 `plan-history-immutable` 分支）。与发布状态无关。
- 已发布计划的树变更会入队 `plan_updated` 推送（现有逻辑）。

## 改动

1. 在上述两处，把「有打卡就拒绝日历字段变更」放宽为：**纯延长**放行，其余照旧拒绝。
2. **纯延长**的判定（同时满足）：
   - 不带 `start_date`，或带的值与现值相同；
   - 带了 `plan_weeks` 时，新值 ≥ 现值，且不超过现有上限（52）；
   - 带了 `end_date` 时，新值 ≥ 现值；
   - `plan_weeks` 与 `end_date` 合并后仍满足现有日期一致性校验（`end_date ≥ start_date` 等现有规则不变）。
   - `PATCH /plans/:id` 里的 `source_template_id` 变更不算延长，仍按现有规则处理。
3. 不改：缩短、改开始日、无打卡计划的任何现有行为；`day-history-immutable`（删除含打卡的天）照旧拒绝。
4. 同一 batch 里先应用延长、再写新周的天，保证新天不因超出周数被拒。
5. 推送：沿用现有 `plan_updated` 规则，不新增推送类型。

## 验收清单

1. 有打卡的计划：`days/batch` 带 `plan_patch: { plan_weeks: 现值+2, end_date: 现值+14 天 }` 并 upsert 新周的天 → 200，周数、结束日、新天都写入；已打卡天与开始日不变。
2. 同上，用 `PATCH /plans/:id` 只改 `plan_weeks` / `end_date` 为更大值 → 200。
3. 有打卡的计划：缩短周数、提前结束日、改开始日 → 仍 409 `PLAN_HISTORY_IMMUTABLE`。
4. 无打卡计划：所有现有日历字段行为不变（现有测试全绿）。
5. 已发布计划延长 + 新天：仍入队一次 `plan_updated`。
6. `npm test` 全量、typecheck、build 全绿；部署 staging 后 curl：/health 200。

## 测试 seam

- 复用 `tests/plans/plans-batch.test.ts` 与 `tests/plans/plans.test.ts` 中已有的 `PLAN_HISTORY_IMMUTABLE` 用例做邻居：先写「有打卡 + 纯延长 → 200」两条（batch / PATCH）为红，再放宽判定转绿；「缩短 / 改开始日仍 409」各一条作护栏。
- 判定逻辑抽成纯函数（输入现值与 patch，输出是否纯延长），单测覆盖边界（相等、+1、超 52、只带 end_date、只带 plan_weeks）。

## Out of Scope

- 缩短计划、插入整周、改开始日的任何放宽。
- 新推送类型；App 端改动（两端按现有计划数据显示新增的周）。
- Global（DOCR）环境的部署。
