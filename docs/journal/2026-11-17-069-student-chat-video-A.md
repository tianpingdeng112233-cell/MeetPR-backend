# 069 卡 A — 学员独立聊天视频

- 来源：David 2026-11-17 批准 App 113 HTML，明确 Android / iOS 一起实装。spec: `specs/069-student-chat-video/SPEC.md`。
- 基底：`origin/staging@07ac7a4`；分支 `feat/069-student-chat-video`。T2 / P1，独立审查通过，交 PR，不自合。
- 契约：`chat_video` 附件（MP4 / MOV，200 MiB）；发送仍为 `text` + 固定 `[视频]` fallback + `video_id`。仅独立视频响应新增 video_id，既有训练组视频响应不改变。
- 授权：仅会话学员可发自己的 ready chat_video；无组引用；通用 URL 对非所有者隐藏。原会话成员通过消息读取/续签；保留聊天图片历史可见性规则。
- 清理：仅新增 chat_video 的消息引用删除保护；原 set_video 删除语义不改。

## red → green

1. `pnpm test tests/chat-video.test.ts`：首轮失败 `initiate failed: 400`；添加附件类型/写入和回读后通过。
2. 通用 URL 隔离回归先失败（教练 generic URL 为200，应404）；限制后通过，并验证已引用视频删回409且 OSS无删除调用。
3. 无set-ref旧非法 body校验、旧训练组响应不暴露video_id 两个既有回归曾失败；恢复旧shape并约束独立消息固定fallback后通过。
4. `pnpm exec vitest run --maxWorkers=4 --minWorkers=1`：196文件、2217 passed / 6 skipped。含新视频发送/读取、错误owner/kind/status、非学员/解绑、MIME/大小、幂等续签、发送删除竞态、SQL迁移约束。

## PostgreSQL 验证

在本机新建的隔离 Unix socket PostgreSQL 17.11 临时库执行真实 0045/0051/0086/0089 SQL，旧消息和附件逐字段保持；独立视频可入库；image/video混用与exercise_ref/video互斥仍受约束。脚本与输出：`docs/evidence/069-chat-video/`。未连接真实业务库。

## 尚待完成

- PR CI。
- 实际迁移/部署、真实OSS上传及跨端账号收发；本机 fake OSS / HTTP测试不冒充已部署验收。
- 0088 被 backend PR #427占用，本卡0089；应用前再次核对实际schema/号段并按ROLLOUT备份，等待David具体批准。

## 独立收货（第 1 轮）

- Standards：独立只读 reviewer `review_standards_113`，backend CLEAN，无实质违规。
- Spec：独立只读 reviewer `review_spec_113`，完整后端 diff / 迁移 / API 与约束测试及调用链覆盖，backend CLEAN。
- 主代理复读最终差异；typecheck、lint、format:check、build 均 exit 0；全量测试结果见上。仅后端本地收货通过，不代表尚未执行的真实部署/跨端 OSS 验收。
