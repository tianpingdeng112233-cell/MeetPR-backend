# Web 030-C 跨周期填充部署

## 授权与来源

David 于 2026-11-16 明确要求「合并部署」。plan-web [#180](https://github.com/tianpingdeng112233-cell/meetpr-plan-web/pull/180) 已合并，来源 `82d6d73e0589b86d9fdb44a960225a40ebd8dbc8`，与已独立审查的 `48e92de` 生产源码相同。行为、1627 项测试及两种排版浏览器证据见来源仓 `docs/journal/2026-11-16-030-C.md`。

## 换装基线

backend 最新 staging `03e2eef8cc446c9d0202207c873358ddedb4f658`；线上最近成功镜像 `2725df2892281bb25ff8ae6a352ccf46852069da`（部署 run 43815510870）。两者 `src/`、迁移、依赖和旧 `web/` 无差异；保留已上线 spec 067 计划交接逻辑，不从旧 030-B 分支回退。

本次仅替换生成的 `web/` 静态资源，无后端代码、迁移、env 修改。沿用 0087 已应用记录。本次不执行数据库操作；回滚可重部署上一镜像 `2725df2892281bb25ff8ae6a352ccf46852069da`。

## 发布产物

构建配置：`VITE_API_BASE=''`；TestFlight `https://testflight.apple.com/join/aKmSgx4b`；Android `https://dl.meetpr.cn/android/meetpr-cn.apk`。同源标记与两安装链接均已验证。

- JS：`assets/index-Dvc_Vh0T.js`
- JS SHA-256：`c6890c09067b651eea5493b9bed5124cbe5c264a22c2f68d36d21b490b28e39c`
- 来自上述合并 SHA 的生产构建，`dist/` 原样换装。

## 验证记录

- 当前 backend 基线远端 [build 43849533310](https://github.com/tianpingdeng112233-cell/MeetPR-backend/actions/runs/43849533310) verify 与 image push 成功，含全量 test、typecheck、lint、format、build。
- 本机基线三次测试均 193/194 文件通过，2210 passed / 1 failed / 6 skipped：Node 25 两 workers 的 coach-reviews 状态 404/409；Node 22 两 workers 的 exercise-stats 状态 404/200；Node 22 单 worker 的 coach-reviews HTTP parse error。失败用例不同，未改断言、未跳过用例或声称本机全量绿。原日志保留本 chat work/。部署以本换装的远端 CI、ACR verify 和上线哈希核对为最终证据。
- 后续 CI、部署与独立 curl 结果待追加。
