# 2026-11-13 · web 027 视频与计划联动部署

## 范围与授权

David 在本卡明确要求「合并部署」。仅国内 SAE 同源网页换装；无后端运行代码、数据库、env、海外或 App 变更。

来源 [web PR #166](https://github.com/tianpingdeng112233-cell/meetpr-plan-web/pull/166)，已合并 main `4f07f7a6320e93952d1d0bcc749aaa2f92a98539`。产品与验收正典：[批准 SPEC](https://github.com/tianpingdeng112233-cell/meetpr-plan-web/blob/4f07f7a6320e93952d1d0bcc749aaa2f92a98539/specs/027-video-plan-alignment/SPEC.md)。源仓完整 1544 项通过，末次窄屏微调后相关 25 项回归、TypeScript 通过；Standards / Spec 独立审查和真实浏览器证据见源仓同卡 JOURNAL。本仓只分发已验收产物，不另造产品 spec。

后端基线与当前部署镜像均为 `4d54e038773571a0ff50751e6ec85e3e7bde9976`（上一班 web #165），部署 run 43363239954 成功，当前线上入口与该版本一致。0085/0086 已应用；0084 保持既有关停状态。本次无新增迁移，无需 SQL。回滚可指定上述已存在镜像重新运行 deploy-staging，不回滚数据。

## 产物与验证

从已合并 web SHA 构建，VITE_API_BASE 为空，保留 TestFlight https://testflight.apple.com/join/aKmSgx4b 与 Android https://dl.meetpr.cn/android/meetpr-cn.apk。同源标记及安装链接逐项检查通过；原样同步 dist 到 web。

- Build ID：`1794543197927`。
- index.html SHA256：`2ff8c38d3f0d3c0c7b1006b155631dcc3dae11928200fbe465ad568cf5c22555`。
- assets/index-0A76wI8o.js SHA256：`cef663d10885a6ff5ebb4aa0e29a44924e6c22e194973090b42f8a78cb9c9bcf`。
- assets/index-NupKQPxc.css SHA256：`c43b281bfe5cad75a741d36bd26b217f034ce6cbc97b7b55e5da27e51bd77e73`。
- 后端 Node 22 基线：typecheck/lint 通过；189 文件，2163 测试通过、6 既有跳过（2 workers，未修改断言或超时）。后端源代码与上一部署完全一致。
- 正式 bundle + 隔离 HTTP fixture 浏览器：首日/末日/按天排 gap=12px；真实鼠标拖动 100px，队列悬停不回跳；关闭清除高亮与额外滚动空间；零 pageerror。未登录真实账号、未写真实计划或发送消息；媒体响应为夹具，不宣称验证真实视频传输/解码。
- 已完成本地产物替换，尚未部署；远端 CI、镜像、部署与线上哈希待记录。
