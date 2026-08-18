# DB 迁移应用账本(海外 · DO Managed PG `meetpr-global-pg`)

> 海外线(DigitalOcean NYC,App Platform app `meetpr-backend-global` / 库 `meetpr-global-pg`)与国内
> 杭州 staging **各记各的账**:同一套 `db/migrations/` 文件,两个环境两本账,谁也不代表谁。
> 国内账本见 [MIGRATIONS-APPLIED.md](MIGRATIONS-APPLIED.md)。

## 机制(与国内的三点不同)

- **迁移有账本表**:海外库从第一天起就有 `meetpr_migrations`(filename PK + applied_at),由
  `migrate-global.yml` 维护——workflow 逐文件剥掉外层 `BEGIN/COMMIT`,重新包成
  「迁移 + 账本 INSERT」单事务,已应用的文件自动跳过,可安全重跑。本文件是人读摘要,机器真相在账本表。
- **跑法**:`gh workflow run migrate-global.yml`(doctl 现取连接串,GH Actions 里执行;无 DMS、无手工 SQL)。
- **部署**:`gh workflow run deploy-global.yml -f migrations_applied=true -f image_sha=<full sha>`
  (镜像由 build-push-global.yml 在 staging push 时自动出;deploy 前会 `docker manifest inspect`
  校验镜像存在——DOCR list-tags 在 GC 后有假阴性,别用它判断)。
- **连接**:生产 TLS 严格校验 DO 私有 CA(`DATABASE_CA_CERT` ← app spec `${globalpg.CA_CERT}`,PR #254);
  连接串自带的 `?sslmode=require` 会被 pool 剥掉以免覆盖 CA——细节见 `src/db/pool.ts`。

## 应用记录

| 日期(UTC)  | 动作                                                                                        | 结果                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 2026-08-18 | migrate-global.yml 首次全量重放 `0001` → `0067-digest-watermarks.sql`                       | 全绿,schema head **0067**;catalog 1227 条随迁移落库                                     |
| 2026-08-18 | deploy-global.yml 上线 `sha-521c0757`(含 DB TLS 修复 #254)                                  | Healthy;api.meetpr.app 写路径实证(注册 201/登录 200/forgot 204)                         |
| 2026-08-18 | deploy-global.yml 重跑同 sha,换入重铸的 R2 S3 密钥对(修复前 GH secrets 存的是 9 字符占位符) | R2 全链实证:initiate 201 → part PUT 200 → complete 200 → 签名回读 204800 字节逐字节等长 |
