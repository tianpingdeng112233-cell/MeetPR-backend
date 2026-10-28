# 052 卡 1028f · 天数超限时按表头日块重组（David 10/28「同意」）

先读 `CONTEXT.md`、`SPEC.md`、`docs/journal/2026-10-28-052-retry-split.md` 的 regressions 小节。

## 目标

模型偶尔把同一周的动作拆进过多的 day（超过 7 个、或 weekday 重复），周骨架校验（`WeekSkeletonSchema` 的天数 / weekday 唯一约束）直接判 `BAD_OUTPUT`。改为：骨架**只因**天数超限或 weekday 重复而失败、且动作本身合格时，先用 `groundWeek` 的表头日块把动作重新归到对应的天（与 1028 的重组同一套逻辑）；重组后骨架合格就照常返回，仍不合格才 `BAD_OUTPUT`。其他骨架错误不走这条路。

另：移除 `src/services/plan-import/deepseek.ts` 里全部 `[1028f-dbg]` 探针行（含为探针加的 import），`git diff` 不得残留；journal 里把 PENDING REMOVAL 改为已移除。

不做：outline 返回空周的重问（David：该样表不是力量举计划，不作测试样表）。

## 测试 seam（先红后绿，合成夹具）

`tests/plan-imports.test.ts` 路由层 + 假模型：① 4 个日块的动作被拆成 9 个 day → 响应按日块重组为 4 天、无 error；② 拆成多个 day 但没有表头日块可依 → 仍 `BAD_OUTPUT`；③ 别的骨架错误（如 day_index 不递增以外的结构错）不受影响。

## 验收

typecheck / lint / format:check / build 全绿 + 两个 plan-import 测试文件计数；红→绿；探针清零；journal 追加。不 commit / push / merge；不启停 3000 端口服务。
