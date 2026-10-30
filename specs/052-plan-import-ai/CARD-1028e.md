# 052 卡 1028e · 逐组次数拆行 + 校验命中时自动重识别一次 + 时间区间

先读仓根 `CONTEXT.md`、`SPEC.md`（§2.3、§2.6）、`CARD-1028.md`、`CARD-1028d.md`、`docs/journal/2026-10-28-052-batch-fixes.md`。

## 目标

1. **逐组不同次数拆行（spec §2.6）**：提示词明确：一个动作各组次数或「次数×重量」组合不同 → 按连续相同处方拆成多个同名动作依次返回，每个的 `sets` 为该段组数。服务端：模型若仍把这种行塞成一个动作（`source_cells` 内出现多个不同的「重量 + 次数」对，结构化只覆盖其中一段），按现有吞行 / 追加组检测进 `unreadable`，不新增绕过。
2. **校验命中时自动重识别一次**：某周经 `validateExercises` + `groundWeek` 后出现 `OTHER`（吞行 / 追加组 / 逐组未拆）时，带一句纠正提示（「上一次输出把这些格子合并成了一个动作：[[r,c]…]；名字为空只有组次的行、以及各组处方不同的行，都要作为同名的另一个动作返回」——只给坐标，不回传单元格文本以外的内容）对**这一周**重调一次模型；取 `OTHER` 更少的结果（相同则取第一次）。该次重试计入现有「每个 import 第二步最多 8 次」的口径吗？——**不计**，它是同一次调用内部的重试，但 token 用量照常累计进 `plan_import_runs`。
3. **时间区间次数**：`reps` 接受 `30s-60s`、`30-60s`、`30~60秒` → 规范为 `30s-60s`；网页编辑器若不支持秒区间，读 `meetpr-plan-web-wt-015` 的次数解析（只读）确认，不支持时规范为下限 `30s` 并把原文留在 note、加 `note_fallback`，二选一写进 JOURNAL。

## 约束

合成夹具；不调用真模型（重试逻辑用假模型返回「先坏后好」「两次都坏」两种序列测）；不启停 3000 端口服务；不改响应形状；日志不含单元格文本。

## 测试 seam（先红后绿）

`tests/plan-imports.test.ts` 路由层 + 假模型：① 先返回合并动作、重试返回拆好的 → 响应为拆好的且无 unreadable；② 两次都合并 → 取第一次、unreadable 保留；③ 重试不增加 import 的调用计数，token 累计；④ 时间区间三种写法。`tests/services/plan-import-deepseek.test.ts`：纠正提示只含坐标。

## 验收

`pnpm typecheck` / `lint` / `format:check` / `build` 全绿 + 两个 plan-import 测试文件计数；红→绿表；JOURNAL `docs/journal/2026-10-28-052-retry-split.md`。不 commit / push / merge。Opus 收货后真 DeepSeek 复跑 34 份。
