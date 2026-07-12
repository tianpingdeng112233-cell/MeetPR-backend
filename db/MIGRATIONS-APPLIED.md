# DB 迁移应用账本（staging）

> 为什么有这份文件:本仓**没有 `schema_migrations` 账本表**,迁移与 SAE 部署**都是手动**两步。
> 2026-06-24 起这两步静默停摆,线上库停在 0028 而镜像代码已需要 0031→0037,
> 导致 `POST /sets/log` 等端点 42703 → 500,且**无处可查漂移**。此文件即人肉账本:
> **每次对某环境应用迁移后,在这里追加一行**,让漂移不再隐形。

## 机制备忘（下次手动跑迁移前必读）

- CI 只 build+push 镜像到 ACR(tag `v0.1-staging` / `sha-<sha>`);**迁移和 SAE 部署要人手做**。
- 迁移文件自带 `BEGIN/COMMIT`,失败自动回滚该文件;逐个跑逐个看返回。
- **DMS 控制台跑迁移的坑**:DMS 默认连接 schema 是 `information_schema`,不带前缀的
  `CREATE TABLE/TYPE` 会试图建进系统库 → `permission denied for schema information_schema`。
  解法:每份迁移在 `BEGIN;` 后加一行 **`SET search_path TO public;`**。
  (用 `psql` 且默认 search_path=public 时无此问题。)
- `0033` 的 `CREATE TYPE` 非幂等:若中途失败重跑前,先查并清掉半建的枚举类型。

## staging (`meetpr-rds-v01-staging`, pgm-bp1h7t65b7if01rq, 华东1杭州) 应用状态

| 迁移                                       | 应用状态                                |
| ------------------------------------------ | --------------------------------------- |
| 0001 → 0028（含 0002.1 / 0003.5 / 0003.6） | ✅ 漂移前已应用(库长期在 0028 稳定运行) |
| 0029 / 0030                                | — 从不存在(重编号时跳号,无此文件)       |
| 0031-adhoc-set-logs                        | ✅ 2026-07-10 手动应用(DMS)             |
| 0032-init-session-reviews                  | ✅ 2026-07-10 手动应用(DMS)             |
| 0033-algo-foundation-schema                | ✅ 2026-07-10 手动应用(DMS)             |
| 0034-imported-history-assumed              | ✅ 2026-07-10 手动应用(DMS)             |
| 0035-attachment-lifecycle                  | ✅ 2026-07-10 手动应用(DMS)             |
| 0036-notification-outbox                   | ✅ 2026-07-10 手动应用(DMS)             |
| 0037-add-plan-day-shifts                   | ✅ 2026-07-10 手动应用(DMS)             |
| 0038-whole-plan-shift                      | ✅ 2026-07-12 手动应用(DMS,David)       |

**当前 staging schema head = 0038。**

## 变更历史

- **2026-07-12** — 应用 0038-whole-plan-shift(spec 054 顺延 V2,#57):`plan_day_shifts` 加
  `batch_id`/`created_at`,唯一约束改 (plan_day_id, batch_id) 支撑撤销。DMS 执行成功(4 语句 9ms);
  事后 schema 校验:两新列 + 两新索引(`plan_day_batch_uidx` / `batch_created_idx`)在,
  旧约束 `plan_day_shifts_plan_day_id_key` 已删。⚠️ 下一批 0039(多设备会话,PR #59)合并后同款流程。
- **2026-07-10** — 补齐 0031→0037(共 7 个)根治部署漂移。应用前先做 RDS 全量快照
  (恢复点 18:07:34);逐个 DMS 执行、每个 `SET search_path TO public;`;事后 schema 校验
  (set_logs 4 新列 / 7 新表 / 6 枚举全在)+ curl 验证 `POST /sets/log` 500→201。

## SAE 镜像部署记录（同为手动步骤,滚镜像后追加一行）

- 2026-07-12 — `sha-e87ffac`(=staging HEAD,#57 顺延 V2 + #58 plan-web input-guard)部署
  `meetpr-backend-staging`;env 未动(FORCE_HTTPS 不开 / AUTH_ALLOW_LEGACY_TOKENS 不关);
  **先应用 0038 迁移再滚镜像**。curl 验证:/health 200、`POST/DELETE /plans/:id/shift` 404→401/403
  (带号探测返 NOT_PLAN_STUDENT,证事务写新列成功)、旧 V1 天级端点 404(已替代)、既有端点
  (/students/:id/plans、/exercises、/me/password、/auth/refresh)全绿。配套 iOS 1.0(9) 同日发布。
- 2026-07-11 — `sha-4100a00`(=staging HEAD,spec016)部署 `meetpr-backend-staging`;env 未动;
  curl 验证:/health ok、顺延/回顾端点 404→401、/sets/log 正常(此前镜像冻结于 ~2026-06-24)
