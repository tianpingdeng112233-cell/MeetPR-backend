# 017 — coached set log 缺省日期的 gym-day 截断(04:00)

- **状态**: InProgress
- **来源**: 内测学员反馈:训练到深夜、过 0 点后补录动作成绩/补传视频,成绩被静默记到"第二天"(coached 老 build 不送 `logged_date`,服务端按 Asia/Shanghai 午夜口径填当日)。2026-07-13 David 拍板方案 A(宽限窗),真补录(iOS 携带 `logged_date`)另行立项。
- **修订**: spec 010 §coached 形态"缺省按 Asia/Shanghai 当日填"的口径,由本 spec 取代。

## 范围

只改一处服务端缺省值的日界线口径,零迁移、零接口形状变化、零客户端改动:

- `POST /sets/log` coached 形态在 `logged_date` 缺省时,由「Asia/Shanghai 日历日」改为「Asia/Shanghai **训练日**」:**凌晨 04:00 前仍算前一日**(gym-day 截断)。
- adhoc 形态不受影响(`logged_date` 必填,客户端定日期)。
- 客户端显式携带 `logged_date` 时行为完全不变(仍以客户端为准,含 upsert 时 `update_logged_date` 规则)。

## 实现

- `src/utils/date.ts`:新增 `TRAINING_DAY_CUTOFF_HOUR = 4` 与 `shanghaiTrainingDay(now = new Date())`——把时刻回拨 4 小时后取 Asia/Shanghai 日历日。上海无 DST,位移法精确。
- `src/routes/sets.ts`:coached 缺省 `logged_date` 从内联 `shanghaiToday()` 换为 `shanghaiTrainingDay()`。

## 已知取舍

- 真在凌晨 00:00–04:00 开练"当天"计划的学员,成绩会落到前一日——按产品判断该人群近似为零,主场景(深夜训练跨 0 点补录)收益远大于此。
- 本改动不解决"第二天白天想起补录/补传"——那是真补录(iOS 携带 `logged_date` + e1RM `computedAt` 派生改造)的范围,已另行立项待拍板。

## 测试

- 纯函数:`tests/utils/date.test.ts`——03:59/04:00 边界、跨月、跨年。
- 路由级:`tests/sets-log.test.ts`——冻结系统时间(仅 fake `Date`)于 Shanghai 03:59/04:00,断言实际落库 `logged_date` 分别为前一日/当日。

## 消费方核对(实装时静态复核结论)

`scope=plan` 与教练端 fetch 按 `logged_at` 开窗不受影响;`scope=all` 按 `logged_date` 开窗,变化即本 spec 目标;imported-history 显式写计划日期不走缺省;e1RM/`assumed` 门逻辑不变。

## 变更记录

| 日期       | 版本 | 说明                                                                                         | 作者   |
| ---------- | ---- | -------------------------------------------------------------------------------------------- | ------ |
| 2026-07-13 | 0.1  | 初稿(实装同卡落地;review-loop 轮1 三 finding 全采纳:spec 载体、prettier、路由级冻结时钟回归) | Claude |
