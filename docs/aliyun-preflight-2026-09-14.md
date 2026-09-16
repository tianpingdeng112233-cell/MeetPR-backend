# 阿里云登录后只读预检 — 2026-09-14

> 历史验收快照；2026-09-16 的实际备份、0070 与部署状态见 [上线记录](deployment-045-web101-53-2026-09-16.md)。

## 已确认

David 已完成阿里云登录，说明 GitHub billing 需过几天解除。本轮使用现有阿里云会话、SAE Webshell 中现有应用连接和 READ ONLY 事务；没有提取凭证、下载业务数据或修改线上结构、数据、环境与镜像。

- SAE：`meetpr-backend-staging`，华东1杭州；运行中 1 / 目标 1 个实例。
- 镜像：`sha-42238a99812c75bb92f8bd24bdc74134d0074d3e`，与当前已合 staging 代码对应。上轮引用的 `sha-d604c8c` 是此前部署记录，不能再当作当前镜像。
- `GET http://121.40.160.241:3000/health` 返回 `{"status":"ok"}`。
- RDS：`meetpr-rds-v01-staging`。应用连接执行 `SHOW server_version` 返回 **18.3**；控制台“备份集版本 18.0”是其显示值，不代替实际 server_version。
- 0070 前置：`plan_shift_batches` 不存在，`plan_day_shifts.seq` 不存在，确认尚未应用。
- 存量 `plan_day_shifts` 共 7 行、2 批。按 batch 检查关联 plan 与 student 唯一性，不一致批次数为 0。只返回计数，未输出业务 ID 或内容。
- 最新可见全量快照备份：控制台显示 2026-09-13 18:07:44 开始、18:10:21 完成，恢复时间点 18:07:44，状态“完成备份”。这里原样记录控制台时间，未额外推断时区。实际迁移时应重新核实并获取临近迁移的备份；本轮未创建或恢复备份。

## 推送现状

`PUSH_ENABLED=true`，`APNS_ENV=sandbox`，`APNS_BUNDLE_ID=com.meetpr.app`；五个 APNS 配置项已存在，未输出 key、key ID 或 team ID。`COACH_PLAN_SHIFT_ENABLED` 未配置，按 spec 默认关闭；当前镜像也尚未包含教练后移实现。

设备 token 注册行数为 10。最近 14 天 outbox 共 50 条，均为 failed，没有 delivered/pending：bind_request 8、chat_message 7、missed_training 2、plan_published 8、plan_updated 1、video_pending 24。失败原因按白名单分类为 no_device_tokens 46、unknown_event_type 4；这些历史结果不能证明当前 10 个 token 的送达能力，也不能据此归因于环境不匹配。

TestFlight / production profile 使用 production APNs，当前 sandbox 配置与目标分发环境有差异。依据 [Apple APS Environment Entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/aps-environment)；官方 Markdown 明确 production profile 与 prerelease beta distribution 使用 production。上线验收须确认目标包/设备、生产环境 key 可用性及真实送达。当前未改环境、未发送测试消息、未删除 token、未重放失败 outbox。

## PostgreSQL 18 隔离验证

真实库为 PG18，补充执行未经改写的 `db/migrations/0070-plan-shift-batches.sql`。本机已有 `postgres:18` 镜像实际为 **18.4 (Debian 18.4-1.pgdg13+1)**，与线上 18.3 同大版本但不是同一小版本；不宣称对线上执行过迁移。

- 一次性容器 `meetpr-0070-pg18-preflight`，`--network none`，无宿主端口、无业务凭证；验证后已移除。
- 原始 SQL 在空表与四行乱序合成存量场景均执行成功。
- ASSERT 覆盖按 created_at/id 的 seq 回填、两批父元数据及 anchor、首个 nextval（空表 1 / 存量 5）、旧写者不写父批次、两个索引、actor/offset CHECK、删除合成 plan 后级联。
- 镜像 digest：`sha256:22c89fe0d0f507606260237fd55e51f6137f58b2d5bcf6152242b96d9fe8f9a4`。
- 本机可复跑 SQL 与结果：`/Users/david/Projects/scratch/meetpr-aliyun-preflight-2026-09-14/verify-0070-pg18.sql`、`pg18-result.log`。与首轮 PG17.10 证据互补。

## 继续执行顺序

GitHub billing 解除后：重新核实目标 SHA 和 CI → 按已有授权及仓内门禁合并 → 临近部署复核真实库/备份，按具体迁移方案执行 0070 → 新镜像全量滚动 → 确认旧实例退场再开 coach gate → web #101 合并与同源 swap → 三端及 production APNs 验收。0070 是 live 数据迁移，执行前按 David 的数据门禁交代具体备份、回填及回滚方案。

本轮未安排定时重试；David 告知 billing 解锁后从上述状态续接。
