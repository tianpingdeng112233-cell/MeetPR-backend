# W3 Global 候选上线方案（尚未授权执行）

## 已核实的现场

[只读 run 35857998786](https://github.com/tianpingdeng112233-cell/MeetPR-backend/actions/runs/35857998786) 在 2026-09-23 12:02 UTC 成功，deploy job 明确 skipped；[脱敏结果](evidence/w3-global-preflight-20260923/facts.json)。活动部署 `4ae3a7d1-a025-486d-9927-8ab62eb223d2` 的 api 使用 `sha-7ce724538b385104efdea9e549ddad65657a7dc9`；已核对 api DATABASE_URL 绑定 `globalpg` / `meetpr-global-pg`。PG 17.11，账本到 0068，没有 plan_shift_batches / plan_day_shifts.seq，coach gate 未配置。最新托管备份 2026-09-23 10:02:08 UTC；备份恢复尚未验证，活动 spec 未暴露镜像 digest。

## 候选与具体范围

业务候选为 [PR #280](https://github.com/tianpingdeng112233-cell/MeetPR-backend/pull/280) `1b9c6f5b0fc79d9a148995d2e2b2e86ae7e9711c`，基于 staging `3db7a1d`；操作准备 [PR #281](https://github.com/tianpingdeng112233-cell/MeetPR-backend/pull/281) 增加只读预检和默认关闭的明确部署开关。T2 均等 David 合并。

相对当前线上，候选含已在 CN staging 验证的 spec045 教练改期、日历/训练结算兼容读、Google audience 配置兼容、推送 payload 与 web101/53，以及本次 P-31。它不是只有九行 preview 修改的生产发布，审核须覆盖这一完整差异。

现场账本与候选迁移文件逐项比较：唯一未应用文件是 **0070-plan-shift-batches.sql**。0069 在另一个未合入分支，当前固定候选不含它；不得换成浮动 staging 后盲跑。0070 增加 seq、批次表并回填历史学员批次，没有删除旧列。迁移测试/PG17 演练见 [既有记录](verification-0070-pg17-2026-09-14.md)。

## 经批准后的执行顺序及停止条件

1. 固定合并后候选 SHA/镜像 digest；与已审树核对。确认 build-push-global 对该 SHA 全绿、镜像可读。再次只读预检，若运行服务、绑定、账本或 pending 集合变化，停止并更新方案。
2. 验证最近的持久托管备份与恢复路径；迁移前取得一致快照并在隔离 PG17 恢复检查。凭证与用户数据只在获准的备份环境，不写日志/PR/本机 scratch；未完成恢复验证，不迁移。此步骤及生产迁移需要 David 批准具体执行环境。
3. 仅对经核实固定 ref 执行 0070，与 `meetpr_migrations(name)` 记账同事务。当前候选的既有 migrate-global 工作流可用于这一固定 pending 集合，但必须先断言集合恰为0070；出现其他未应用文件则停止。核对旧批次回填数量、seq 非空、日志/计划数量未丢失，保留旧列。
4. 使用明确 SHA 部署，`coach_plan_shift_enabled=false`。等待所有旧实例退出；确认 health、现有 iOS/Android 登录、原计划第一屏、历史日志/视频/反馈、学员原改期读路径及 P-31 新旧客户端兼容。失败则保持 gate 关闭，不清库/回滚迁移。
5. 再明确开启 `coach_plan_shift_enabled=true`；仅专用 QA 对在未完成 D7 上执行预览→改期→师生 GET→undo，核对同批次、已完成 D2/D4/D6 和既有日志不变。同时验证收件箱图片/训练分享新 metadata 与同名普通文字；完成后收生产台账。

## 回退

开启教练写入前可关闭 gate 并保留 expand schema；开启后始终保留兼容 coach 批次的读取版本。不要将旧 `7ce7245` 镜像直接回滚到已有教练批次的数据上。故障时先关 gate，保留日志和批次，再按兼容读版本修复；不用删表、删批次、ID remap 或未经批准的备份覆盖。

本方案只准备执行边界，没有授权合并、创建收费恢复资源、迁移、部署或开关启用。
