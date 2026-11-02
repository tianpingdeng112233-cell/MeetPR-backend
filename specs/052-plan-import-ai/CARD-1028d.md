# 052 修复卡 1028d · 34 份样表失败类修复（David 10/28「同意」）

先读仓根 `CONTEXT.md`、本目录 `SPEC.md`、`CARD-1028.md`、`CARD-1028c.md` 与诊断记录 `docs/journal/2026-10-28-052-batch-diagnose.md`（根因与红命令都在里面）。

## 修复（每条先把诊断里的红命令改写成仓内**合成**回归测试，先红后绿）

1. **F1 模板表整份 REGION_SUSPECT**：日头落地只在「表头能给出清楚、一致的星期/日期」时才校正。表头日期跨自然周、同一周块里重复出现日头行等**说不清**的情况，退回保留模型给的 weekday / start_date，不判 `REGION_SUSPECT`；只有「表头清楚且与模型输出明确矛盾、又无法按日块重组」才判。
2. **F2a 区间次数**：`reps` 接受区间（如 `8-10`、`8~10`），与网页编辑器的 `target_reps` / `target_reps_max` 对应（读网页 `src/features/plan-editor/` 的区间写法，只读）；不再因区间把动作丢进 unreadable。
3. **F2b 备注格误当动作名**：吞行检测的「名字格」候选排除备注类格子——位于该周表头标为「备注 / 说明 / Notes / 反馈」列的格子，以及同一行里位于组次/重量/强度格右侧的文字格。
4. **F3 说明文字被当成动作**：`sets === 0` 且该动作 `source_cells` 里没有任何数字、也没有 `unparsed` 的，静默丢弃（不进 exercises，也不进 unreadable）；提示词补一句「选择辅助动作」「自选」这类说明不是动作。保留 1028 的热身规则。
5. **F5 9 天循环**（#19 sumo「9天计划」：Day1–Day9 共 6 个练习日，周内 BAD_OUTPUT）：outline 对「Day1–DayN 且 N > 7」的循环，按每 7 天切成多周返回（Day1–7 为第 1 周、Day8–14 为第 2 周…），每周 `weekday = null`、带 `day_index`，交给网页现有的「选星期」流程；写进 JOURNAL 你选的切法与理由。
6. **清理**：移除 `src/routes/plan-imports.ts` 与 `src/services/plan-import/parse-weeks.ts` 里全部 `[1028c-dbg]` 探针行，`git diff` 中不得残留。

不在本卡：F4（多页表头超预算）并入多 block 改造（spec 052 §2.5），另卡。

## 约束

- 合成夹具，禁止真实学员名字 / 数字入仓；不调用真模型；不启停 3000 端口服务。
- 不改响应形状（只改值、在 exercises / unreadable 间移动、F5 多返回几周）。

## 验收

- 每条红→绿（命令、退出码、计数）；`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build` 全绿；两个 plan-import 测试文件计数。
- 用诊断阶段的离线重放（私有临时目录，读 `~/Projects/scratch/sheet-import-walk-20261028/local/raw/raw.jsonl`，跑完删除）确认 F1–F3 的原样本转绿，结果只记结论不记数据。
- JOURNAL：`docs/journal/2026-10-28-052-batch-fixes.md`。不 commit / push / merge。
- Opus 收货后用真 DeepSeek 重跑全部 34 份对照。
