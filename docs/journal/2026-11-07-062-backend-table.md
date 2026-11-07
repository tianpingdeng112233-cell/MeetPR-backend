# 062-backend-table 实装记录

## 目标与范围

- 按 `/Users/david/Projects/apps/MeetPR-backend-wt-062-spec/specs/062-e1rm-extended-rpe-table/SPEC.md` 的后端范围实现；该文件状态为 Ready，本次明确派卡授权执行，不改 spec 状态。
- 工作分支 `feat/062-e1rm-extended-rpe-table`，起点 `c349672`，开工工作区干净；沿用既有分支，不 commit、不 push。
- 仅替换 `src/domain/e1rm.ts` 的 1–10 次表格及来源注释，其余生产逻辑不动。无迁移、部署或端上改动。

## 改了什么

- `src/domain/e1rm.ts`：90 格按 spec 原样替换，注明扩展版 RPE 表（JTS / Programming To Win）。
- `tests/unit/e1rm.test.ts`：在 `calculateEligibleE1RM` seam 覆盖 B1 数值与插值、B2 回退及拒绝条件、B3 全部 90 格。期望表独立抄自 spec，通过严格相等比较每格对应的计算结果，未导出或读取私有常量。
- `tests/exercise-stats.test.ts`：仅更新现有 HTTP 测试受影响的预期值。原先最佳组 90 kg × 5 @6.5 被同日 95 kg × 5 @8 超过，因此最佳值改为 117.14，同时 `computed_at` 从 10:05 改为 10:00；fixture 不变。
- `tests/unit/exercise-stats-aggregates.test.ts`：仅更新两处受表影响的期望值；保留现有 28 天窗口及 3% up/down/flat 趋势测试。

## 测试先红后绿的证据

1. 基线 `pnpm typecheck`、`pnpm lint` 通过。基线 `pnpm test`：141 文件通过、41 文件失败；1460 项通过、520 项失败、1 项跳过。失败原因均为沙箱不允许监听端口：5 项直接 `listen EPERM`，515 项因 server 地址为空报读取 `port` 失败，伴随 515 条未处理监听错误。
2. 生产代码仍为旧表时，先更新计算器测试，运行 `pnpm test tests/unit/e1rm.test.ts`：89 失败、25 通过，确认新表断言能识别旧表。日志：`/tmp/062-backend-table-red.log`。
3. 更新现有 handler/聚合预期，旧表下聚合测试 1 失败、9 通过（290.70 与 284.74 的差异）。日志：`/tmp/062-backend-table-aggregate-red.log`。
4. 替换生产表后，计算器 114 项通过；聚合测试暴露另一处旧值 119.05，按 100 ÷ 0.863 更新为 115.87。最终 `pnpm test tests/unit/e1rm.test.ts tests/unit/exercise-stats-aggregates.test.ts`：2 文件、124 项全部通过。日志：`/tmp/062-backend-table-green.log`。
5. 最终全量 `pnpm test`：141 文件通过、41 文件失败；1550 项通过、520 项失败、1 项跳过，伴随 515 条未处理监听错误。与基线为相同的环境失败，新增 90 项全部通过。日志：`/tmp/062-backend-table-final-tests.log`；基线日志：`/tmp/062-backend-table-baseline.log`。
6. 最终 `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build` 通过；`git diff --check` 通过。

## 审查与遗留问题

- code-review 双轴独立只读审查：Standards 0 项，Spec 0 项；均未发现代码返修项。审查基点为 `c349672`，对象为未提交 diff。
- B4 HTTP 运行验证及全量测试全绿仍被当前沙箱的端口监听权限阻塞，需要在允许监听本机端口的环境重跑 `pnpm test`；不能据此宣布验收通过。
- `pnpm install` 因网络 EPERM 失败，离线安装也缺缓存。已从本机 `MeetPR-backend-wt-060/node_modules` 复制依赖到当前树；`cmp` 确认两树 `pnpm-lock.yaml` 完全相同，未修改锁文件。`pnpm prepare` 的 husky 配置写入被共享 git 目录只读权限拒绝；既有 `core.hooksPath` 为 `.husky/_`，未绕过 hook 或自设 lint/format 规则。
- 仓内缺少 `docs/agents/issue-tracker.md`，已提示后续可运行 `/setup-matt-pocock-skills`；本卡通过明确的绝对 spec 路径审查，无需 tracker。
- 未修改 RELEASES、NEXT-RELEASE 或 spec；部署、收货验收由后续既定流程负责。
