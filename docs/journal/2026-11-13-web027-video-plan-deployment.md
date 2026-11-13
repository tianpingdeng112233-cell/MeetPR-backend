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
- 发布状态：2026-11-13 已上线国内 SAE，实际证据如下。

## 合并与线上证据

- 后端 [PR #404](https://github.com/tianpingdeng112233-cell/MeetPR-backend/pull/404) 已合并，部署镜像 SHA `fe93336d0029c41f7cac8838faa9f5b095f7d133`。合并期间包含上一卡纯部署文档 #403，后端运行代码与迁移相对上一部署仍无差异。
- [PR CI 43364671380](https://github.com/tianpingdeng112233-cell/MeetPR-backend/actions/runs/43364671380)、[合并后 CI 43365016750](https://github.com/tianpingdeng112233-cell/MeetPR-backend/actions/runs/43365016750)、[镜像构建 43365016727](https://github.com/tianpingdeng112233-cell/MeetPR-backend/actions/runs/43365016727) 全绿。
- [部署 43365552034](https://github.com/tianpingdeng112233-cell/MeetPR-backend/actions/runs/43365552034) 成功，明确传入上述 image_sha 与 migrations_applied=true（无新迁移）。SAE 变更成功，health/login/同源入口 smoke 通过。
- 本地候选全量：189 文件、2163 通过、6 既有跳过；typecheck/lint/format:check/build 全通过，未修改测试阈值。
- 独立核验时间 2026-11-13T04:28:07.750Z：/health 200；线上 HTML/JS/CSS 与本卡产物 SHA256 全匹配，Build ID `1794543197927`。
- 线上真实资源 + 隔离 HTTP fixture 的浏览器复验：首日、末日、按天排均间距 12px，鼠标横拖100px后悬停不拉回，关闭清除选中和额外空间；零 pageerror。API 包括写请求均被测试上下文拦截，未登录真实账号、未改真实计划、未发消息。截图：[首日](../evidence/web027-video-plan/live-first.png)、[按天排](../evidence/web027-video-plan/live-by-day.png)。此验收不覆盖真实视频传输/解码。
