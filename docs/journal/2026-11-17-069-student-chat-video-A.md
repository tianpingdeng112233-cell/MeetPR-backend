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

- 实际迁移/部署、真实OSS上传及跨端账号收发；本机 fake OSS / HTTP测试不冒充已部署验收。
- 本卡0089应用前再次核对实际schema/号段并按ROLLOUT备份，等待David具体批准。

## 独立收货（第 1 轮）

- Standards：独立只读 reviewer `review_standards_113`，backend CLEAN，无实质违规。
- Spec：独立只读 reviewer `review_spec_113`，完整后端 diff / 迁移 / API 与约束测试及调用链覆盖，backend CLEAN。
- 主代理复读最终差异；typecheck、lint、format:check、build 均 exit 0；全量测试结果见上。仅后端本地收货通过，不代表尚未执行的真实部署/跨端 OSS 验收。

## PR 与收尾现场

- [PR #429](https://github.com/tianpingdeng112233-cell/MeetPR-backend/pull/429)，本卡fa720d4 CI Build & Test / Lint & Format均通过；T2未合并。
- 收尾fetch确认staging已到6f1382a（热身组#427及台账#428），PR可合并。上游台账记录0088已应用/05009bd部署；本卡0089仍待批准执行，未复用其它任务的部署授权。

## 已批准上线，2026-11-17 继续执行

David 明确批准合并三仓、备份、0089、后端部署和 Android/iOS 真实跨端收发，无需再次申请这组操作的许可。

- backend #429 已于12:45 UTC合并：`5ac8da8386958ec4a997cb86df1dc65483cd2973`。ACR镜像构建 [44086090295](https://github.com/tianpingdeng112233-cell/MeetPR-backend/actions/runs/44086090295) 成功（verify与image push均绿）。
- iOS #478：`c3c1b34ef705deeb25ffe2971fbb633d02de0528`；Android #207：`a6f848ce4f09eca7a73b609ce93bbfa939ab0e3e`，均已合入原目标分支；三仓合并前CI全绿。
- 国内当前/health=200，网页入口仍`/assets/index-DAYvx1ov.js`。本轮尚未触发deploy，不能把health当作新镜像已上线。
- CUA控制台连接连续两次30秒超时；本机无现成Bitwarden CLI/解锁会话、DATABASE_URL或云CLI凭证。已请求恢复控制台或获准凭证通道，并请求已绑定的测试师生登录会话；没有读取/输出密码或绕过备份。
- 0089未执行，实际schema未重新核实，备份未完成，deploy-staging的migrations_applied不能勾选。国内联调用双端CN配置；Global最近可见迁移workflow仍在0068，不能盲跑全量历史迁移。本轮未改Global。
- 已准备原样0089与只读前后核对SQL，待访问恢复后继续。

## David手动应用0089的回执

用户提供同一国内meetpr-rds-v01-staging/meetpr DMS截图：0089七条语句全部绿，最后第七条成功（7ms）；另一次只读复查返回三条public约束：attachments_kind_check、messages_exercise_ref_excludes_video、messages_video_text_only，validated均t，旧messages_video_needs_set_ref未返回。两张原图保存在docs/evidence/069-chat-video/dms-0089-\*.png。不重跑0089。

第二张的definition列位于可视范围右侧，当前未看到完整表达式。RDS手动备份成功记录尚未提供；第一张DMS的“备份未开启”不作为RDS实例备份状态的证据。实际迁移执行证据已收到，备份与完整定义复核仍待补齐，尚未dispatch后端部署，也未进行真实跨端收发。
