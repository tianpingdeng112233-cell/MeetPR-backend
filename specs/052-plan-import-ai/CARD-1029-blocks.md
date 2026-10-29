# 052 卡 1029 · outline 返回全部 block（§2.5，David 10/28 11 / 11a A / 11b A，屏幕稿 ㉓ 10/29 定稿）

先读仓根 `CONTEXT.md`（Block）、`SPEC.md` §2.2、§2.5、§2.6，`docs/journal/2026-10-28-052-batch-diagnose.md` 的 F4。

## 目标

1. outline 响应新增 `blocks: [{ id, label, sheets: [name...], weeks: [...], header_region_by_sheet: {name: region|null} }]` 与 `skipped_sheets: [name...]`；每个 week 的 `region` 增加 `sheet`。规则：一页一个 block；结构相同、按周（「第N周」「Week N」）或按天（「D1」「Day 1」「第1天」）拆分的多页合成一个 block，`weeks` 跨页按顺序编号；说明 / 计算器 / RPE 表 / 动作库 / 记录页进 `skipped_sheets`。合页判断以服务端规则为准（页名模式 + 表头结构相似），模型只负责每页里的周。
2. **兼容**：顶层 `sheet` / `weeks` / `header_region` 保留，取默认 block（日期最新者；无日期取最后一个）；旧网页照旧工作。
3. 第二步 `weeks` 接受每周 cells 来自不同页；`header_cells` 允许按页给（`header_cells_by_sheet`），旧字段仍可用。
4. **F4**：输入预算按 block 计（见 §2.5），1.1MB 多页追踪表不再 `IMPORT_HEADERS_TOO_LARGE`；整体 400k 字符上限不变。
5. 每日次数：outline 成功扣一次；同一 `import_id` 下教练换 block 不另扣。
6. 已有服务端校正（日头落地、吞行检测、拆行、重试）对每个 block 照常生效。

## 约束

合成夹具（多页：一页一周的 12 页、一页一天的 4 页、两个独立 Block 页 + 说明页）；不调真模型；不改迁移；日志不含单元格文本；不启停 3000 端口服务。

## 测试 seam（先红后绿）

`tests/plan-imports.test.ts` 路由层 + 假模型：两个 Block 页 → 2 个 block、`skipped_sheets` 含说明页、顶层字段 = 默认 block；12 页逐周 → 1 个 block、12 周、region.sheet 各不同；4 页逐天 → 1 个 block；第二步跨页 cells 正常；大表头多页不再 413/TOO_LARGE；换 block 不扣次数。

## 验收

typecheck / lint / format:check / build 全绿 + 两个 plan-import 测试文件计数；红→绿；JOURNAL `docs/journal/2026-10-29-052-blocks.md`。不 commit / push / merge。Opus 收货后真 DeepSeek 复跑 RTS ×4、share_file ×2、力量训练计划追踪表。
