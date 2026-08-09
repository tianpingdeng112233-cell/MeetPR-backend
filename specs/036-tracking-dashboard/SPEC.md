# SPEC 036 — 教练追踪看板：周聚合扩展 + plan-web 追踪 tab

- **Status: InProgress**
- **级别**: T2（跨仓两卡：backend 读聚合扩展 + plan-web 新 view；**无迁移**）
- **来源**: David 2026-08-09 拍板方案 A（后端聚合 + web 纯渲染）。参照 PowerSheets Coach
  Workspace 的 Tracking 图表版式。收编 PR #94（`feat/e1rm-series-volume-api`，教练分析 W1
  波遗留）为数据层基底，不另起第二套口径。
- **端**: backend（本仓）+ plan-web（`meetpr-plan-web` 仓，§6）。iOS 不在本卡。

## 1. 目标与非目标

### 1.1 目标

- `GET /coach/students/:id/exercise-stats` overview 在 #94 已有的 `e1rm_series` /
  `weekly_volume` 之上，补齐追踪 tab 还缺的三类聚合：**逐 family 周指标**（容量 / 平均
  RPE / top-set 强度）、**强度分布**、**次数分布**。
- 收编时把 #94 的聚合对齐 cherry-pick 之后这三周的 e1RM 域演进（资格门 / confidence /
  coach_rpe 优先），全部复用 `calculateEligibleE1RM` / `resolveCompetitionFamily` /
  `E1RM_POLICY`，不新造常量。
- plan-web 新增第六个工作区 view「追踪」，纯消费上述响应画 8 张图（§6）。

### 1.2 非目标

- **无迁移、无写路径**；纯读聚合。
- 不做体重（Bodyweight）时序——数据源等 wellness 波（backend #95）上线后另卡。
- 不做周期对比（vs comparison）、不做按训练 block 切换；首版固定 90 天窗口。
- 不动 PR #29（roster 趋势卡）；其去留另议。
- 不做 iOS 端图表。

## 2. 已有基底（cherry-pick d485bcc，本分支已带）

- `e1rm_series`: `Record<LiftFamily, { points: {date, value}[], trend }>`，90 天窗，
  严格竞技口径（`resolveCompetitionFamily`）。
- `weekly_volume`: `{ week_start, volume_kg, avg_rpe, volume_by_family }[]`，周一分桶，
  宽口径（`main_lift_family`，练了就算容量）。两种口径的不一致是**有意的**，见 #94 PR body。
- 已知损伤：`tests/unit/exercise-stats-aggregates.test.ts` 有 1 例因 e1RM 域这三周的演进
  而红（期望 105.00 实得 290.70）。**先诊断口径差异再修**——以当前 staging 的 e1RM 域为准
  重算期望值，不是把新逻辑改回旧行为。

## 3. 新增聚合（响应 additive-only）

窗口与 `e1rm_series` 一致（`EXERCISE_STATS_LIMITS.overviewWindowDays` = 90 天）。所有
「family」按 `weekly_volume` 同款宽口径 `main_lift_family` 归组（分布图统计的是训练行为，
不是竞技资格）；`other` 不出现在下述三个聚合里，只统计 squat/bench/deadlift 三 family。
仅计入 `completed = true` 且未 `assumed` 的组；`failed` 组计入容量与分布（练了就是练了），
RPE 均值只吃有 RPE 的组（`coach_rpe` 优先于自报 `rpe`，与 spec 030 口径一致）。

### 3.1 `weekly_family_metrics`

```
weekly_family_metrics: Record<'squat'|'bench'|'deadlift', {
  week_start: string;            // 周一，与 weekly_volume 同分桶
  volume_kg: string;             // Σ(weight×reps)，NUMERIC 字符串
  avg_rpe: string | null;        // 该 family 该周均 RPE（coach_rpe 优先）
  top_set_intensity: string | null; // 见下
}[]>
```

- `top_set_intensity`：该周该 family **最重一组**的 `weight_kg` ÷ 分母 e1RM，百分数字符串
  （如 `"82.4"`）。分母 = `e1rm_series` 同 family 中 **date ≤ 该组 logged_date 的最近点值**；
  找不到分母点则为 `null`。
- 周桶只输出窗口内**有该 family 训练记录**的周；空周不补零点（web 侧按 week_start 对齐）。

### 3.2 `intensity_distribution`

```
intensity_distribution: Record<'squat'|'bench'|'deadlift', {
  lt70: number; b70_80: number; b80_90: number; gte90: number;   // 组数 count
}>
```

- 每组的强度 = `weight_kg` ÷ 同上口径的时点 e1RM；无分母的组**不计入**（也不进桶）。
- 桶边界左闭右开：`[0,70) [70,80) [80,90) [90,∞)`。web 侧自行换算百分比。

### 3.3 `rep_distribution`

```
rep_distribution: Record<'squat'|'bench'|'deadlift',
  { reps: number; count: number }[]>   // reps 1..8 逐档；≥8 归入 reps=8 档
```

- 用**实际完成 reps**（不是计划目标次数）；reps ≥ 8 合并进 `8` 档（web 显示 `8+`）。

## 4. 实现约束

- 聚合全部在既有单次查询的日志数组上内存完成（跟 #94 一致），不加新 SQL 往返。
- handler 导出的纯函数 + 单测覆盖：分母时点选取、无分母跳过、failed/assumed 取舍、
  coach_rpe 优先、8+ 归档、周桶对齐 `mondayOfWeek`。
- `docs/api` 若有 exercise-stats 契约文档则同步；无则不新建。

## 5. 验收（backend 卡）

- `vitest run` 全绿（含修好的 aggregates 旧测试）。
- `npm run lint` / `tsc --noEmit` 干净。
- staging 部署后用测试教练号 curl 实测：三个新字段形状正确、与 iOS 学员端已示数字
  同数量级（人工抽查一周容量）。

## 6. plan-web 追踪 tab（web 卡）

- `CoachView` 增加 `'tracking'`，NAV_ITEMS 第六项 `{ id: 'tracking', label: '追踪', short: '追' }`，
  走既有 `navigateCoachView`（无编辑器脏态，不需 guardLeave）。
- 学员选择器复用工作区现有 `selectedStudentId` 机制（与反馈工作区同款下拉/列表）。
- 数据源：现有 `GET /coach/students/:id/exercise-stats`（含本 spec 新字段）。**一次请求
  画全部图**；字段缺失（老后端）时对应卡片显示「后端版本过旧」占位，不崩。
- 8 张图，三 family 各一列（squat 蓝 / bench 绿 / deadlift 红，延续现有品牌语汇）：
  1. e1RM over time（折线，`e1rm_series`；标题栏显示末值 + vs start 差值与趋势色）
  2. Volume over time（柱状，`weekly_family_metrics.volume_kg`，吨位显示 `x.x t`）
  3. Avg RPE over time（折线，`weekly_family_metrics.avg_rpe`）
  4. Intensity over time（折线，`weekly_family_metrics.top_set_intensity`，副标题
     "Top set，占 e1RM %"）
  5. Intensity distribution（柱状，`intensity_distribution` 换算 %，x 轴 `<70% / 70–80% /
80–90% / 90%+`）
  6. Rep distribution（柱状，`rep_distribution` 换算 %，x 轴 1..8+）
  7. Volume share by lift（横条，三 family 90 天总容量占比，由 weekly_family_metrics 求和）8.（占位）Bodyweight——本版渲染「暂无体态打卡数据」空态卡，等 wellness 数据源。
- 图表**手写 SVG**（折线 / 柱状 / 横条三个小组件），零新依赖；viewBox 自适应容器宽，
  数值文案中文（「周」「组」「吨」）。
- 验收：`npm run build`（tsc + vite）绿、`vitest run` 绿、新组件带 UI 测试（沿用仓内
  jsdom 测试写法）；本地 dev 用测试教练号选一名有数据学员逐图人工核对。
