# 2026-11-13 · web 038 教练重量偏差部署

## 范围与授权

- David 在本卡明确要求「合并部署」。仅国内 SAE 同源网页换装；不改后端运行代码、数据库、env、海外部署或 iOS。
- 来源：[web PR #165](https://github.com/tianpingdeng112233-cell/meetpr-plan-web/pull/165)，已合并至 main `1d2e980c2b9a8163543e9c01c5791dbb59758a23`。产品与验收正典：[SPEC-038 修订](https://github.com/tianpingdeng112233-cell/meetpr-plan-web/blob/1d2e980c2b9a8163543e9c01c5791dbb59758a23/docs/SPEC-038.md)。源码 122 文件 / 1538 测试通过；Standards 与 Spec 独立审查 CLEAN，完整证据在来源仓同卡 JOURNAL。
- 后端基线 `2ea533e1235ef58c142d1412eb20e617c71e9e78`。与上次实际部署 `0a8f1dcfd56be6e1567a78f086a5df5c4b824eb1` 相比仅部署文档变化，无运行代码或迁移差异。沿用 0085/0086 已应用状态；0084 关闭的既有功能不启用。无需 SQL。
- 回滚候选为上一已部署镜像 `sha-0a8f1dcfd56be6e1567a78f086a5df5c4b824eb1`，经既有 deploy-staging 流程恢复即可；本次无数据变更。

## 产物

从上述已合并 web SHA 构建，`VITE_API_BASE=''`；保留 TestFlight `https://testflight.apple.com/join/aKmSgx4b` 与 Android `https://dl.meetpr.cn/android/meetpr-cn.apk`。核实 bundle 同源标记和安装链接，原样同步 dist 至 web。

- build ID：`1794541359771`。
- `index.html` SHA256：`80aac94a4a272aaf794e2dca33af02273680789fb1b087df904f1a6ff012a768`。
- `index-D3fzt_5D.js` SHA256：`a45024c70afa0d49cd7fbd24afadabeacd56fd538b680f20092550e48337fe6d`。
- `index-D0uehDhX.css` SHA256：`3cad18a2afd6969ad7466074d6ff565fbad0e6bdec5f17731e3b29b694963d6a`。

## 验证

- 实际生产 bundle + 隔离 API fixture 在 Chrome 验收：100→97.5/102.5 红，100 正常；100–110 区间 99.5 红、100/110 正常；缺首组时 45 对应第二组正常、47.5 对应第三组 50 红。总览只有重量摘要红，展开定位具体组。零 pageerror，未写真实数据或发送消息。
- 本机 Node 25 基线两次分别发生单项 HTTP parse / ECONNRESET；单项 video-markers 复跑通过。安装 Node 22 遇本机 ENOSPC，清理本任务用完的 node_modules 后恢复。期间串行复跑也遭 ENOSPC，未将该轮计为通过。恢复后 Node 22 基线 189 文件 / 2163 通过 / 6 跳过；后续以换装后全量验证与 CI 为准。未修改测试或断言。
- 换装后 typecheck/lint/format:check 已通过。默认并发复跑有单项 HTTP parse，明确 Node 22 的另一轮有两项 5 秒超时；本机收敛为 2 workers，保留原测试与超时，CI 仍运行默认配置。不将偶发测试环境问题宣称为已修复。
- 发布状态：待本卡后续追加 CI、镜像、实际部署和线上资源校验证据。
- 换装后 Node 22 / 2 workers 全量：189 文件，2163 通过、6 跳过；typecheck/lint/format:check/build 全通过。未调大测试超时、未跳过额外用例。
