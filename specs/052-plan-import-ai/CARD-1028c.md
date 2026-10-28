# 052 诊断卡 1028c · 34 份样表复跑暴露的失败类（/diagnose，止于假设）

先读仓根 `CONTEXT.md`、本目录 `SPEC.md`、`CARD-1028.md`、`docs/journal/2026-10-28-052-grounding.md`。

## 背景

`6b22583`（服务端落地校正）之后，Opus 用本机后端 + 真 DeepSeek 把 David 电脑上 34 份训练表全部跑了一遍。原始输出（**含真实学员数据，不得进仓、不得进测试夹具、不得出现在 commit / 日志里**）：

- 每份一个 `~/Projects/scratch/sheet-import-walk-20261028/local/batch/NN.json`（`outline` + `weeks` 响应），编号与 `local/samples.list` 行号一致，源文件路径在该 list 里。
- 离线重放办法见 `local/replay.ts`（用 `groundWeek(validateExercises(...))` 处理已存的模型输出，不调模型）与 `local/cells.cjs`（从 xlsx 取 cells；在 `meetpr-plan-web-wt-015` 目录下用 `node` 运行以借用其 `node_modules/xlsx`）。

## 失败类（每类各自走六阶段）

- **F1 模板表整份 `REGION_SUSPECT`**：#30 Juggernaut 模板（Blocker 1）、#31 JTS 自定义工具（线性模型，21 周全挂）、#32 531 初学者（6 周全挂）。教练拿不到任何内容。
- **F2 `OTHER` 偏多**：#07 王钲涵 12 条、#08 王馨伟 10 条、#16 塑形训练计划(1) 19 条（全表只剩 1 个动作）、#27 RTS 16 周 9 条。怀疑吞行 / 追加组检测在 Monster 版式的「顶组 + 退让组」或其他写法上误报。
- **F3 `MISSING_SETS` 偏多**：#34 旅程（SBS）24 条、#14 叶老师 11 条。怀疑非热身的正常动作被当成 0 组。
- **F4** #19 `sumo-cycle1.xlsx`（「9天计划」页）唯一一周 `BAD_OUTPUT`；#33 力量训练计划追踪表 outline 直接 `IMPORT_HEADERS_TOO_LARGE`（查清这个错误码的触发条件与前端提示）。

不在本卡：一周一页 / 一天一页的多页表（RTS 追踪表、塑形计划）——这是产品范围题，等 David 拍板。

## 六阶段（每类都要，按序，不得跳）

1. **先造会红的命令**：对每类挑 1 份样表，用离线重放（不调模型）写出一条「对这个 bug 会红」的命令：断言你从原表人工核对出的正确结果（例如某周应有 N 个训练日、某动作不应进 unreadable、不应 REGION_SUSPECT）。命令与红输出记进 JOURNAL。没有红命令不准提假设。
2. **列 3–5 个可证伪假设**，每个写清「若成立，改 X 后哪条命令转绿 / 哪种输出会变」。
3. 每类至少用一个假设做**只读**验证（加带唯一前缀 `[1028c-dbg]` 的临时日志或在重放脚本里打印，结束前删掉），一次只改一个变量；记录哪个被证伪。
4. **到此停下**：不修生产代码。把每类的红命令、假设、已证伪项、你最看好的根因写进 `docs/journal/2026-10-28-052-batch-diagnose.md`，交回 Opus，由 David 看过假设后另派修复。

## 约束

- 重放脚本与任何含真实数据的中间文件只放在 `~/Projects/scratch/sheet-import-walk-20261028/local/` 下，不进仓。
- 不调用真模型；不启停 3000 端口的服务；不 commit / push / merge。
