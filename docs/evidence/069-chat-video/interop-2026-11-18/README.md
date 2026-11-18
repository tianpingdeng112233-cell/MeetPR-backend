# 113 / 069 国内跨端验收 · 2026-11-18

结论：已批准功能通过「自动化边界回归 + 原生浅深色流程 + 国内真实账号双向收发」分层验收。David 要求验收后进下一班车，按 P1 纳入 iOS 1.0(42) 与 Android CN 下一包候选；当前公开版本仍为 iOS 41 / CN15。未切包、未发布 App，Global 未部署或验收。

## 版本与环境

- iOS #478：`c3c1b34ef705deeb25ffe2971fbb633d02de0528`；iPhone 17e / iOS 26.5。真实 Debug QA 编译二进制 SHA256 `180462259a42120d4fe626ce13b6758533c6099ccfdab709f62b7b78d8a7dd3f`。
- Android #207：`a6f848ce4f09eca7a73b609ce93bbfa939ab0e3e`；既有 meetpr AVD / emulator-5572。QA APK SHA256 `cec7f697a2f9bdd33b34a5aa31f20259bb3acc1b0c350d320907b01702abcca9`；Metro 8097，BUILD_TRACK=china、DEMO_MODE=0、国内 API。
- 两端 QA application ID 为 `com.meetpr.chatvideoliveqa`，仅隔离安装产物；正式包名、版本、签名和源码未改。测试不是 Demo 或 HTTP stub。David 手动登录已绑定的「测试」学员 / MonsterXTY 教练，并手动交换角色；没有复制或导出 token / 密码。
- backend #429 / `5ac8da8386958ec4a997cb86df1dc65483cd2973`：[国内部署成功](https://github.com/tianpingdeng112233-cell/MeetPR-backend/actions/runs/44091508530)。0089 的 DMS 7/7 与约束定义证据见本目录上级；不重跑迁移。备份成功记录尚未提供，不能声称验证过 RDS 备份。
- 11月18日台账基底 iOS `9c5084c6`、Android `627a5722`、backend `7cc4ad1`。feature 到这些头之间聊天实现未改变；iOS Networking 差异仅热身组 DTO/映射。此次验收没有产品源码返修。

## 真实双向结果

| 方向 / 场景           | 观察结果                                                                                              | 证据                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Android 学员选 MP4    | 系统单选、真实预览、取消无新消息；再次选片并发送                                                      | [预览](android-preview.png)                                                                                                       |
| Android 学员上传      | 出现 Uploading 0%，确认后 Delivered；上传期间发出的 QA113 文字到达同一对话                            | [上传中](android-sending.png)、[送达](android-delivered.png)                                                                      |
| Android → iOS 教练    | 实时收到独立视频；实际动画播放至 0:06 / 0:06                                                          | [收到](ios-received.jpg)、[完整播放](ios-playback.jpg)                                                                            |
| Android 学员回播      | 首次播放链接失败；稍后重试恢复并完整播放                                                              | [原始失败](android-playback.png)、[重试成功](android-playback-retry.png)                                                          |
| 第一方向冷启动        | 两端杀进程重开，历史消息仍在并播放至 0:06 / 0:06                                                      | [Android](android-cold-reopen-playback.png)、[Android 自动读取结果](android-cold-replay.txt)、[iOS](ios-cold-reopen-playback.jpg) |
| iOS 学员选 MOV / 发送 | 系统单选、7 秒竖屏实际预览；08:17 发送确认，卡片最终已送达 / 已读                                     | [预览](ios-mov-preview.jpg)、[发送录屏抽帧](ios-send-contact-sheet.jpg)                                                           |
| iOS → Android 教练    | iOS 发送后重启 Android 模拟器及 QA，登录保留；从服务器历史收到两条不同视频，播放新 MOV 至 0:07 / 0:07 | [历史两卡](android-reverse-history.png)、[完整播放](android-mov-playback.png)                                                     |
| iOS 学员回播 / 冷启动 | 本端播放至 0:07；杀进程重开、教练 tab 重取后仍两卡且显示已读，新卡完整播放                            | [本端回播](ios-mov-playback.jpg)、[冷启动回播](ios-mov-cold-playback.jpg)、[UI 读取](ios-mov-cold-playback.txt)                   |

源文件为本机合成彩条 + 音轨，不含真实训练视频：MP4 6 秒、960×540、1,632,354 字节，SHA256 `80cce77f69fd7d057a381b238fcc12b918211684fb43253833dc90d9f3694a4d`；MOV 7 秒、540×960、2,004,865 字节，SHA256 `7f596ba0295e1b3cd25bd4ee1acd387f05afa2b31b516df4967c9b7f475a9ee2`。接收端没有预先导入对端片源。视频实际动画末帧与播放进度均亲眼确认；音轨存在不等于真机音频验收。

## SPEC 清单逐项依据

以下区分 live、原生 Demo 与自动化，勾选表示该条按列出的层次通过，不表示所有边界都在真实业务库故障注入。

1. **入口 / 单选 / 预览 / 取消 / 重选 / 保留导航**：两端 11月17日原生浅深流程 + 11月18日真实发送，iOS JOURNAL `113-ios-evidence/01–09`、Android evidence README。实时网络中的 Android 取消另外验证无消息。
2. **MP4 / MOV 真实上传、接收、播放、历史**：上表四角色与冷启动，不能用 Demo 替代的真实持久化门禁已补齐。
3. **百分比 / 确认 / 失败重试同 ID / 文字 / 离开重进**：真实 Android 上传态及同时文字；iOS `ChatVideoSendTests`、`ChatSendCoordinatorCleanupTests`、`ChatStandaloneVideoTests`；Android `chat-video-outbox.test.ts`、`chat-video-upload.test.ts`、学生聊天交互测试覆盖 progress=100% 仍待消息确认、历史确认、同 ID 重试及 session outbox。未注入真实断网或人为限速。
4. **账号 / 绑定生命周期 / 清理**：两端手动登出及交换登录无残留上传项；iOS coordinator cleanup、Android picker/copy/transfer race 测试覆盖晚回调、换绑与本地副本；backend `tests/chat-video.test.ts` 验证引用删除保护及发送/删除竞态。没有对真实师生做解绑或删除实验。
5. **四角色卡片 / URL 续签 / 空 metadata**：四角色 live 播放通过；iOS `ConversationVideoRenewalTests`、Android 教练接收测试精确匹配 id/seq；Demo 空 poster 可播占位，自动化验证不可用 URL/过期刷新。未等待真实签名 TTL 自然过期；首次 Android URL 错误见下文。
6. **旧消息 / 旧解码 / 实时 / 分页**：真实旧文字、计划通知与新文字仍显示，实时接收和已读观察通过；iOS ChatUI/Networking 与 Android 聊天全量回归覆盖文字/图片/训练组分享/动作留言/分页；backend 旧 set_ref 响应 shape、旧 kind=text fallback 兼容测试通过。未安装旧公开包读取本次新消息。
7. **后端授权 / MIME / 大小 / 幂等 / 清理 / 列表隔离**：backend 196 文件、2217 passed / 6 skipped；`tests/chat-video.test.ts` 的非成员、owner/kind/status、解绑/角色、大小/MIME、幂等重发/续签、删除竞态、训练视频不混入。隔离 PostgreSQL17 验证迁移及旧行不变，DMS 最终三约束 validated=t。
8. **三语 / 浅深原生 / 设备限制**：三语 catalog/文案测试通过；双端浅深原生截图已留；仅 iPhone17e 与既有 meetpr/5572。真机大字、声音、覆盖安装首屏属于最终发包验证，未冒充已完成。

自动化基线：iOS Networking159 / ChatUI100 / StudentKit1327；Android PR207 CI 227 suites / 2440 tests 及原生 unit/assembleDebug；backend 196文件 / 2217 pass / 6 skipped。既有独立 Standards / Spec 审查已收敛，见各实现 JOURNAL；本轮仅新增验收记录，不重新声称跑过代码审查或全量测试。

## 观察与发布边界

- Android 学员首次回播显示 “Could not load the playback link. Try again”。后续同消息重试、再次播放、冷启动回播及反向接收均成功，未复现。**根因未确认、未改代码，不记为已修复**；保留原始失败证据。下一包真机抽查如再现，按该入口抓取无凭证的错误码排查。
- 新卡可能在当前视口下方，需向上滚动查看；保留现有聊天定位行为，没有为验收改变滚动规则。自动化不得点击 offscreen ref。
- 真实弱网中断/自然签名过期、正式包覆盖升级、真机音频没有现场证据；对应可控状态由自动化覆盖，硬件/升级仍在切包 gate 核对。本记录不声称覆盖所有网络与设备条件。
- 国内功能验收可入 P1 候选，后端无需因纯文档再部署；Global 的迁移/后端和 App 发布仍独立处理。Archive / ASC 上传由 David 手动。

本目录图片与文本校验和见 [SHA256SUMS](SHA256SUMS.txt)。截图仅包含获准测试对话与合成视频；没有真实其他学员列表、邮箱、密码、token 或签名 URL。
