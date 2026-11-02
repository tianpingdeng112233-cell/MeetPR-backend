# 058 CARD-A — 有打卡计划的纯延长放行（backend 单卡）

先读仓内 `CONTEXT.md`（有则读）与 `AGENTS.md` / `CLAUDE.md`，再读本目录 `SPEC.md`。SPEC 是正典。

## 目标

`PATCH /plans/:id` 与 `POST /plans/:id/days/batch` 在计划有打卡时，放行「纯延长」的日历字段变更（判定见 SPEC §改动 2），其余仍 409。

## 文件范围

- `src/routes/plans/index.ts`（两处 `planHistoryLocked` 分支）
- 判定纯函数可放在同目录的新文件或现有 helper 文件内。
- 测试：`tests/plans/plans-batch.test.ts`、`tests/plans/plans.test.ts`，以及判定函数的单测。
- 不加迁移、不加依赖、不改推送、不改其他路由。

## 约束

- 保持「缩短 / 改开始日 / 删含打卡的天」仍被拒；错误码与响应形状不变。
- 同一事务内先写 plan 字段、再写新天。

## 验收标准

SPEC「验收清单」1–6（第 6 条部署由 Opus 做）。

## 测试 seam

见 SPEC「测试 seam」，先红后绿。

## 交付

- 分支 `feat/058-plan-extend`，PR base `staging`，不合并。
- JOURNAL：`docs/journal/<日期>-058-plan-extend.md`（若仓内无 `docs/journal/` 则新建）。
- 闸门：`npm test` 全量、typecheck、build。
- git commit/push 若被沙箱拦截，保留工作区改动交 Opus。
