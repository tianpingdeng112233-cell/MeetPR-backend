# 106 — e1RM 换用扩展版 RPE 表（后端 062）

- **状态**: Ready（2026-11-07 /grill 五题 David 选 1A 2A 3A 4A 5A，同日「确认」）
- **来源**: 2026-11-07 两位学员反馈「e1RM 感觉有点高」。核查发现三端用的不是扩展版 RPE 表，而是一张自制近似表（RPE 每降 0.5 扣 2%，扩展版约扣 1.5%）。同一组，RPE 7–8、3–5 次时 e1RM 比扩展版高 3–6%，RPE 6 时高 7–9%。
- **范围**: 后端（`MeetPR-backend` `staging`，编号 062）+ 学员端 iOS（`MeetPR` `release/1.0`）+ 安卓 RN（`meetpr-rn` `main`），三仓同批派卡、同批验收；三仓同目录镜像本文件（后端放 `specs/062-e1rm-extended-rpe-table/SPEC.md`，两端放 `specs/106-e1rm-extended-rpe-table/SPEC.md`）。
- **级别 / 节奏**: T2 / P1。无数据库迁移；两端各有一次端上历史重算。
- **相关**: spec 028（e1RM 曲线与 RTS 查表，本 spec 替换其 §2 的表值，查表 + 插值的机制不变）；Brain `wiki/powerlifting/rpe-and-autoregulation.md` §三（扩展版表一手核对来源）。

## 已拍板

1. **用扩展版表，带小数**（1A）。来源：JTS 4.0 Calculator、Programming To Win Ch4 p23、rpecalculator.com 逐格一致。不用网上流传的整数版。
2. **学员手机上的历史曲线按新表全部重算**（2A），不让曲线在升级当天凭空掉一截。
3. **已产生的 PR 徽章 / PR 记录全部保留**（3A），不撤回、不重判。
4. **只在更新说明和教练群里讲一句**（4A）：「e1RM 口径校准，数字和按 e1RM 开的重量整体下调 3–6%」，应用内不弹窗、不加新文案。
5. **只换表**（5A）。RPE 9.6 校正、RPE < 7 的组不进曲线，都不在本 spec。

## 现状（已核实，后端 `origin/staging` c349672 / iOS `origin/release/1.0` 249c6c5b / RN `origin/main` 3279bff）

- 表只有一处真源，每仓一份：
  - 后端 `src/domain/e1rm.ts` `RTS_INTENSITY`（1–10 次 × RPE 6–10），`calculateEligibleE1RM` 用它；`src/handlers/exercise-stats.ts` 每次请求从 `set_logs` 现算 e1RM（教练端成长曲线、网页），**不存结果**。
  - iOS `Modules/CoreModels/Sources/CoreModels/Domain/E1RMCalculator.swift` `rtsTable`（1–12 次），`calculate` 与 `suggestedWeight` 共用。
  - RN `src/domain/e1rm/constants.ts` `RTS_INTENSITY_TABLE`（1–12 次），`calculator.ts` 的 `calculateE1RM` 与 `suggestedWeightKg` 共用。
- 各仓测试里有一份旧表的拷贝：iOS `CoreModelsTests/E1RMCalculatorTests.swift`、RN `src/domain/e1rm/__tests__/calculator-policy.test.ts`。
- 学员端 e1RM 历史存在手机本地：iOS `LocalE1RMRepository`（Documents/e1rm/ JSON），RN `src/features/training/storage.ts`。每个点 `E1RMHistoryPoint` 都带 `sourceWeightKg / sourceReps / sourceRPE / sourceCoachRPE`，可以按新表原地重算 `e1RMKg`。
- 现成的一次性重算写法：iOS `E1RMCompetitionLiftMigration`（`UserDefaultsE1RMMigrationStore` 版本键 + `replaceHistory`）、`E1RMCoachRPEReconciler`；RN `src/features/history/history-points.ts` `loadGrowthHistory`（`replaceHistoryIfUnchanged` + revision 防并发）。
- 新的 PR 提醒已改为按实测重量判（`pr-detection.ts` 文案「实测重量新高」），换表不影响。
- 依赖 e1RM 的处方会跟着变（预期内）：`pct_anchor = 'e1rm'` 的百分比处方、RPE 处方的建议重量（`suggestedWeight(Kg)`）。

## 变更

### 新表（三端逐格一致，单元格 = %1RM 的小数）

行 = 次数，列 = RPE。1–10 次取自扩展版原表；11–12 次只有两端需要（后端只到 10 次），按扩展版的对角规律（「次数 + (10 − RPE)」相同则值相同）推出，超出原表的四格（标 *）按末段斜率每半格 −1.35 外推。

| 次数 \ RPE | 6 | 6.5 | 7 | 7.5 | 8 | 8.5 | 9 | 9.5 | 10 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 0.863 | 0.878 | 0.892 | 0.907 | 0.922 | 0.939 | 0.955 | 0.978 | 1 |
| 2 | 0.837 | 0.85 | 0.863 | 0.878 | 0.892 | 0.907 | 0.922 | 0.939 | 0.955 |
| 3 | 0.811 | 0.824 | 0.837 | 0.85 | 0.863 | 0.878 | 0.892 | 0.907 | 0.922 |
| 4 | 0.786 | 0.799 | 0.811 | 0.824 | 0.837 | 0.85 | 0.863 | 0.878 | 0.892 |
| 5 | 0.762 | 0.774 | 0.786 | 0.799 | 0.811 | 0.824 | 0.837 | 0.85 | 0.863 |
| 6 | 0.739 | 0.751 | 0.762 | 0.774 | 0.786 | 0.799 | 0.811 | 0.824 | 0.837 |
| 7 | 0.707 | 0.723 | 0.739 | 0.751 | 0.762 | 0.774 | 0.786 | 0.799 | 0.811 |
| 8 | 0.68 | 0.694 | 0.707 | 0.723 | 0.739 | 0.751 | 0.762 | 0.774 | 0.786 |
| 9 | 0.653 | 0.667 | 0.68 | 0.694 | 0.707 | 0.723 | 0.739 | 0.751 | 0.762 |
| 10 | 0.626 | 0.64 | 0.653 | 0.667 | 0.68 | 0.694 | 0.707 | 0.723 | 0.739 |
| 11 | 0.599* | 0.6125* | 0.626 | 0.64 | 0.653 | 0.667 | 0.68 | 0.694 | 0.707 |
| 12 | 0.572* | 0.5855* | 0.599* | 0.6125* | 0.626 | 0.64 | 0.653 | 0.667 | 0.68 |

不变的部分：查表 + 0.5 档之间线性插值；RPE 为空或 < 6 走 Epley；RPE > 10 拒绝；RPE 5–5.5 建议重量沿用首个半档斜率外推；建议重量向下取整到 2.5 kg；资格规则（最多 10 次、硬拉最多 5 次、`low` 置信度不计）与 28 天窗口、3% 噪声带、跳变阈值全部不动。代码注释里「RTS table」的来源说明改为「扩展版 RPE 表（JTS / Programming To Win）」。

### 后端（062）

1. `src/domain/e1rm.ts` `RTS_INTENSITY` 换成上表 1–10 行。其余逻辑不动。
2. 部署后教练端与网页的 e1RM 立即按新表显示，无存量数据要处理（现算）。

### 两端（106）

1. 换表：iOS `rtsTable`、RN `RTS_INTENSITY_TABLE` 换成上表 1–12 行。
2. **一次性历史重算**（每个学员每台设备跑一次，带版本键，例如 `e1rm-extended-rpe-table-v1`）：
   - 对本地每个 e1RM 历史点，用自己存的 `sourceWeightKg / sourceReps` 与有效 RPE（`sourceCoachRPE` 优先，否则 `sourceRPE`，与现有 `effectiveSourceRPE` 口径一致）按新表重算 `e1RMKg`。
   - 只改 `e1RMKg`；`id / setLogId / computedAt / origin / confidence / source*` 原样保留。重算结果为空（按新表不在公式范围内）的点保持原值不动。
   - **不丢弃、不重判 PR 事件，不动 `weightBaselines`**（与 `E1RMCompetitionLiftMigration` 丢 PR 的做法相反，这里必须保留）。
   - 原子替换、可重入：重算本身是幂等的，跑一半被杀，下次启动重跑结果相同；与正在记录的新组并发时不丢点（RN 沿用 `replaceHistoryIfUnchanged` + revision；iOS 沿用 actor 内 `replaceHistory`）。
   - 存储读不出来时不重算、不覆盖，照现有只读兜底显示。
3. 迁移跑在现有的历史加载 / 启动迁移路径上，不新增界面、不新增文案。

## 兼容与上线顺序

- 后端合并即部署 staging（按「backend 严禁只合不部署」）。两端新包发出之前，教练端看到的 e1RM 会比学员手机上的低 3–6%，属于预期的过渡差，靠第 4 条的群通知解释。
- 老包不受影响（继续用旧表算本地值），升级后由第 2 条一次性对齐。
- 存量数据照护：后端无存量（现算）；两端历史按第 2 条原地重算，保留所有点与 PR，不删任何数据。

## 验收清单

后端
- [ ] B1 `calculateEligibleE1RM`：100 kg × 5 @8 → 123.30（±0.01）；100 × 3 @9 → 112.11；100 × 1 @10 → 100；100 × 5 @7.75 → 100 ÷ 0.805（0.799 与 0.811 的中点）= 124.22。
- [ ] B2 RPE 为空、RPE 5.5 → Epley 结果不变（100 × 5 → 116.67）；RPE 10.5 → null；硬拉 6 次、任意 11 次 → null（回归）。
- [ ] B3 表 1–10 行与本 spec 逐格相等（测试里逐格断言）。
- [ ] B4 `GET` 学员动作统计（exercise-stats）对同一份 set_logs 返回按新表的 e1RM 与 28 天窗口最佳值；趋势 up/down 判定仍按 3% 噪声带。

两端（iOS、安卓各验一遍）
- [ ] C1 计算器单测：B1、B2 的同组输入两端结果与后端一致；11、12 次各验一格（100 × 12 @8 → 159.74）。
- [ ] C2 表逐格断言：1–12 行与本 spec 相等。
- [ ] C3 建议重量：e1RM 123.3、处方 2 次 @9 → 112.5 kg（123.3 × 0.922 = 113.68，向下取整到 2.5）；由 100 × 5 @8 算出的 e1RM（100 ÷ 0.811）再开 5 次 @8 → 100 kg（往返不因浮点误差掉到 97.5）。
- [ ] C4 `pct_anchor = e1rm` 80% 处方：按新的当前 e1RM 解析，结果随之下调。
- [ ] C5 历史重算：预置一份旧表算出的本地历史（含 `logged` 与 `imported`、含教练改过 RPE 的点、含 PR 事件），升级后每个点 `e1RMKg` = 新表按 source 字段重算值，其余字段与 PR 事件、`weightBaselines` 字节级不变；再次启动不重复改动。
- [ ] C6 重算中途杀进程 → 再启动结果与一次跑完相同；重算期间记一组新组，新点不丢。
- [ ] C7 带历史的老用户升级后第一屏（今日页、训练页、成长曲线 / Progress）正常：曲线整体下移、不出现断崖、PR 徽章仍在。
- [ ] C8 三语界面无新增 / 变更文案（grep 本次 diff 无 i18n 改动）。

## 测试 seam

- **后端**：`calculateEligibleE1RM`（`src/domain/e1rm.ts`）单测先红后绿覆盖 B1–B3；B4 复用 exercise-stats 现有 handler 测试，改断言值。
- **iOS**：`E1RMCalculator.calculate / suggestedWeight`（CoreModelsTests）覆盖 C1–C3；历史重算以迁移 actor 为 seam，注入 `InMemory` / 临时目录 `LocalE1RMRepository` 与内存版迁移存储覆盖 C5–C6，参照 `E1RMCompetitionLiftMigration` 现有测试。
- **RN**：`calculateE1RM / suggestedWeightKg / resolvePctAnchor`（`src/domain/e1rm/__tests__`）覆盖 C1–C4；历史重算以加载函数为 seam（同 `loadGrowthHistory` 的测试方式，内存 repository + revision）覆盖 C5–C6。
- C7 在模拟器（iOS `iPhone 17e`；安卓按验收模拟器约定）用带历史的账号亲眼看。

## Out of Scope

- 1RM 平均 RPE ≈ 9.6 的校正；RPE < 7 的组排除出曲线；Epley 兜底的口径。
- 资格规则、窗口、噪声带、跳变阈值的任何调整。
- 历史 PR 的重判或撤回；后端 `student_events` 里旧 `pr_e1rm` 事件。
- 应用内告知 / 弹窗 / 新文案；演示数据（demo seed）里写死的 e1RM 数值。
- 网页端（plan-web）：不自己算 e1RM，读后端结果，无需改动。
