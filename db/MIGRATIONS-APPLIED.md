# DB 迁移应用账本（staging）

> 为什么有这份文件:本仓**没有 `schema_migrations` 账本表**,迁移与 SAE 部署**都是手动**两步。
> 2026-06-24 起这两步静默停摆,线上库停在 0028 而镜像代码已需要 0031→0037,
> 导致 `POST /sets/log` 等端点 42703 → 500,且**无处可查漂移**。此文件即人肉账本:
> **每次对某环境应用迁移后,在这里追加一行**,让漂移不再隐形。

## 机制备忘（下次手动跑迁移前必读）

- CI 自动 build+push 镜像到 ACR(tag `v0.1-staging` / `sha-<sha>`);**迁移仍要人手做(DMS)**。
- SAE 滚镜像自 spec 018 起一键化:`gh workflow run deploy-staging.yml -f migrations_applied=true`
  (手动 dispatch,不随 push 自动——"先迁移后滚镜像"顺序不变,`migrations_applied` 不勾会直接红);
  可选 `-f image_sha=<full sha>` 指定非 HEAD 镜像。控制台手点仅作 fallback。
- 迁移文件自带 `BEGIN/COMMIT`,失败自动回滚该文件;逐个跑逐个看返回。
- **DMS 控制台跑迁移的坑**:DMS 默认连接 schema 是 `information_schema`,不带前缀的
  `CREATE TABLE/TYPE` 会试图建进系统库 → `permission denied for schema information_schema`。
  解法:每份迁移在 `BEGIN;` 后加一行 **`SET search_path TO public;`**。
  (用 `psql` 且默认 search_path=public 时无此问题。)
- `0033` 的 `CREATE TYPE` 非幂等:若中途失败重跑前,先查并清掉半建的枚举类型。

## 数据备份与测试账号清理 SOP

- 每次迁移或危险数据清理前,先运行
  `pnpm tsx scripts/backup-db.ts`(需要时用 `--out-dir <目录>` 覆盖默认 `./backups/`),确认命令打印
  备份绝对路径与非零文件大小后再继续。
- 清理内测账号一律先运行 `pnpm tsx scripts/delete-test-accounts.ts` 查看 dry-run 清单与级联影响;
  复核后复制脚本打印的 `--apply --id <uuid> ...` 命令。apply 只处理显式 ID 与当前白名单候选的交集,
  任一传入 ID 不合格则整次回滚;未传入的白名单账号不删。apply 会先强制完成同一套全库备份,
  备份失败不会删除。
- **禁止再手抄 `DELETE FROM users` SQL**。只有同时满足 `users.is_test=true` 与脚本内测试 phone/UUID
  白名单的账号才允许进入删除语句;误标行会告警并跳过。
- 0049 只精确回填 0004 seed 的两组 `(id, phone)`。其它测试账号须在造号时写 `is_test=true`,或核验后用
  `UPDATE public.users SET is_test = true WHERE id = '<reviewed-uuid>';` 精确置位;禁止按号段批量标记。

## staging (`meetpr-rds-v01-staging`, pgm-bp1h7t65b7if01rq, 华东1杭州) 应用状态

| 迁移                                            | 应用状态                                                        |
| ----------------------------------------------- | --------------------------------------------------------------- |
| 0001 → 0028（含 0002.1 / 0003.5 / 0003.6）      | ✅ 漂移前已应用(库长期在 0028 稳定运行)                         |
| 0029-init-events / 0030-init-analytics-feedback | ✅ 2026-07-13 手动应用(DMS,David)                               |
| 0031-adhoc-set-logs                             | ✅ 2026-07-10 手动应用(DMS)                                     |
| 0032-init-session-reviews                       | ✅ 2026-07-10 手动应用(DMS)                                     |
| 0033-algo-foundation-schema                     | ✅ 2026-07-10 手动应用(DMS)                                     |
| 0034-imported-history-assumed                   | ✅ 2026-07-10 手动应用(DMS)                                     |
| 0035-attachment-lifecycle                       | ✅ 2026-07-10 手动应用(DMS)                                     |
| 0036-notification-outbox                        | ✅ 2026-07-10 手动应用(DMS)                                     |
| 0037-add-plan-day-shifts                        | ✅ 2026-07-10 手动应用(DMS)                                     |
| 0038-whole-plan-shift                           | ✅ 2026-07-12 手动应用(DMS,David)                               |
| 0040-exercise-competition-stance                | ✅ 应用时点未见于账本(早于对账);2026-07-16 对账发现已在库并补记 |
| 0039-multi-device-sessions                      | ✅ 2026-07-17 手动应用(psql,Claude)                             |
| 0041-init-activity-ledger                       | ✅ 2026-07-17 手动应用(psql,Claude)                             |
| 0042-init-device-tokens                         | ✅ 2026-07-17 手动应用(psql,Claude)                             |
| 0044-add-admin-role                             | ✅ 2026-07-18 手动应用(DMS,David;执行成功 5 条语句)             |
| 0045-init-chat                                  | ✅ 2026-07-22 手动应用(DMS,David;执行成功 11 条语句)            |
| 0046-add-feedback-video-id                      | ✅ 2026-07-22 手动应用(DMS,David;执行成功 4 条语句)             |
| 0049-add-users-is-test                          | ⏳ 待应用(引入 `users.is_test`,回填既有测试账号)                |

> 号段说明:0039 曾被未合的 PR #59(多设备会话)占号,期间 0038 直跳 0040;#59 于 2026-07-17 合并后 0039 落库,号段现已连续(0029/0030 为历史补号)。0043 现由 open PR #77/#79(账本扩展)占号,0044 先行落库,库内号段暂跳 0043——#77/#79 合并应用后回续。0047 已被 open PR #95、0048 已被 #99 占用,因此下一份空号取 0049。

**当前 staging schema head = 0046（0043 缺位,0049 待应用;0047/0048 仍由 open PR 占号）。**

## 变更历史

- **2026-07-22** — `sha-b62de27`(=staging HEAD,#97 纯 web/ 换装:三处误用品牌红的按钮改回设计系统
  规定的中性/主按钮填充——视频反馈「发送」、绑定请求「接受」、播放速度选中态,改用 `fg-primary`/`bg`
  以便浅色模式正确反色;bundle 源 plan-web `de40b53`/入口 `index-1lmGK0KK.js`)经 deploy-staging.yml
  (`migrations_applied=true`,**无迁移**,schema head 仍 0046)部署 `meetpr-backend-staging`;env 未动。
  curl 验证:GET / 回新入口(旧 `index-DnDfF7y7.js` → 新 `index-1lmGK0KK.js`)、/health 200、
  /auth/login 空 body 400(非 5xx,登录红线守住)、线上 CSS 三处均已无 `--brand-red`。
  换装前已核对旧 bundle 已含 PR #27/#28,本次不夹带其他未审改动。

- **2026-07-22** — 应用 **0045-init-chat**(PR #92,spec 024 教练↔学员 1:1 聊天 W1):建 `conversations`
  / `messages` / `conversation_reads` 三表 + 三索引,并把 `attachments_kind_check` 换成含 `chat_image`
  的新约束(枚举保留原有 `set_video` / `onboarding_video` / `onboarding_doc`,零 kind 丢失)。
  工具:DMS 控制台(David),执行成功 **11 条语句**。**号段回补**:0045 晚于已落库的 0046 应用,
  两者对象不相交(0046 只加 `feedback.video_id` 外键,0045 只换 `attachments.kind` 的 CHECK),
  无顺序依赖;schema head 仍为 **0046**。
  ⚠️ 本份迁移文件**未自带** `SET search_path TO public;`(0042/0044 同样没有,只有 0046 有),
  DMS 控制台跑必须手加该行,否则撞 `permission denied for schema information_schema`。
  同批滚镜像 `sha-7b65af4`(= #92 后端全部聊天代码,零 `web/` 改动)。
  curl 验证:`/health` 200;四条聊天路由 `GET/POST /conversations`、
  `GET /conversations/:id/messages`、`POST /conversations/:id/read` 全回 401 `AUTH_INVALID_TOKEN`
  (证明已挂载且受鉴权保护),对照 `/conversations-nope` 回 404(证明 401 不是兜底);
  既有 `POST /auth/login` 空体仍回 400,未被打坏。

- **2026-07-22** — 应用 **0046-add-feedback-video-id**(PR #93,spec 025 视频级教练反馈):`feedback`
  加可空 `video_id → attachments(id) ON DELETE SET NULL`,纯 additive。工具:DMS 控制台(David),
  执行成功 4 条语句(`BEGIN` / `SET search_path` / `ALTER TABLE` / `COMMIT`)。schema head 0044 → **0046**
  (0043 仍被 open PR #77/#79 占号、0045 被聊天波 #92 占号,两处待各自合并后回续)。
  同批滚镜像 `sha-cc1ba36`(= #93 后端改动 + plan-web 视频弹窗新 bundle 的 `web/` swap)。
  **⚠️ 本次差点重演 2026-07-20 全站 404**:裸 `npm run build` 会把 `/api` 烘进 bundle
  (`client.ts` 的 `VITE_API_BASE ?? '/api'` 是 dev 代理默认值),同源部署**必须** `VITE_API_BASE=''`。
  首次构建确实中招,靠 `bd4da5a` commit message 记的那条验证在 push 前发现并重建。上线后已 curl
  线上 chunk 实证:`const e=""`、`"/api"` 出现 **0** 次;`/coach/students` 未认证回 401(非 404/502)。
  注:机械闸早已存在(`fd674dc`,出镜像前验同源 marker + 部署后自动 smoke),坏包本来也进不了线上;
  本次的人工前置验证只是省了一轮红 CI,**不要再重复造这道闸**。

- **2026-07-17(晚)** — 应用 **0039-multi-device-sessions**(PR #59,多设备会话):建 `sessions` 表
  (每设备一行,60s 轮换宽限治丢包竞态,上限 5 活跃会话),backfill `INSERT 0 124`——124 个在用
  refresh token 全部平移,**零登出**;legacy 回退路径保证「迁移后、滚镜像前」窗口内旧代码继续轮换
  `users.refresh_token_jti` 的 token 也能在新代码下换入 session。同批补应用 **0041-init-activity-ledger**
  (`training_sessions`/`student_events`/`student_signals` 3 永久表 + backfill 临时表自建自删)与
  **0042-init-device-tokens**(`device_tokens`),两者代码(spec 018 账本 / #75 push pipeline)早已合入
  staging,属「合了未应用」补账。工具:本机 psql 直连(默认 search_path=public,无 DMS 坑);
  三文件逐个 ON_ERROR_STOP 执行,均 COMMIT;事后校验 5 张新表全在、`sessions` 计 124 行。

- **2026-07-17** — 滚镜像 `sha-0c16428`(#76 auth refresh 接受 snake_case `refresh_token`,治 iOS 全员 15 分钟 token 刷新 400/BindGate 死锁;**零迁移**,schema head 仍 0040)。本次为**一键部署 workflow(#71,spec 018)首跑**,凭证已配,此后部署 `gh workflow run deploy-staging.yml`。同日 OSS 开**传输加速**,SAE env `OSS_ENDPOINT` 改 `https://oss-accelerate.aliyuncs.com` 并再滚一次生效(治海外上传 ~20KB/s 卡 0%)。curl 验证三绿:refresh 探针 400→401、`/uploads/initiate` 签名域名=`meetpr-videos-prod.oss-accelerate.aliyuncs.com`、5MB 分片 PUT 1.7s(~3MB/s)。⚠️ 探针残留:一次性测试号 `+8613900008871`~`8875`(self_train_student,无业务数据)+ 数条 1KB/5MB `uploading` 状态 attachments,可按需清理。

- **2026-07-16** — 对账 0040-exercise-competition-stance(#69 e1RM 竞技动作解析)。**发现该列早已在库,漂移只在账本**:
  部署镜像 `sha-caf7796`(=caf7796,含 #69 代码)在 [exercise-stats.ts:32](../src/handlers/exercise-stats.ts)
  等 4 文件约 8 处显式引用 `exercises.competition_stance`,而账本 head 停在 0038,原判「未 apply → 42703→500」。
  DMS 实查(`SET search_path TO public;`):`information_schema.columns` 命中 `competition_stance text`(9ms);
  `SELECT name, competition_stance FROM exercises WHERE competition_stance IS NOT NULL` 返回 **4 行齐**(5ms):
  传统硬拉→conventional / 高杠位深蹲→high_bar / 低杠位深蹲→low_bar / 相扑硬拉→sumo,即 0040 的 ALTER+4 UPDATE
  已完整提交。**应用时点未见于账本**(caf7796 部署行当时记「零迁移」,推测 0040 随 #69 前后手动应用但漏记本文件);
  本次纯补账本,**无任何 DB 写操作**。curl 佐证线上健康(踩之前会 42703 的路径):`/health` 200、
  `GET /coach/students/:id/exercise-stats`(overview,走 line 221 select) 200、同端点带 `?exercise_id=传统硬拉`
  (detail,强制 line 32 `e.competition_stance` join select) 200——均未 500。
  ⚠️ **验证探针在 staging 造了测试数据**:教练 `+8613900000042`(id `1237a673-0ab1-49b2-9fbe-c39e06a738aa`)、
  学员 `+8613900000043`(id `24d0b844-051b-4e1a-9116-d44b4dc10b69`)、一枚个人永久邀请码(`XKKQM2LP8G`)、
  一条 accepted 绑定 + 一条 accepted bind_request。均无业务数据(无 set_logs/plans),可留作测试夹具或按需清理
  (清理顺序:bonds/bind_requests → invite_codes → users,或直接 `DELETE FROM users WHERE phone IN ('+8613900000042','+8613900000043');` 靠 FK 级联)。
- **2026-07-13** — 应用 0029-init-events + 0030-init-analytics-feedback(埋点 spec 008,#38 合 staging):
  events 宽表(`event_id` UNIQUE + `user_id` FK ON DELETE SET NULL + 4 索引)+ analytics_feedback
  自由文本隔离表(2 索引)。DMS 两段各带 `SET search_path TO public;` 执行成功(8 语句 5ms / 6 语句 6ms)。
  ⚠️ 号段回填:0029/0030 是补进 0028 与 0031 之间的历史空号(本仓无 runner,纯手工无碍),schema head 仍 0038。
  ✅ **端点已上线**(2026-07-13):SAE 滚 `sha-2cacea6` 后 curl 验证 `/events/config` 200 `{enabled:true,sample_rate:1}`、`POST /events`(anon app_open)204、partial-accept(含无效事件名)仍 204、`/health` 200。
- **2026-07-12** — 应用 0038-whole-plan-shift(spec 054 顺延 V2,#57):`plan_day_shifts` 加
  `batch_id`/`created_at`,唯一约束改 (plan_day_id, batch_id) 支撑撤销。DMS 执行成功(4 语句 9ms);
  事后 schema 校验:两新列 + 两新索引(`plan_day_batch_uidx` / `batch_created_idx`)在,
  旧约束 `plan_day_shifts_plan_day_id_key` 已删。⚠️ 下一批 0039(多设备会话,PR #59)合并后同款流程。
- **2026-07-10** — 补齐 0031→0037(共 7 个)根治部署漂移。应用前先做 RDS 全量快照
  (恢复点 18:07:34);逐个 DMS 执行、每个 `SET search_path TO public;`;事后 schema 校验
  (set_logs 4 新列 / 7 新表 / 6 枚举全在)+ curl 验证 `POST /sets/log` 500→201。

## SAE 镜像部署记录（同为手动步骤,滚镜像后追加一行）

- 2026-07-22(三) — `sha-7b65af4`(=staging HEAD,#92 教练↔学员 1:1 聊天 backend spec 024 W1:
  `/conversations` 五条 REST 路由 + 会话内单调 `seq` 排序/分页/已读游标 + canonical active 绑定
  校验 + `chat_image` 附件种类;零 `web/` 改动)经 deploy-staging.yml(`migrations_applied=true`)
  部署 `meetpr-backend-staging`;env 未动。**先应用 0045 迁移再滚镜像**(DMS,David,11 条语句成功)。
  触发前已确认 ACR 镜像 `sha-7b65af4` build-push 完成,避开 2026-07-18 那次「镜像未出竞态」。
  验证:deploy smoke 全绿 + curl 四条聊天路由 401 / 对照路由 404 / `/auth/login` 400 / `/health` 200。(=staging HEAD,纯 web/ 换装:教练端网页**改密码**上线——顶栏
  「退出」旁加「改密码」;会话收尾按 review-loop 定案:未保存守卫**前置**到发 PUT 之前(还能存时
  让教练退出/保存)、204 后**立即**拆会话(清 token+draft mirror、卸编辑器,不等确认)、成功提示由
  登录页一次性 sessionStorage notice 承载(peek/clear 拆分扛 StrictMode 双跑)、中途 401 走同一
  会话失效出口。弹窗 portal 到 body 以逃出顶栏 stacking context。新入口 index-BzlfDfdK.js,
  源自 plan-web main db43488(PR #28,同车带上 f5978c9 技术风格枚举中文化),零后端代码/零迁移)
  经 deploy-staging.yml(migrations_applied=true, image_sha=全 40 位)部署 `meetpr-backend-staging`;
  env 未动。⚠️gotcha:`-f image_sha` **必须全 40 位 sha**,传短 sha 直接红("image_sha must be a
  full 40-char commit sha")。验证:CI bundle base 闸绿 + deploy smoke 绿 + curl 四验(GET / 回新
  入口、线上 bundle `const e=""` 且零 `/api` 残留、登录红线教练/学员双端 200、错误密码 401、
  PUT /me/password 回 401 鉴权)+ 浏览器在**线上站点**跑完整改密链路(改密→踢回登录页→提示条
  显示→token 清空;服务端复核新密码 200/旧密码 401)。
- 2026-07-20(二) — `sha-468ec61`(=staging HEAD,纯 web/ 换装:plan-web「组」数量格 delete 修复——
  最后一位数字现可退格删空(编辑中显空、失焦提交为 0 组),不再弹回旧值;需全选覆盖才能改的坑消除。
  新入口 index-DdUYwqtJ.js,源自 plan-web main f36c7a5,零后端代码/零迁移)经 deploy-staging.yml
  (migrations_applied=true)部署 `meetpr-backend-staging`;env 未动。deploy smoke 闸全绿 + curl 验证:
  GET / 已 serve 新入口 index-DdUYwqtJ.js、bundle 内同源 base marker 在。
- 2026-07-20(二) — `sha-fd674dc`(=staging HEAD,纯 workflow/docs:build 期 web bundle base 闸
  与 deploy 后 smoke 闸,零运行时代码/零迁移)部署 `meetpr-backend-staging`;env 未动。本次部署
  兼作 smoke 闸首航:health OK / login 回 AUTH_INVALID_CREDENTIALS / 线上 bundle 同源 marker 全过
  ——此后每次 deploy 自动跑这三验,挂了 workflow 直接红。
- 2026-07-20 — `sha-c7deaf8`(=staging HEAD,P0:plan-web web/ 重打——297e775/4686586 两版 bundle
  构建时漏 `VITE_API_BASE=''`,base 烤成 dev 专用 `/api`,线上同源站点全部 API 404,登录表现为
  not_found;新入口 index-fkz63PIQ 源自 plan-web main 842fcda,零后端代码/零迁移)经一键部署
  workflow 部署 `meetpr-backend-staging`;env 未动。curl 验证:GET / 已 serve 新入口、bundle 内
  `const e=""`、`POST /auth/login` 回 AUTH_INVALID_CREDENTIALS(路由通,不再 404)。
- 2026-07-19 — `sha-4686586`(=staging HEAD,spec 023 动作使用频次 #90 + plan-web #26 picker
  键盘化/频次排序/admin 动作库 tab 的 web/ 换装,bundle 入口 index-CLVL278Y,零迁移)经一键部署
  workflow 部署 `meetpr-backend-staging`;env 未动。curl 验证:新端点 /exercises/usage-stats 与
  /admin/exercise-usage 均 401(路由在线、鉴权拦截,404 即未上);站点已 serve 新 bundle。
  含同车合入的 #91(events 平台枚举加 android,纯校验放宽)。
- 2026-07-19(凌晨) — `sha-297e775`(=staging HEAD,plan-web #25 admin 工作台 web/ 换装,bundle
  index-DPKOSAff/入口 index-g1Q3cMef,零迁移零后端代码)经一键部署 workflow 部署
  `meetpr-backend-staging`;env 未动。curl 验证:/health 200、新 bundle 200。admin 全流程已在部署前
  以 dev 预览对同一 staging 后端逐屏走查(admin 登录/四 tab/用户与计划详情/无 DANGER 区/真动作名)。
  admin 账号已由 David 手跑 create-admin 创建(`ADMIN_CREATED`,2026-07-18)。
- 2026-07-18(夜) — `sha-c6d2805`(=staging HEAD,#89 admin 只读波 spec 022)经一键部署 workflow 部署
  `meetpr-backend-staging`;env 未动;**0044 已先应用**(DMS,David,执行成功)。curl 验证:/health 200、
  `/admin/{overview,users,bindings,plans}` 匿名 401 `AUTH_INVALID_TOKEN`(403/200 分支由 602 项测试
  覆盖,admin 造号后浏览器走查复验)。配套 plan-web PR #25 待走查后合并。
- 2026-07-17(夜) — `sha-cea74fa`(=staging HEAD,#78 plan-web 训练日分节 web/ 换装,零迁移零后端代码)
  经一键部署 workflow 部署 `meetpr-backend-staging`(`gh workflow run deploy-staging.yml -f migrations_applied=true`,
  Claude 触发)。curl 验证:`GET /`→SPA 入口已换 `index-BNfGRD33.js` 且 bundle 含「主项及变式」文案、
  assets 200、`POST /auth/login` 空体 400(服务健康)。前两次 dispatch 失败=迁移确认闸未带参 + 镜像未出好,
  非服务事故;教训已记 workflow 用法(先等 build-push 出 sha 镜像、必带 `-f migrations_applied=true`)。
- 2026-07-17(晚) — `sha-01eb47a`(=staging HEAD,#59 多设备会话 + 账本 docs)经一键部署 workflow
  部署 `meetpr-backend-staging`(`gh workflow run deploy-staging.yml`,Claude 触发);
  **先应用 0039/0041/0042 再滚镜像**;env 未动(FORCE_HTTPS 不开 / AUTH_ALLOW_LEGACY_TOKENS 不关)。
  curl 验证五绿:/health 200、register 201、refresh(snake_case)200、**二次 login 后原设备 refresh 仍 200**
  (多设备不互踢实锤,旧模型此处必 401)、同 token 宽限窗重放 200(丢包重试幂等)。
  探针号 `+8613900008876` 已即时 DELETE(FK 级联清 sessions,孤儿会话 0)。

- 2026-07-13 — `sha-caf7796`(=staging HEAD,#70 gym-day 宽限窗 spec 017:coached 缺省 `logged_date`
  改 04:00 Asia/Shanghai 截断)部署 `meetpr-backend-staging`(David 手动控制台,#71 一键部署 workflow
  尚未启用);**零迁移、env 未动**。curl 验证:`/health` 200、`POST /sets/log` 无鉴权 401 信封正确、
  `/events/config` 200 不受影响。⚠️ 截断行为差异仅在凌晨 0-4 点窗口可外部观测,当晚 22:4x 冒烟
  只能证「服务健康+新镜像在跑」;正确性证据=CI 内 7 条边界测试(纯函数 5 + 冻结时钟路由级 2)。
- 2026-07-13 — `sha-2cacea6`(=staging HEAD,#38 埋点 spec 008:`/events` + `/events/feedback` +
  `/events/config` + events/analytics_feedback 表 + createOptionalAuth)部署 `meetpr-backend-staging`;
  env **未动**(analytics 4 个全走默认:`ANALYTICS_ENABLED=true` / `SAMPLE_RATE=1` / limiter 60s·600;
  `FORCE_HTTPS` 不开 / `AUTH_ALLOW_LEGACY_TOKENS` 不关);**先应用 0029/0030 迁移再滚镜像**。
  curl 验证:`/events/config` 200、`POST /events`(anon app_open)204、partial-accept 204、`/health` 200。
  ⚠️ probe 写入 1 条测试事件(anon_id `aacc0000-…-000000000001`),David 可 `DELETE FROM events WHERE anon_id='aacc0000-0000-4000-8000-000000000001';` 清掉免污染首批真实数据。
- 2026-07-18 — `sha-0c0421e`(#87 纯 web/ 换装:总重显示统一 kg 不用吨,bundle b568b40/入口
  index-BN1pHRvm.js)经 deploy-staging.yml 部署;curl 验证入口已换。当日第七次部署。
- 2026-07-18 — `sha-6ed383e`(#86 纯 web/ 换装:朴素容量汇总,bundle 3d5e805/入口 index-BCjeNeGw.js——
  周头汇总挪至标题后(主项/辅项/总重)+日分节组数吨位+JTS 参考层删除+David 直驱分节加动作 fe47c5f)
  经 deploy-staging.yml 部署;curl 验证入口已换。当日第六次部署(xty 汇总反馈闭环)。
- 2026-07-18 — `sha-a3fea63`(=staging HEAD,#85 纯 web/ 换装:批量保存客户端,bundle 3b08bc7/入口
  index-D5RVOwPq.js——整份计划保存几百请求→1-2 个批量事务)经 deploy-staging.yml 部署;curl 验证:
  GET / 回新入口、/auth/login 200。当日第五次部署(autosave 整体翻新收官)。
- 2026-07-18 — `sha-27e1092`(#84 纯 web/ 换装:本地草稿镜像安全网+日列头拖拽握把,bundle b244b32/
  入口 index-B9Oesurs.js)经 deploy-staging.yml 部署;curl 验证入口已换。当日第四次部署。
- 2026-07-18 — `sha-85d10ff`(=staging HEAD,#82 批量端点 POST /plans/:id/days/batch + #83 web 换装:
  编辑器 MEV-MRV 软提示/学员看板 JTS 容量卡/published 拖拽放开,bundle edfe20f/入口 index-C5keIKqU.js)
  经 deploy-staging.yml 部署(无迁移;首次触发因镜像未出竞态失败,等 build-push 完成后重触发成功);
  curl 验证:GET / 回新入口、/auth/login 200。当日第三次部署。
- 2026-07-18 — `sha-157a316`(=staging HEAD,#81 纯 web/ 换装:plan-web 整列拖拽搬日 #15+周容量汇总 #16,
  bundle 20c28b2/入口 index-CKYW81yE.js)经 deploy-staging.yml(migrations_applied=true,无迁移)部署
  `meetpr-backend-staging`;env 未动。curl 验证:GET / 回新入口、/auth/login 200。同日第二次 web 换装(首次 sha-a5bbdb9)。
- 2026-07-18 — `sha-a5bbdb9`(=staging HEAD,#80 纯 web/ 换装:plan-web autosave 切视图丢内容修复,
  bundle cbf7203/入口 index-DUUesC1M.js)经 deploy-staging.yml(migrations_applied=true,无迁移)部署
  `meetpr-backend-staging`;env 未动。curl 验证:GET / 已回新入口 index-DUUesC1M.js、/auth/login 200。
- 2026-07-12 — `sha-e87ffac`(=staging HEAD,#57 顺延 V2 + #58 plan-web input-guard)部署
  `meetpr-backend-staging`;env 未动(FORCE_HTTPS 不开 / AUTH_ALLOW_LEGACY_TOKENS 不关);
  **先应用 0038 迁移再滚镜像**。curl 验证:/health 200、`POST/DELETE /plans/:id/shift` 404→401/403
  (带号探测返 NOT_PLAN_STUDENT,证事务写新列成功)、旧 V1 天级端点 404(已替代)、既有端点
  (/students/:id/plans、/exercises、/me/password、/auth/refresh)全绿。配套 iOS 1.0(9) 同日发布。
- 2026-07-11 — `sha-4100a00`(=staging HEAD,spec016)部署 `meetpr-backend-staging`;env 未动;
  curl 验证:/health ok、顺延/回顾端点 404→401、/sets/log 正常(此前镜像冻结于 ~2026-06-24)
