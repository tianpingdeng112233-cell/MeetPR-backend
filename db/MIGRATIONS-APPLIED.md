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

| 迁移                                            | 应用状态                                                                                                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 → 0028（含 0002.1 / 0003.5 / 0003.6）      | ✅ 漂移前已应用(库长期在 0028 稳定运行)                                                                                                                                                            |
| 0029-init-events / 0030-init-analytics-feedback | ✅ 2026-07-13 手动应用(DMS,David)                                                                                                                                                                  |
| 0031-adhoc-set-logs                             | ✅ 2026-07-10 手动应用(DMS)                                                                                                                                                                        |
| 0032-init-session-reviews                       | ✅ 2026-07-10 手动应用(DMS)                                                                                                                                                                        |
| 0033-algo-foundation-schema                     | ✅ 2026-07-10 手动应用(DMS)                                                                                                                                                                        |
| 0034-imported-history-assumed                   | ✅ 2026-07-10 手动应用(DMS)                                                                                                                                                                        |
| 0035-attachment-lifecycle                       | ✅ 2026-07-10 手动应用(DMS)                                                                                                                                                                        |
| 0036-notification-outbox                        | ✅ 2026-07-10 手动应用(DMS)                                                                                                                                                                        |
| 0037-add-plan-day-shifts                        | ✅ 2026-07-10 手动应用(DMS)                                                                                                                                                                        |
| 0038-whole-plan-shift                           | ✅ 2026-07-12 手动应用(DMS,David)                                                                                                                                                                  |
| 0040-exercise-competition-stance                | ✅ 应用时点未见于账本(早于对账);2026-07-16 对账发现已在库并补记                                                                                                                                    |
| 0039-multi-device-sessions                      | ✅ 2026-07-17 手动应用(psql,Claude)                                                                                                                                                                |
| 0041-init-activity-ledger                       | ✅ 2026-07-17 手动应用(psql,Claude)                                                                                                                                                                |
| 0042-init-device-tokens                         | ✅ 2026-07-17 手动应用(psql,Claude)                                                                                                                                                                |
| 0044-add-admin-role                             | ✅ 2026-07-18 手动应用(DMS,David;执行成功 5 条语句)                                                                                                                                                |
| 0045-init-chat                                  | ✅ 2026-07-22 手动应用(DMS,David;执行成功 11 条语句)                                                                                                                                               |
| 0046-add-feedback-video-id                      | ✅ 2026-07-22 手动应用(DMS,David;执行成功 4 条语句)                                                                                                                                                |
| 0049-add-users-is-test                          | ✅ 2026-07-23 手动应用(DMS,David;执行成功 5 条语句,标记 2 个 seed 账号)                                                                                                                            |
| 0051-add-message-set-ref                        | ✅ 2026-07-28 手动应用(DMS,David;详见下方 sha-e2f32b2 部署条目,此行为表格回补)                                                                                                                     |
| 0052-add-set-log-coach-rpe                      | ✅ 2026-07-28 手动应用(psql 本地→RDS xo 外网,Claude;ALTER+CHECK,information_schema 验证列与约束在)                                                                                                 |
| 0054-video-markers                              | ✅ 2026-07-31 手动应用(psql 本地→RDS xo 外网,Claude;CREATE TABLE+INDEX,to_regclass/pg_indexes 验证表与索引在)                                                                                      |
| 0055-marker-annotation-attachment               | ✅ 2026-08-01 手动应用(psql 本地→RDS xo 外网,Claude;详见下方 sha-3ebd9c7 部署条目,此行为表格回补)                                                                                                  |
| 0056-promote-barbell-bench-main-lift-variation  | ✅ 2026-08-02 手动应用(psql 本地→RDS xo 外网,Claude;UPDATE 1 行 + 存在性护栏,SELECT 验证两条卧推口径正确)                                                                                          |
| 0057-sequence-progression                       | ✅ 2026-08-07 手动应用(DMS SQLConsole,David;7 条语句全成:completions 表+索引+plans.published_at+存量回填,推进制 W1)                                                                                |
| 0058-intensity-system                           | ✅ 2026-08-09 手动应用(psql 本地→RDS xo 外网,Claude;7 条 ALTER 全成,information_schema 验七列类型+两 CHECK 到位,spec 034 W1)                                                                       |
| 0059-backfill-sequence-completions              | ✅ 2026-08-10 手动应用(psql 本地→RDS xo 外网,David;`INSERT 0 393` + COMMIT——P0 修复:0057 未回填换制前历史完成,1.0(18) 学员游标回卷 W1;详见下方 sha-81d4ad6 部署条目)                               |
| 0060-plan-anchor-weekday                        | ✅ 2026-08-10 手动应用(DMS SQLConsole,David;5 条语句全成:plans.anchor_weekday SMALLINT + 1-7 CHECK,spec 037 W0。注:Claude 本机 psql→RDS xo 外网当日起连接超时,疑白名单/本机 IP 变动,故回 DMS 通道) |
| 0061-plan-exercise-target                       | ✅ 2026-08-10 手动应用(DMS SQLConsole,David;5 条语句全成:plan_exercises.target TEXT + 长度 1-32 CHECK,spec 037 v1.1。⚠️v1.2 已翻案改回派生徽章,字段休眠无写入方,留作后手)                          |
| 0062-video-coach-viewed                         | ✅ 2026-08-11 手动应用(psql 本地→RDS xo 外网,Claude;BEGIN/SET/ALTER/UPDATE 5/COMMIT 全成,attachments.coach_viewed_at TIMESTAMPTZ + 反馈/打点存量回填 5 条,information_schema 验列在,spec 038)      |

> 号段说明:0039 曾被未合的 PR #59(多设备会话)占号,期间 0038 直跳 0040;#59 于 2026-07-17 合并后 0039 落库,号段现已连续(0029/0030 为历史补号)。0043 现由 open PR #77/#79(账本扩展)占号,0044 先行落库,库内号段暂跳 0043——#77/#79 合并应用后回续。0047 已被 open PR #95、0048 已被 #99 占用,因此下一份空号取 0049。

**当前 staging schema head = 0062（此行 2026-08-11 更新;0043 缺位由 open PR #77/#79 占,0047 由 open PR #95 占,0048 由 #99 占,0050 由 open PR #110 占,合并应用后回续;0053 空号未用)。**
(此行 2026-08-02 修正:此前长期停在 0052,0054/0055 只记在变更历史漏更此行。)

## 变更历史

- **2026-08-11** — `sha-10f0db0`(=staging HEAD,#231 纯 web/ 换装:plan-web main@#84——David 反馈
  当日落地:追踪卡标题中文化(e1RM 趋势/容量趋势/平均 RPE 趋势/强度趋势/强度分布/次数分布/
  三项容量占比/体重),卡列表两列改单列一行一卡三 lift 图,图表 aspect-ratio 等比放大不拉扁)。
  同源 base(`VITE_API_BASE=''`)过闸。无迁移无 src 改动,schema head 仍 0062。经
  deploy-staging.yml(`migrations_applied=true`)部署,curl 验证:GET / 已回新入口
  index-CEt2pdyy.js。

- **2026-08-11** — `sha-5082c3e`(=staging HEAD,#229 纯 web/ 换装:plan-web main@#83 追踪图
  PowerSheets 式明暗/虚线/光幕——折线光幕渐变+glow+跨无记录日历周虚线段(含 Codex loop 抓出的
  共享槽位漏判修复),柱状图纵向明暗渐变,卡底图注)。前置 #228 首次换装被 build-push-staging 的
  same-origin 闸门拦下(产物误用 dev `/api` base,镜像未推),#229 以 `VITE_API_BASE=''` 重打
  同源包后过闸。无迁移无 src 改动,schema head 仍 0062。经 deploy-staging.yml
  (`migrations_applied=true`)部署,curl 验证:GET / 已回新入口 index-BQfkdoj-.js。

- **2026-08-11** — `sha-20ed5f7`(=staging HEAD,#223 纯 web/ 换装:plan-web main@881dfee = #82
  plan-web SPEC-038——追踪图横纵坐标轴+数据点常显数值;编排页已打卡行在强度/重量目标格下
  逐组显示学员实际完成,超阈红(重量±5kg/RPE±1/%±5pp)/力竭红/阈内黄。build 含 #81 viewed
  徽章为超集,顺带补齐 #222 的部署。经 deploy-staging.yml(`migrations_applied=true`)部署,
  无迁移无 src 改动,schema head 仍 0062。curl 验证:GET / 已回新入口 index-DinRWxUa.js(200)。
  注意:backend 仓另有「spec 038 = 视频徽章」,与 plan-web docs/SPEC-038 系两仓独立序号,勿混。

- **2026-08-11** — **0062 应用 + spec 038 全链路两连部**(视频「待审」徽章真观看语义,教练实测反馈当日修):
  psql 外网通道当日恢复(8/10 的超时未复现),先 `pg_dump` 全量备份(882KB,backups/…pre-0062)再应用 0062
  (回填命中 5 条历史视频)。部署 ①`sha-4de1481`(#220 backend:POST /videos/:id/viewed + 列表 viewed_at);
  ②`sha-7797535`(#222 web/ 换装,入口 index-D1139j5y.js)。中途两坑收档:#221 bundle 忘带
  `VITE_API_BASE=''` 被镜像门禁拦下(门禁工作正常);`gh run watch | tail` 吞退出码把 cancelled 构建
  报绿——用 `gh run view --json conclusion` 查真值,别信管道退出码。

- **2026-08-11** — `sha-7a18981`(=staging HEAD,#218 纯 web/ 换装:plan-web main@495efa4 = #80
  选中日页眉学员画像全量内联(未选动作/未绑定/填写完整三态)+动作态历史深度(次数 PR 表/
  逐组明细折列/组数桶最近 2 次)+名字防压裁、e1RM 缺失回退登记 1RM、组序号从 1 起)经
  deploy-staging.yml(`migrations_applied=true`)部署。无迁移、无 src 改动,schema head 不变(0061)。
  curl 验证:GET / 已回新入口 index-BWIPt9_J.js(与本地 VITE_API_BASE='' 产物一致,200)。env 未动。

- **2026-08-10** — `sha-7207ab6`(=staging HEAD,#217 纯 web/ 换装:plan-web main@1dd146f = #79
  拆除跨周并集幽灵行——David 真数据否决空槽设计,每天只渲染本周实际动作行,拖拽/剪贴板回归
  本周内)经 deploy-staging.yml 部署。无迁移、schema head 不变(0061)。
  curl 验证:入口 index-DASrgeqd.js 与本地构建一致。env 未动。当日周带第四次换装。

- **2026-08-10** — `sha-cd8876c`(=staging HEAD,#216 纯 web/ 换装:plan-web main@dc5a978 = #78
  周带体验批「训练日序数/休息细条层级/周几全卡/重量语义归重量列(强度五项·重量四态)/加动作与
  主项变式文案/D1 周几创建后锁定+存量逐组差异重量保真」)经 deploy-staging.yml 部署。
  无迁移、schema head 不变(0061)。curl 验证:入口 index-uhIR0-8-.js 与本地构建一致。env 未动。

- **2026-08-10** — `sha-af945b1`(=staging HEAD,#215 纯 web/ 换装:plan-web main@7f8b52d = #77
  周带回滚修复批「吸附整周/周间隔/‹›成对+⌥←→翻周/空槽=本周未安排/老kg行强度列显示固定重量承接/
  门禁任一即可全链」)经 deploy-staging.yml(`migrations_applied=true`)**重新上线周带编辑器**。
  无迁移、schema head 不变(0061)。curl 验证:入口 index-KpiD4wJS.js 与本地构建一致。
  **线上复查**:老 kg 行=固定重量+kg、老逐组 RPE 行=原值 7/8/9、空槽=本周未安排;
  打开存量计划除登录外全 GET 零写入(二次实证)。David 预览终验通过后上线。env 未动。

- **2026-08-10** — **回滚**:`image_sha=27e7131`(web=index-C3cacWwY,spec 034 v2.1 全景网格)经
  deploy-staging.yml 指定镜像重部署,覆盖 sha-3525216 的周带编辑器上线。原因:David 真数据走查,
  周带在两周交界滚动位+并集空槽的呈现被读成「组/次/重量丢失」(数据经核实完好:页眉统计来自
  服务端行数据、打开零写入已实证)——判定为设计缺陷即刻回滚,修复吸附/空槽样式后再重上。
  staging 代码分支不动(main/staging 仍含周带,仅线上镜像回退)。curl 验证:入口已回 C3cacWwY。

- **2026-08-10** — `sha-3525216`(=staging HEAD,#214 纯 web/ 换装:plan-web main@c9cf233 = #76
  spec 037 周带编辑器全批「横向周带+scroll-spy/冻结骨架对齐/派生徽章贴名/页眉集成上下文/
  七天全摆休息派生/D1 周几锚全链」)经 deploy-staging.yml(`migrations_applied=true`)部署
  `meetpr-backend-staging`。无迁移、schema head 不变(0061)。产物 origin/main 构建、
  pre-commit 未改字节(cmp 核过);curl 验证:GET / 回新入口 index-BaT3Mab4.js。
  **数据红线实测**:测试教练号线上打开存量 12 周计划,网络面板除登录外全 GET 零写入
  (存量行 reconcile 零写入契约活体实证)。env 未动。

- **2026-08-10** — `sha-27e7131`(=staging HEAD,#212 spec 037 v1.1 plan_exercises.target 三写路径 + 各 docs)经
  deploy-staging.yml(`migrations_applied=true`)部署 `meetpr-backend-staging`。
  **先应用 0061 再滚镜像**(DMS SQLConsole,David;schema head 0060→0061)。
  注:target 字段随 v1.2 翻案(目标列回派生徽章)成为休眠列,plan-web 不写入;字段保留防
  未部署代码 INSERT 引用缺列 500,亦留将来复用。curl 验证:/health 200。env 未动。

- **2026-08-10** — `sha-38587bb`(=staging HEAD,#211 spec 037 W0:plans.anchor_weekday D1 周几展示锚)经
  deploy-staging.yml(`migrations_applied=true`)部署 `meetpr-backend-staging`。
  **先应用 0060 再滚镜像**(DMS SQLConsole,David;schema head 0059→0060)。
  curl 验证:/health 200、登录 200;纯 API 冒烟因测试教练号无绑定学员止步于建计划
  (TRAINEE_NOT_FOUND),PATCH 活体验证归 spec 037 W1 预览走查。env 未动。
  ⚠️ 本机 psql→RDS xo 外网通道当日失效(TCP 通、PG 层超时,疑白名单/IP 变动),迁移改走 DMS。

- **2026-08-10** — `sha-d0e7777`(=staging HEAD,#210 纯 web/ 换装:plan-web main@f5b1e6d = #75
  spec 034 强度体系全量扩展 v2.1「强度列六选一+独立重量列+值层逐组化」;同车 #209 spec 037 文档)经
  deploy-staging.yml(`migrations_applied=true`)部署 `meetpr-backend-staging`。无迁移、schema head 不变
  (0059)。产物从 origin/main 以 VITE_API_BASE='' 构建,pre-commit prettier 未改产物字节(cmp 逐字节核过);
  curl 验证:GET / 回新入口 index-C3cacWwY.js(与本地 dist 一致)。env 未动。

- **2026-08-09** — `sha-cc9fada`(=staging HEAD,#206 spec 034 v2.1 稀疏逐组值放行:单值强度模式
  「该组强度或重量至少其一」,plan-web W2 互审跨契约 BLOCKER 的 backend 配套)经
  deploy-staging.yml(`migrations_applied=true`)部署 `meetpr-backend-staging`。
  无迁移、schema head 仍 0058;本次按 bd21805 教训先等镜像进 ACR 再 dispatch,一次绿。
  curl 验证:/health 200。env 未动。当日第四次部署。

- **2026-08-09** — `sha-9dc948e`(=staging HEAD,#204 纯 web/ 换装:plan-web main@c7caef8 =
  #73 追踪 tab 8 卡教练看板 + #74 花名册 e1RM 徽章列)经 deploy-staging.yml(`migrations_applied=true`)
  部署 `meetpr-backend-staging`。无迁移、schema head 不变。产物与本地 dist 逐字节比对一致后入库;
  curl 验证:GET / 回新入口 index-BHCfiquh.js。当日第三次部署。

- **2026-08-09** — `sha-fabe380`(#202 spec 036 追踪看板聚合:收编 #94 的 e1rm_series/weekly_volume
  基底并新增 weekly_family_metrics/intensity_distribution/rep_distribution,纯读无迁移)经
  deploy-staging.yml(`migrations_applied=true`)部署 `meetpr-backend-staging`。
  首次 dispatch 复踩「镜像未进 ACR」竞态,等 build-push 完成后二次 dispatch 绿(同 bd21805 教训)。
  curl 验证:教练号实测 exercise-stats overview 五个聚合字段齐全。当日第二次部署。

- **2026-08-09** — `sha-bd21805`(=staging HEAD,#203 spec 034 W1 强度体系全量扩展 + #194 spec + 账本)经
  deploy-staging.yml(`migrations_applied=true`)部署 `meetpr-backend-staging`。
  **先应用 0058 再滚镜像**(psql 本地→xo 外网,Claude;schema head 0057→0058):7 条 ALTER 全成,
  information_schema 验七列类型(rpe_low/high→NUMERIC(3,1) 等)+ 两 CHECK(load_mode 六值枚举、
  intensity_values 值域)到位。纯 additive 无数据变更,未做全量备份(同 0052/0054/0055 先例)。
  ⚠️ 部署踩坑记录:第一次 dispatch 失败于「Verify image exists in ACR」——连环合并(#203→#194→账本
  直推)让前两个 sha 的镜像构建被并发组逐个取消,HEAD 镜像尚未建成;等 bd21805 构建完成后二次
  dispatch 即绿。教训:**连环合并后先等最终 HEAD 的镜像进 ACR 再 dispatch 部署**。
  curl 验证:/health 200、/auth/login 空 body 400(非 5xx,登录红线守住)。env 未动。

- **2026-08-08** — `sha-2d148f8`(=staging HEAD,#199 纯 web/ 换装:plan-web 自定义动作新建
  支持选「主项变式」分类,plan-web main@89009f4)经 deploy-staging.yml(`migrations_applied=true`)
  部署 `meetpr-backend-staging`。无迁移、无 src 改动,schema head 不变。
  curl 验证:GET / 已回新入口 index-CcE7XtKu.js(与本地 VITE_API_BASE='' 产物哈希一致)。env 未动。

- **2026-08-02** — `sha-2adbbeb`(=staging HEAD,#188 仅新增迁移 0056 与测试,无 src 改动)经
  deploy-staging.yml(`migrations_applied=true`)部署 `meetpr-backend-staging`。
  **先应用 0056 再滚镜像**(psql 本地→xo 外网,Claude;schema head 0055→0056):
  杠铃卧推(ca70-…01b4)accessory→main_lift_variation/bench,竞技卧推不动;
  UPDATE 1 行,SELECT 验证「竞技卧推=main_lift/bench」「杠铃卧推=main_lift_variation/bench,非比赛」。
  迁移前全量备份 `backups/staging-pre-0056-20260802T120758.sql.gz`(720K,本地)。
  curl 验证:/health 200、/auth/login 空 body 400(非 5xx,登录红线守住)。env 未动。
  ⚠️ 备注:`scripts/backup-db.ts` 在 pg_dump 18 下失效(PGDATABASE 不展开 URL),本次为手动
  `pg_dump "$DATABASE_URL" | gzip` 等价备份,脚本修复已另立任务。

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

- **2026-07-17** — 滚镜像 `sha-0c16428`(#76 auth refresh 接受 snake_case `refresh_token`,治 iOS 全员 15 分钟 token 刷新 400/BindGate 死锁;**零迁移**,schema head 仍 0040)。本次为**一键部署 workflow(#71,spec 018)首跑**,凭证已配,此后部署 `gh workflow run deploy-staging.yml`。同日 OSS 开**传输加速**,SAE env `OSS_ENDPOINT` 改 `https://oss-accelerate.aliyuncs.com` 并再滚一次生效(治海外上传 ~20KB/s 卡 0%)。curl 验证三绿:refresh 探针 400→401、`/uploads/initiate` 签名域名=`meetpr-videos-prod.oss-accelerate.aliyuncs.com`、5MB 分片 PUT 1.7s(~~3MB/s)。⚠️ 探针残留:一次性测试号 `+8613900008871`~~`8875`(self_train_student,无业务数据)+ 数条 1KB/5MB `uploading` 状态 attachments,可按需清理。

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

- 2026-08-11 — `sha-7797535`(=staging HEAD,#222 纯 web/ 换装:plan-web main@3b9fd47 = #81 播放过半即调
  POST /videos/:id/viewed,待审/已反馈徽章按 viewed_at 实时翻转;#221 首枚 bundle 带 dev '/api' base 被
  build-push 门禁拦下未出镜像,本枚 VITE_API_BASE='' 重建)经 deploy-staging.yml(`-f image_sha` 显式指定,
  migrations_applied=true,无新迁移)部署;curl 验证:GET / 回新入口 index-D1139j5y.js、/health 200。
- 2026-08-11 — `sha-4de1481`(=staging HEAD,#220 spec 038:attachments.coach_viewed_at + 幂等
  POST /videos/:videoId/viewed + GET /students/:id/videos 返回 viewed_at)经 deploy-staging.yml
  (migrations_applied=true,**0062 已先行应用**:Claude psql 外网,UPDATE 5 回填)部署;curl 验证:
  /health 200、新端点无 token 401(路由活)、GET / 入口未变(web 换装在后续 sha-7797535)。

- 2026-08-10 — `sha-81d4ad6`(=staging HEAD,#207 **P0 修复**:迁移 0059 推进制换制回填——0057 只建空表未回填历史完成,1.0(18) 外测学员游标回卷 W1,真实学员今日卡显示 7 月计划;镜像对 0058 版零行为差异,纯保持镜像=HEAD)经 deploy-staging.yml(`-f image_sha` 显式指定避开 docs 提交竞态,`migrations_applied=true`,**0059 已先行应用**:David psql 外网,`INSERT 0 393`)部署;curl 验证:`/health` 200、`/auth/login` 空体 400 信封正常。污染盘点(scratch 只读脚本):08-09 后错落到旧训练日的 set_logs **0 条**;manual 结算 1 条(+8613800000011 W1D2,该日本会被回填,无害保留)。修复对客户端即时生效,无需发包。

- 2026-08-01 — `sha-4ec9572`(=staging HEAD,纯 web/ 换装:plan-web 标注改活视频透明图层+发送时定格 #72,
  入口见 curl)经 deploy-staging.yml(migrations_applied=true,无迁移)部署 `meetpr-backend-staging`;
  env 未动。curl 验证:GET / 回新入口(与本地 dist 逐字节一致)。

- 2026-08-01 — `sha-18cf7bd`(=staging HEAD,纯 web/ 换装:plan-web 标注模式锁播控修复 #71,
  入口 index-DyTKlLmV.js)经 deploy-staging.yml(migrations_applied=true,无迁移)部署
  `meetpr-backend-staging`;env 未动。curl 验证:GET / 回新入口。

- 2026-08-01 — `sha-3ebd9c7`(=staging HEAD,两级部署:①#181 打点携带标注帧,**迁移 0055 已先行应用**
  (psql 本地→xo 外网,Claude;schema head 0054→0055,IF NOT EXISTS 幂等,information_schema 验证列在);
  ②纯 web/ 换装 plan-web #70 标注帧挂打点+查看层,入口 index-UFQOFwix.js)经 deploy-staging.yml
  (migrations_applied=true)先后部署 `meetpr-backend-staging`;env 未动。curl 验证:GET / 回新入口。

- 2026-08-01 — `sha-7f223b2`(=staging HEAD,纯 web/ 换装:plan-web 标注自动落打点 #69,
  入口见 curl)经 deploy-staging.yml(migrations_applied=true,无迁移)部署 `meetpr-backend-staging`;
  env 未动。curl 验证:GET / 回新入口(与本地 dist 逐字节一致)。

- 2026-08-01 — `sha-e4a99a5`(=staging HEAD,纯 web/ 换装:plan-web 标注图烙时间胶囊 #68,
  入口见 curl)经 deploy-staging.yml(migrations_applied=true,无迁移)部署 `meetpr-backend-staging`;
  env 未动。curl 验证:GET / 回新入口(与本地 dist 逐字节一致)。

- 2026-08-01 — `sha-d99fd62`(=staging HEAD,纯 web/ 换装:plan-web 标注发图 403 修复 #67——OSS 分片 PUT
  去 Content-Type(签名不含此头,fetch 自动补头致 SignatureDoesNotMatch;含 #66 逐帧可发现性),
  入口 index-9lTi2aPO.js)经 deploy-staging.yml(migrations_applied=true,无迁移)部署
  `meetpr-backend-staging`;env 未动。curl 验证:GET / 回新入口;无头分片管线已在 staging 全程证通。

- 2026-08-01 — `sha-f8d5071`(=staging HEAD,纯 web/ 换装:plan-web 组卡片窄列收缩修复 #65,
  入口 index-CrZLIEdX.js)经 deploy-staging.yml(migrations_applied=true,无迁移)部署
  `meetpr-backend-staging`;env 未动。curl 验证:GET / 回新入口(与本地 dist 逐字节一致)。

- 2026-08-01 — `sha-f2d1306`(=staging HEAD,纯 web/ 换装:plan-web 进度条逐帧微调+滚轮逐帧 #64,
  入口 index-CTnPytH0.js)经 deploy-staging.yml(migrations_applied=true,无迁移)部署
  `meetpr-backend-staging`;env 未动。curl 验证:GET / 回新入口(与本地 dist 逐字节一致)。

- 2026-08-01 — `sha-abc0d79`(=staging HEAD,纯 web/ 换装:plan-web 打磨批次 #63——视频双击全屏/
  组卡片浅色重做/tab 改名「反馈工作区」,入口 index-DqeQM4-y.js)经 deploy-staging.yml
  (migrations_applied=true,无迁移)部署 `meetpr-backend-staging`;env 未动。curl 验证:GET / 回新入口。
- 2026-08-01 — 前一班(同日):纯 web/ 换装 plan-web #62 打点删除幂等修复,入口 index-CBer99oj.js,
  同流程部署并 curl 验证(台账补记)。

- 2026-08-01 — `sha-7628cbb`(=staging HEAD,纯 web/ 换装:plan-web 标注/打点右侧大按钮竖排 #61,
  入口 index-CC1d2EWu.js)经 deploy-staging.yml(migrations_applied=true,无迁移)部署
  `meetpr-backend-staging`;env 未动。curl 验证:GET / 回新入口(与本地 dist 逐字节一致)。

- 2026-08-01 — `sha-696af92`(=staging HEAD,纯 web/ 换装:plan-web 播放器专业化 #60——0.25×/逐帧步进/
  冻结帧标注发聊天+web 聊天发图管线,bundle 4f11908/入口 index-D2sZi7cW.js)经 deploy-staging.yml
  (migrations_applied=true,无迁移)部署 `meetpr-backend-staging`;env 未动。curl 验证:GET / 回新入口
  index-D2sZi7cW.js(与本地 dist 逐字节一致)。

- 2026-08-01 — `sha-bdbb1b0`(=staging HEAD,纯 web/ 换装:plan-web 播放器全屏+进度条拖拽 #59,
  bundle e1bdffb/入口 index-DFNJlZ7J.js)经 deploy-staging.yml(migrations_applied=true,无迁移)部署
  `meetpr-backend-staging`;env 未动。curl 验证:GET / 回新入口 index-DFNJlZ7J.js(与本地 dist 逐字节一致)。

- 2026-08-01 — `sha-3ec80fe`(=staging HEAD,#159 纯 web/ 换装:plan-web 播放器底部三卡换行修复 #58,
  bundle 522fc88/入口 index-6mVfpqw9.js)经 deploy-staging.yml(migrations_applied=true,无迁移)部署
  `meetpr-backend-staging`;env 未动。curl 验证:GET / 回新入口 index-6mVfpqw9.js(与本地 dist 逐字节一致)。

- 2026-07-31 — `sha-d5d1260`(=staging HEAD,#157 纯 web/ 换装:plan-web 学员工作台 #57——消息+训练视频
  合并单一「学员」tab(⚖️07-31 拍板 B),含走查反馈的列表常驻右栏+播放器按需;bundle ec8fe83/
  入口 index-D0QTgMyj.js)经 deploy-staging.yml(migrations_applied=true,无迁移)部署
  `meetpr-backend-staging`;env 未动。curl 验证:GET / 回新入口 index-D0QTgMyj.js(与本地 dist 逐字节一致)。
  同日第四次部署。

- 2026-07-31 — `sha-e9f1d25`(=staging HEAD,#155 纯 web/ 换装:plan-web 打点砍单一档 #56,
  bundle 9e82020/入口 index-kRsJpqIH.js)经 deploy-staging.yml(migrations_applied=true,无迁移)部署
  `meetpr-backend-staging`;env 未动。curl 验证:GET / 回新入口 index-kRsJpqIH.js(与本地 dist 逐字节核对一致)。
  同日第三次部署(aff0c18 打点后端 → ce0b798 e1RM rail 换装 → 本次)。

- 2026-07-31 — `sha-ce0b798`(=staging HEAD,#152 overview 逐 family 滚动 e1RM(零查询无迁移) + #153 纯
  web/ 换装:plan-web 数字带换三大项 e1RM #55,bundle 6db8a32/入口 index-DAt6sO8B.js→index-CsAtFSgW.js)
  经 deploy-staging.yml(migrations_applied=true,无迁移)部署;curl 验证:GET / 回新入口、bundle 含
  「深蹲 e1RM」与「自报」、/plans/nope 仍 401 JSON。overview e1rm 字段 shape 由 769 测试锁定。
- 2026-07-31 — `sha-aff0c18`(=staging HEAD,#150 视频打点存储+教练 CRUD,迁移 0054;#116 重启复活,
  0051→0054 改号)经 deploy-staging.yml(migrations_applied=true)部署 `meetpr-backend-staging`;
  env 未动。**先应用 0054 再滚镜像**(psql 本地→xo 外网,Claude;schema head 0052→0054);
  首次 dispatch 与镜像构建赛跑已取消,等 build-push 完成后重触发。curl 验证:/health 200、
  `GET /videos/:id/markers` 404→401(AUTH_INVALID_TOKEN,路由已在)、/auth/login 正常。
  plan-web 打点 UI(重做波卡5,已在 web/)随本次部署自动点亮。

- 2026-07-31 — `sha-11e0088`(=staging HEAD,#148 纯 web/ 换装:plan-web 撰写上下文栏 #54 + 多行选择
  与批量复制 #52,bundle c6cb170/入口 index-C_RhbZi2.js→index-DAt6sO8B.js)经 deploy-staging.yml
  (migrations_applied=true,无迁移)部署;curl 验证:GET / 回新入口、bundle 内含「改为跟着选中日」
  与 selectedRowIds、旧 exercise-info-tokens 归零、/plans/nope 仍 401 JSON(SPA 未吞 API)。
- 2026-07-29(三) — `sha-e8adf25`(=staging HEAD,#143 纯 web/ 换装:plan-web 聊天视频弹窗样式回归修复
  #50,plan-web main 2ad19f2/入口 index-C_RhbZi2.js + index-iGzXtTky.css)经 deploy-staging.yml
  (`migrations_applied=true`,**无迁移**——与上次部署的 7a79a17 相比只差 `web/`)部署
  `meetpr-backend-staging`;env 未动。curl 验证:GET / 已回新入口(部署绿灯后首次探测即命中)、
  线上 CSS 里 `.video-modal{position:fixed;...z-index:180` 一条在、`/assets/index-C_RhbZi2.js` 200、
  /health 200。反回退比字符串:与线上正在跑的 `index-VbNWE0LL.js`+`index-DIm2g17H.js` 对比,
  995 条中文串**丢 0 增 0**(纯 CSS + 一个 `playsInline` 属性,JS 只差 15 字节),无静默回退。当日第五次部署。
  ⚠️ 同类回归第二起:卡5「训练视频页改内嵌播放器」(`55025cd`)删掉 `index.css` 整块 `.video-modal`
  规则,但聊天页 set-ref 播放仍在渲染 `VideoModal` 组件——类名成孤儿,教练点开视频得到一个
  按原始像素躺在聊天流里的裸 `<video>`。**CSS 孤儿类名是编译期与测试期的双盲区**:tsc 过、466 个
  jsdom 测试全绿(断言的是 DOM 结构不是样式),只有真人点开才看得见。
- 2026-07-29(三) — `sha-7a79a17`(=staging HEAD,#142 纯 web/ 换装:plan-web 撰写上下文面板回归修复
  #51,plan-web main 76ad8d7/入口 index-VbNWE0LL.js + index-CspPujRY.css)经 deploy-staging.yml
  (`migrations_applied=true`,**无迁移**——与上次部署的 c58b7d9 相比只差 `web/` 与本账本)部署
  `meetpr-backend-staging`;env 未动。curl 验证:GET / 已回新入口,线上产物里
  「学员画像 · ONBOARDING」「登记 1RM」「后端滚动值」「次数 PR」「显示撰写上下文」等串都在。当日第四次部署。
  ⚠️ **这次修的是一次静默回归**:plan-web `cb1a40f`(card 3 编辑器重做)删掉了 `<WritingContextPanel>`
  的挂载但留下文件——编译过、测试绿(该文件的单测只覆盖纯函数)、Rollup 直接把整个面板连同只有它在用的
  `RmStrip`/`SessionDetail` tree-shake 掉。教练从 `sha-09a5f52`(07-28 10:23 换装)起就没有学员画像/
  次数 PR/e1RM 条/最近训练记录,全程零报错。**换装反回退比对必须比字符串,不能只看 diff 体积**:
  本次比对显示线上包 1032 条中文串丢失 0、恰好找回 card 3 丢掉的 21 条。
- 2026-07-29(三) — `sha-c58b7d9`(#139 纯 web/ 换装:plan-web 训练日选中态修复 #49,
  plan-web main d3c1f28/入口 index-DSxyWe4K.js + index-CspPujRY.css)经 deploy-staging.yml
  (`migrations_applied=true`,**无迁移**——与上次部署的 de9c15a 相比只差 `web/`)部署
  `meetpr-backend-staging`;env 未动。curl 验证:GET / 已回新入口、线上 CSS 里
  `.day.sel{outline:2px solid var(--ink)` 与 `.day input:disabled` 两条规则都在。当日第三次部署。
  换装前对着线上正在跑的 `index-Bi1X1MtJ.js` 逐条比对,912 条中文特征串一条不少,无静默回退。
- 2026-07-29(三) — `sha-de9c15a`(#137 纯 web/ 换装:plan-web spec 029 组卡重设计 #48,
  入口 index-Bi1X1MtJ.js)经 deploy-staging.yml 部署,工作流 12:20 成功。
  ⚠️ **补记**:当时漏了这一行,由下一次换装(`sha-c58b7d9`)回填;账本因此一度落后于线上实际镜像。
- 2026-07-29(三) — `sha-267d61a`(=staging HEAD,#135 spec 029 §11 修订 R3a:`set_ref` v1 就地扩
  四字段(`source`/`set_total`/`reps_max`/`plan_set_id`)+ 计划组四表归属校验 + 机械首行 v2)经
  deploy-staging.yml(`migrations_applied=true`,**本波无迁移**——`messages.set_ref` 是 JSONB,形状
  变化不碰 DDL,0051 两条 CHECK 原样有效)部署 `meetpr-backend-staging`;env 未动。
  curl 验证:/health 200、未带 token 的 POST /conversations/:id/messages 回 401(路由在);
  工作流自带部署后 smoke(health + login route + web bundle)全过。
  ⚠️ 口径备忘:`plan_sets.set_number` 本来就是 **1-based**(0003 `CHECK >= 1`),与 `set_logs.set_index`
  的 0-based **相反**——backend 侧 planned 路径**不 +1**、logged 才 +1;iOS 侧因投影层已转 0-based,
  **两条都 +1**。照搬会把第 2 组发成第 1 组。
  ⚠️ `set_ref` 就地扩 v1 不升版本的前提是「该形状从未发过版」——**随 iOS 1.0(15) 切包即失效**,
  之后再改必须升版本 + 降级路径。
  配套:iOS #287+#288 已合 `release/1.0`(1.0(15) 候选)、plan-web #48 已合 main(**web 换装待做**)。

- 2026-07-28(一) — `sha-60ba916`(=staging HEAD,#125 spec 030 教练 RPE 校准+取消 e1RM 低 RPE 拒收:
  set_logs 加 coach_rpe 列 + PATCH /coach/set-logs/:id/coach-rpe + 统计/PR 检测 coalesce(coach_rpe,rpe) +
  set_logs/videos 响应 additive 补 rpe/coach_rpe)经 deploy-staging.yml(`migrations_applied=true`)部署;
  env 未动。**迁移 0052 已先行应用**(psql 本地→xo 外网,Claude;schema head 0051→0052;
  information_schema 验证 coach_rpe 列 + set_logs_coach_rpe_check 约束在)。镜像先进 ACR 再触发,时序正确。
  curl 验证:/health 200、PATCH coach-rpe 无 token 401(非 404,证新路由在线)、GET / 入口哈希
  index-Da2hn7KC.js 未回退。

- 2026-07-28 — `sha-217088d`(=staging HEAD,#124 纯 web/ 换装:plan-web 墨蓝亮色 UI 重做波合集 #43,
  bundle 203f944/入口 index-Da2hn7KC.js)经 deploy-staging.yml(migrations_applied=true,无迁移)部署
  `meetpr-backend-staging`;env 未动。curl 验证:GET / 回新入口 index-Da2hn7KC.js、/auth/login 空body 400 正常。
- 2026-07-28(一) — `sha-46777db`(=staging HEAD,#120 纯 web/ 换装:plan-web spec 029 C3 组卡渲染 +就地播视频+续签即隐私删除;bundle 7d035ea/入口 index-CXpYh1FE.js + index-D3L8bszw.css)经
  deploy-staging.yml(`migrations_applied=true`,无迁移)部署;env 未动。curl 验证:GET / 回新入口哈希、
  线上 bundle 含「训练分享」×2、/health 200。**本次先等镜像进 ACR 再触发,时序正确**。
- 2026-07-28(一) — `sha-e2f32b2`(=staging HEAD,#117 spec 029 C1 组卡片 backend 原子卡:
  messages 加 set_ref/video_id 两列 + 两条追加 CHECK + partial index + 写路径全套校验 +
  前教练九处隐私闭环)经 deploy-staging.yml(`migrations_applied=true`)部署 `meetpr-backend-staging`;
  env 未动。**迁移 0051 已由 David 经 DMS 应用**(schema head 0049→0051;先迁移后部署,顺序正确;
  DMS 验证:两列 information_schema 可见、messages_set_ref_text_only/messages_video_needs_set_ref/
  messages_video_id_fkey 三约束在)。curl 验证:/health 200、无 token /conversations 401、
  **学员真 token GET messages 200 且 wire 含 set_ref/video_url/video_expires_in 三字段**
  (对既有 image 消息正确全 null)。镜像先于部署已在 ACR(合并时构建),未重踩时序坑。
- 2026-07-27(日) — `sha-4fb71c9`(=staging HEAD,#111 纯 web/ 换装:plan-web 聊天滚动补审 loop 产出
  [plan-web#33];bundle 60216de/入口 index-3BNAfztL.js,CSS 未变仍 index-DLBqI-TP.css)经
  deploy-staging.yml(`migrations_applied=true`,**无迁移**)部署 `meetpr-backend-staging`;env 未动。
  **修掉的是 sha-5bf9792 带上线的一个真缺陷**:自动沉底会触发 `document` 捕获阶段的 scroll 监听,
  而那正是打已读的交互判定所依赖的——闲置教练停在会话底部时,每来一条消息就把自己的交互时间戳
  刷新一次,下一拍轮询即打已读,违反 spec 006 §8.2.25「已读不越权」。现改为程序化滚动 arm 一个
  绑定落点的一次性标记(不用时间窗:长任务会让事件迟到、窗口内真实滚动又被吞)。
  同批修:loadHistory 的高度改在响应返回后采样、轮询 nearBottom 改在合并那一刻现算。
  curl 验证:GET / 回新入口哈希、入口 js 200 且 `"/api"` 0 次 / client.ts marker 1 处 /
  含聊天与 #31 顺延渲染 / 可辨认一次性标记逻辑、/health 200。
  ⚠️ 本次**先等 `Build & push staging image` 完成再触发部署**(上一条 sha-5bf9792 就是没等而首触失败)。
- 2026-07-27(日) — `sha-5bf9792`(=staging HEAD,#108 纯 web/ 换装:plan-web 教练网页端 1:1 聊天
  spec 006 W1——会话列表/线程/输入区、5s 线程轮询 + 30s 收件箱轮询、已读游标、图片只读渲染,
  外加走查抓到的两处滚动修复(重入会话贴底 + 加载更早的锚点保持,原用裸 rAF 会读到过期 scrollHeight);
  bundle 40dc253/入口 index-BpjdY1hI.js + index-DLBqI-TP.css)经 deploy-staging.yml
  (`migrations_applied=true`,**无迁移**)部署 `meetpr-backend-staging`;env 未动。
  curl 验证:GET / 回新入口哈希(非看 workflow 绿灯)、入口 js 200 且含「发起对话」「已送达」
  与 `/conversations`、产物中 `"/api"` 出现 0 次、CSS 含沉底规则、/health 200。
  ⚠️ 首次触发部署失败:合并后立刻触发,`Build & push staging image` 尚未把 sha 推进 ACR,
  「Verify image exists in ACR」直接拒绝(**先校验后动手,线上未被动过**)。
  **合并后必须等镜像构建完成再触发 deploy-staging.yml。**
- 2026-07-24(五) — `sha-cf7029f`(=staging HEAD,#102 纯 web/ 换装:plan-web 学员整体顺延渲染 #31——
  网格按 `shifted_to_date` 显示日期+顺延 badge、TopBar 顺延提示、拖拽搬带顺延天先确认并清快照;
  bundle c4b3316/入口 index-C2dhtVsP.js)经 deploy-staging.yml(`migrations_applied=true`,无迁移)部署
  `meetpr-backend-staging`;env 未动。curl 验证:GET / 回新入口、入口 js 200 且含顺延文案、/health 200、
  /auth/login 空 body 400(校验正常)。
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
- 2026-08-12 — **0063 已应用**(David 本机 psql,外网 xo 域名;应用前 backup-db.ts 全库备份成功——首跑用内网域名超时,教训:本地必须用 `pgm-...rqxo` 外网地址,secrets-pointer 已改)。随后 `sha-e14e09f`(=staging HEAD,#233 spec v2.2 + #234 pct_anchor 实装)部署 `meetpr-backend-staging`,env 未动;deploy run 31625056204 绿。curl 验证:/health 200、/auth/login 400(格式校验活)。读路径 selectAll 缺列免疫、写路径 INSERT 点名 `pct_anchor`——首次真教练保存计划作为最终写入实证,排在 plan-web 锚点选择器 web-swap 走查一并做。
- 2026-08-12 — `sha-b9f19c4`(=staging HEAD,#236 web 换装 plan-web main@33e8bc1 % 锚点选择器 + #237 CI 修复)部署 `meetpr-backend-staging`,env 未动,无新迁移(0063 已在账)。curl 实证:/health 200、入口已换 `assets/index-DN9GjFet.js`(200)。插曲:runner buildx 滚动后默认附 provenance 清单,个人版 ACR 拒收(`unknown manifest class ...oci.empty.v1+json`),连败两次构建;#237 加 `provenance:false + sbom:false` 根治。
