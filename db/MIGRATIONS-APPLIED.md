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

> 号段说明:0039 曾被未合的 PR #59(多设备会话)占号,期间 0038 直跳 0040;#59 于 2026-07-17 合并后 0039 落库,号段现已连续(0029/0030 为历史补号)。

**当前 staging schema head = 0042。**

## 变更历史

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
- 2026-07-12 — `sha-e87ffac`(=staging HEAD,#57 顺延 V2 + #58 plan-web input-guard)部署
  `meetpr-backend-staging`;env 未动(FORCE_HTTPS 不开 / AUTH_ALLOW_LEGACY_TOKENS 不关);
  **先应用 0038 迁移再滚镜像**。curl 验证:/health 200、`POST/DELETE /plans/:id/shift` 404→401/403
  (带号探测返 NOT_PLAN_STUDENT,证事务写新列成功)、旧 V1 天级端点 404(已替代)、既有端点
  (/students/:id/plans、/exercises、/me/password、/auth/refresh)全绿。配套 iOS 1.0(9) 同日发布。
- 2026-07-11 — `sha-4100a00`(=staging HEAD,spec016)部署 `meetpr-backend-staging`;env 未动;
  curl 验证:/health ok、顺延/回顾端点 404→401、/sets/log 正常(此前镜像冻结于 ~2026-06-24)
