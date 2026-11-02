# 056 卡 A · 后端：自选重量 / 自重负荷类型 + 回填 + 最低版本接口

先读仓根 `CONTEXT.md`（自选重量、自重两词）、`specs/056-load-types/SPEC.md` 全文、本仓 `CLAUDE.md`（硬规则 8：不能破坏已上线客户端）、`specs/034-*`（强度/负荷模式现有规则）、`db/MIGRATIONS-APPLIED.md`。

## 目标（spec §2）

1. `LOAD_MODES` 新增 `free_weight`、`bodyweight`；`src/routes/plans/intensity.ts` 校验：二者不要求负荷字段，可选带一个强度字段（rpe / rir / pct，沿用 034 规则；`rpe_range`、`weight_range` 字段不得出现），`target_weight` 必须为空。
2. **迁移 0080**（开工 `git fetch` 核实未被占用；0076 已被 052 分支预留，不要用）：放宽 `plan_sets` 的 `intensity_mode` 非空与 `plan_sets_target_value_check`，使 `load_mode IN ('free_weight','bodyweight')` 的行可不带 `intensity_mode` / `target_value`；新增回滚表保存被回填组的 `id`、原 `coach_note`、原 `load_mode`；**回填**：`load_mode IS NULL` 且 `coach_note` 命中自重标记（与 plan-web `src/i18n/stable-zh.ts` 的 `patterns.bodyweight` 同一正则：`/自重|bodyweight/i`）的组 → `load_mode='bodyweight'`，从备注去掉标记字样（只剩标记时置 null）；原 `intensity_mode` / `target_value` 保留不动。`src/db/types.ts` 手动同步；`db/MIGRATIONS-APPLIED.md` 记账（staging 未应用）。
3. **旧形状投影**（serialization）：`bodyweight` 组在响应里 `intensity_mode='rpe'`、`target_value='10.00'`、`coach_note` 带「自重」标记（与库里是否已存无关），逐字段与今天的自重组一致；`load_mode` 字段如实给 `bodyweight`。`free_weight` 本期由前端门控不会被创建，但若出现，响应同样不得给旧字段 null——按 `bodyweight` 同样方式投影（`rpe`/`10`）并在 JOURNAL 写明这是过渡占位。
4. **旧写入归一**：写入（含批量保存 `POST /plans/:id/days/batch` 与逐组接口）收到「`load_mode` 空 + `intensity_mode='rpe'` + `target_value=10` + 备注命中标记」→ 存为 `load_mode='bodyweight'` 并去掉备注标记。
5. **`GET /app/min-version?platform=ios|android`** → `{ min_build: number }`，无鉴权，`Cache-Control: max-age=300`；值来自 zod 校验的 env `MIN_IOS_BUILD` / `MIN_ANDROID_VERSION_CODE`（非负整数，默认 0）；`.env.example` 加占位。非法 platform → 400 `{ error: 'INVALID_PLATFORM' }`。

## 约束

- 硬规则 8：除新增 `load_mode` 取值外，现有响应形状逐字段不变；旧客户端（iOS 1.0(28)、安卓现版、网页现版）读写自重行行为不变。
- 迁移只放宽约束 + 回填，可回滚（写一段回滚 SQL 注释在迁移文件尾，用回滚表恢复）。
- 不碰 plan-import（052）相关文件。

## 测试 seam（先红后绿）

1. plans 路由 supertest：两种新 load_mode 的写入 / 校验错误 / 回读；`bodyweight` 响应旧字段快照与今天自重组逐字段相等。
2. 旧写入归一：用今天网页的自重请求形状写入 → 库里 `load_mode='bodyweight'`、备注无标记，回读响应与写入前形状一致。
3. 迁移测试（`tests/migrations/` 现有模式）：造存量自重组（纯标记备注、标记+其他文字、非自重组）→ 跑 0080 → 断言回填与回滚表；跑回滚 SQL → 恢复原状。
4. `/app/min-version`：未配置 → 0；配置 → 值；非法 platform → 400。

## 验收

- `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build` 全绿（贴计数）；红→绿表。
- JOURNAL：`docs/journal/2026-10-28-056-A.md`。
- 不 commit / push / merge；不应用到任何真实库；不启停 3000 端口服务。
