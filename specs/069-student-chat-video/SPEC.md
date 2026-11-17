# 学员独立聊天视频（App 113 / backend 069）

- 状态：InReview。2026-11-17 David 批准 HTML 后明确「安卓和 iOS 一起实装」。T2 / P1；本地后端验收通过；三仓已合并，0089经David执行并复核，国内后端5ac8da8已部署（run44091508530）。真实跨端OSS验收已授权，等待测试登录会话。备份成功记录尚未提供，见JOURNAL。
- 先读本仓 CONTEXT、AGENTS、CLAUDE；旧角色分工以 David 全局规约为准。
- 视觉正典：本目录 `approved-prototype.html`（本机交互示意，不把示例人物/聊天/占位视频写进真实产品）。保留两端原导航与现有入口。

## 已批准行为

学员教练 tab 聊天框旁「＋」新增「视频」；系统相册单选 → 可播放的预览（返回重选 / 取消 / 发送给当前教练）→ 独立聊天视频气泡。iOS 用现有 Menu；Android 底部附件选择面板，保留分享训练组视频。无需训练组或计划。教练聊天收到后可以播放；教练端本轮不新增发送入口。

上传中有真实进度，文字聊天仍能用；上传成功且消息已确认才显示已送达。失败显重试，使用同一 client_id 防重复。页面离开重进不丢正在发送/失败项（当前登录 session）；登出/换账号或换绑按原聊天生命周期取消并清理。预览取消不得发送。短期签名过期可续签；重新打开聊天可看到服务器历史视频。

## 跨仓 wire 契约（工程决定）

- 复用 `/uploads/initiate`、分片 PUT、`/uploads/:id/complete`。新增附件 kind `chat_video`，MP4 / QuickTime，最大 200 MiB，沿用现有上传限制；不关联 set_log_id，不出现在训练视频墙/组记录。客户端校验实际文件大小与有效视频，失败给可理解文案；已有编码工具可复用，不引依赖。
- `POST /conversations/:id/messages`：`{kind:"text",body:"[视频]",video_id:<attachment UUID>,client_id:<stable ID>}`。与 set_ref / exercise_ref 互斥；仅该会话学员发送；附件必须 owned / ready / chat_video。保留已有 set_ref + set_video 路径。
- 响应仍 `kind:"text"`（旧包枚举不变）、body 为可显示 fallback；仅独立视频新增 `video_id`（其它消息保持省略，客户端可空解码），继续现有 `video_url`, `video_expires_in`, `poster_url`, `duration_seconds`。新客户端 `video_id != null && set_ref == null && exercise_ref == null` 识别独立视频，即使签名暂不可用仍保留卡片。旧包显示 `[视频]`，不会解码整页失败。不能新增无协商的 kind=video。
- 播放续签沿用会话消息重取（before_seq=seq+1,limit=1，核对 id/seq），不授予对端通用附件 URL 访问；成员访问与绑定规则沿用聊天图片。非成员不能读。幂等先查后校验附件；取消/失败清理 orphan，被消息引用的附件不可误删。
- 不强加视频时长上限；duration_seconds 可空（现有后端无法稳定读时长）。有本地时长/封面时显示；远程无 poster 时有可播放占位，不伪造数字。
- 上传状态只在 session 内恢复；本轮不承诺杀进程重启后续传。服务端历史是持久事实。

## 验收清单

- [ ] 两端学员「＋ → 视频 → 相册单选 → 预览 → 发送」，取消不发送，重选正常，原入口与导航保留。
- [ ] 真实本地视频可预览；有效 MP4/MOV 上传并由教练收到、可播放；重新拉取仍在。
- [ ] 上传百分比真实，不提前显示送达；失败可重试，同 client_id 不重复；发送期间能发文字、离开重进仍在。
- [ ] 登出/换账号/换绑不泄漏本地文件和旧视频；取消/失败清理不删已引用附件。
- [ ] iOS / RN 学员及教练侧卡片可播放，过期签名续签，null poster / unavailable URL 有合理态。
- [ ] 旧文字、图片、训练组视频、动作留言、已读/未读、分页/实时消息保持；旧客户端 decoder 可读新消息。
- [x] backend：非成员/错误附件 owner/kind/status/无绑定拒绝；上传大小/MIME gate；幂等竞态；删除保护；训练视频列表不混入。证据见本卡 JOURNAL。
- [ ] 三语文案完整；双端浅深两色视觉证据。iOS 仅 iPhone 17e，Android 用既有 meetpr AVD。Demo/fixture 不替代真实后端持久化验收，未验项如实记。

## 测试 seam

- backend：现有 supertest `POST /uploads/*` 与 `POST/GET /conversations/:id/messages`，pg-mem fixture；迁移约束独立验证。逐行为 red → green。
- iOS：ChatSendCoordinator/ConversationViewModel 公开 send/retry/lifecycle seam；NetworkChatRepository 请求与分片网络边界；DTO 新旧兼容、签名续签。UI 以模拟器实看为证。
- Android：公开聊天发送/outbox service、chat API schema/request、StudentConversationScreen 交互与 coach receiving；网络/文件/系统媒体边界 mock。UI 以模拟器实看为证。
- 这些是沿用已存在公开接口的工程测试边界，不新增测试框架。

## 卡与边界

A backend（独立仓）：附件/消息兼容扩展、授权/幂等/清理/回读/迁移及测试。
B iOS（独立仓）：相册与预览、上传 outbox、消息/教练展示、签名、三语与测试。
C Android（独立仓）：与 B 同行为，原生 Android 选择器与返回行为，PARITY/测试。
每树一写者，主代理负责最终双轴独立审查、commit/push/PR；T2 不自合。没有 David 具体迁移部署批准，不应用真实迁移、不发布 App。

## Out of Scope

相机录视频、批量选择、剪辑/美化、视频批注、教练发送视频入口、训练组记录变化、网页改版、杀进程续传、新依赖、改账号/包名/版本号、真实账号数据改写。
