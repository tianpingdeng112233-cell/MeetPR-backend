# 104 — 撤销完成：窗口从「当天」放宽到「完成后 7 天」（后端 061）

- **状态**: Ready（2026-11-06 /grill 两题 David 选 1B 2A，同日「确认」）
- **来源**: 2026-11-05 学员倪嘉骏反馈：周一训练卧推第 4 组实际只做了 5 次却记成 8 次，第二天发现时「撤销完成」已不可用，只能人工改库。
- **范围**: 后端（`MeetPR-backend` `staging`，编号 061）+ 学员端 iOS（`MeetPR` `release/1.0`）+ 安卓 RN（`meetpr-rn` `main`），三仓同批派卡、同批验收；三仓同目录镜像本文件（后端放 `specs/061-undo-window-7d/SPEC.md`，两端放 `specs/104-undo-window-7d/SPEC.md`）。
- **级别 / 节奏**: T2 / P1。无迁移、无数据模型改动、无新界面。
- **相关**: spec 071（顺序推进、撤销规则的出处）、081（补记，撤销沿用 071）、096（已完成日只读回看）。

## 已拍板

1. **窗口 = 完成后滚动 7 天**（1B）：`now - completed_at < 7 × 24 小时` 就能撤；恰好满 7×24 小时起不能撤。不再按训练日（凌晨 4 点分界）算。
2. **仍只能撤最近完成的那一天**（2A）：`NOT_LATEST_COMPLETION` 规则不变。想改更早的，就从最近一天开始一天天往回撤。

## 现状（已核实，后端 `origin/staging` b61e520 / iOS `origin/release/1.0` / RN `origin/main`）

- 后端 `src/handlers/plan-day-completions.ts` `undoPlanDayCompletion`：先查「是不是本计划最近完成的那条」，再比 `trainingDay(completed_at) === trainingDay(now)`，不等就返回 `UNDO_WINDOW_PASSED`（路由 `DELETE /plans/days/:dayId/complete`，409）。
- iOS `FlexibleTrainingDay.canUndo(_:days:now:)`：最近完成那天 + `WorkoutDatePolicy.gymDayRange(containing: now)` 包含完成时刻，才显示「撤销完成」。
- RN `src/domain/plan/sequence.ts` `canUndoCompletion(days, dayId, now)`：最近完成那天 + `completedToday(days, now)?.id === dayId`。
- 文案 `UNDO_WINDOW_PASSED` →「只能在当天撤销」：iOS `RepositoryContracts/Resources/Localizable.xcstrings`；RN `src/i18n/catalog/RepositoryContracts.json` 与 `RnExtras.json`。
- 注意同名错误码：`POST /plans/:id/shift` 的撤销（换天，spec 045/080）也返回 `UNDO_WINDOW_PASSED`，**那条不在本 spec 范围，保持当天**。

## 变更

### 后端（061）
1. `undoPlanDayCompletion` 的窗口判断改为 `now - completed_at < 7 天`（毫秒比较，与时区无关）。错误码名 `UNDO_WINDOW_PASSED` 不改，老客户端照常识别。
2. 不动 `NOT_LATEST_COMPLETION`、`NO_COMPLETION_TO_UNDO`、换天撤销。
3. 把「完成 → 撤销 → 隔几天再完成」路径上的副作用列清楚（`student_events` 的 dedup_key、`training_sessions` 状态、教练侧信号/推送），确认再完成不会给教练重复推送、不会出重复事件；有问题在本卡内修，并写进 JOURNAL。

### 两端（104）
1. 「撤销完成」入口显示条件：最近完成的那天 **且** 完成后不满 7 天。只改 `canUndo` / `canUndoCompletion`；`completedToday`（今日卡「今天已完成」）语义不变。
2. 入口出现在已完成日的完成态卡上（训练页周条选中那天）。今日页是否显示照现状，不新增入口。
3. 文案：`UNDO_WINDOW_PASSED` 改为
   - 简体：只能撤销 7 天内完成的训练
   - 繁体：只能復原 7 天內完成的訓練（沿用 094 繁体词表「撤销→復原」）
   - 英文：You can only undo workouts completed in the last 7 days
4. 撤销之后的行为沿用 071：那天回到游标、恢复可写，已记录的组和视频都保留，学员改完重新长按完成。

## 兼容与上线顺序

- **后端先部署，客户端后发包。** 老包仍只在当天显示入口，后端放宽不影响它们；新包若先遇到老后端，隔天撤会收到 `UNDO_WINDOW_PASSED`（显示新文案但撤不掉），所以后端必须先上。
- 无存量数据需要照护：只改判断，不改已有完成记录。

## 验收清单

后端
- [ ] B1 完成后 6 天 23 小时撤销 → 204；完成后 7 天整、7 天 + 1 分钟 → 409 `UNDO_WINDOW_PASSED`。
- [ ] B2 跨训练日撤销成功（次日、3 天后），时区取学员时区不影响结果。
- [ ] B3 非最近完成日 → 409 `NOT_LATEST_COMPLETION`（回归）。
- [ ] B4 3 天前完成 → 撤销 → 改一组 → 再完成：200；`student_events` 无重复、教练不收到重复推送/信号。
- [ ] B5 换天撤销（`/plans/:id/shift` undo）仍只限当天（回归）。

两端（iOS、安卓各验一遍）
- [ ] C1 3 天前完成、且是最近完成的一天：训练页选中那天可见「撤销完成」，点了撤销成功，那天恢复可写，周条与「落后 N 天」状态正确。
- [ ] C2 8 天前完成：入口不显示。
- [ ] C3 不是最近完成的那天（之后又完成过别的天）：入口不显示。
- [ ] C4 撤销后改一组再长按完成：奖励流程与改前一致，组数据为改后的值。
- [ ] C5 当天完成 → 撤销 → 再完成：与改前一致（回归）。
- [ ] C6 隔天撤销被后端拒绝时（模拟 409）显示新文案；简体 / 繁体 / 英文三语。
- [ ] C7 带历史的老用户升级后第一屏（今日页、训练页）正常。

## 测试 seam

- 后端：`tests/plan-day-completions.test.ts`（`undoPlanDayCompletion` 已接受 `now` 参数），先红后绿加 B1–B4；B5 用 `tests/plans/plan-day-shifts.test.ts` 现有用例回归。
- iOS：`FlexibleTrainingDay.canUndo(_:days:now:)` 纯函数，在 `FlexibleTrainingDayTests.swift` 加 3 天 / 6 天 23 小时 / 7 天 / 8 天 / 非最近用例。
- RN：`canUndoCompletion(days, dayId, now)`，在 `src/domain/plan/__tests__/sequence.test.ts` 加同一组用例。
- 文案：两端各自现有的 i18n 完整性检查。

## Out of Scope

- 已完成日直接改单组（不撤销）。
- 撤销超过 7 天、撤销非最近完成日。
- 换天（shift）撤销窗口。
- 教练端、网页端任何改动。
- iOS RPE 小数显示成逗号（`9,5`）：另案。
