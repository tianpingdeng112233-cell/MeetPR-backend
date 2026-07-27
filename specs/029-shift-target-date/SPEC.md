# 029 — 整计划顺延的 target_date 锚点(spec 054 addendum)

- **状态**: InProgress(随 PR #107 实装)
- **来源**: 黑金 v3 W2a 发现沪 00:00–08:00 设备日≠UTC 日,页面显示的『今天』与服务端顺延的日子错位;David 2026-07-27 拍板直接修。T1 / P1。零迁移。

## 契约

`POST /plans/:id/shift` 接受可选 JSON body:

```json
{ "target_date": "YYYY-MM-DD" }
```

- `target_date` = 客户端本地的『今天』。缺省/空 body = 现行为(服务端 UTC 今天),旧客户端零影响。
- 校验:必须是真实公历日期;|与服务端 UTC 日期差| ≤ 1 天(仅吸收时区偏移,UTC−12…+14 至多差一个日历日;不是改期入口)。违反 → 400 `VALIDATION_ERROR`。
- 锚定:`target_date` 取代 UTC 今天作 `createWholePlanShift` 的锚;该日无 effective 计划日 → 409 `SHIFT_ONLY_TODAY`;该日课程已有记录 → 409 `ALREADY_STARTED`。
- **每 UTC 日至多一次顺延动作**(不论锚点):已有当日批次 → 409 `SHIFT_ONCE_PER_DAY`(新错误码;旧客户端未映射时按通用错误降级)。防锚点在 ±1 窗内游走连环顺延。已知取舍:UTC+8 用户当地连续两天在同一 UTC 日内各顺延一次的极端场景会被挡到 UTC 日翻转(当地 08:00)。
- **撤销(DELETE)**:窗口仍=批次创建的 UTC 当日;`ALREADY_STARTED` 门改为锚定日检查——批次的最早前移日期(=锚日)或 UTC 今天,任一命中且该日已有记录即拒绝,堵住跨日锚绕过撤销门把已开练课程退回过去的洞。

## 验收

路由测试覆盖:显式今天锚定/慢一天客户端锚昨日课/窗口内休息日 409/超窗 400/假日期(2026-07-32) 400/strict body 400/同 UTC 日二次顺延 409 SHIFT_ONCE_PER_DAY/跨日锚→打卡→DELETE 409 ALREADY_STARTED/无 body 旧行为回归。`pnpm test` 全绿。
