# SPEC 011 — 账号台账:注销 + 改密(backend 半)

- **状态**: Draft(§1 于 2026-07-27 形态修订:直删 → 匿名化删除)
- **来源**: 自己练 Free 档 wave A6;Apple App Review 5.1.1(v) 硬性要求(app 内可发起账号删除)。iOS 半 = spec 048。
- **侦察(2026-07-04)**:①users 直系外键 17 个**全部** ON DELETE CASCADE(级联链完备,单条 DELETE FROM users 即全量清理;set_logs.plan_exercise_id 的 SET NULL 与行级 student_id CASCADE 同删终态一致);②/me 现为 501 stub(GET);③auth 路由无改密端点;④011 空号核实(specs/ 无占用,open PR 无占号)。**无迁移需求**(纯端点)。
- **复议(2026-07-27)**:§1 改为匿名化删除,**需要一个迁移(0050)**。原「无迁移需求」结论仅对 §2 仍成立。

## 1. DELETE /me(注销 = 匿名化删除)

### 1.0 形态修订(⚖️ 2026-07-27 David 拍板)

原口径:事务内 `DELETE FROM users`,靠 17 条 CASCADE 一把清空。
新口径:**`users` 行保留、可识别信息全抹除、训练数据原样留下**。

拍板原话:「不真删,学员的每一条训练数据都有用。」

为什么这样切:

- Apple 5.1.1(v) 要的是「删除而非停用」,审核员会真去点按钮验证。**纯软删**(只打标记、手机号姓名原样留着)是典型驳回情形;**匿名化删除**则是把账号与个人数据真正抹掉,满足合规。
- Apple 管的是账号与个人数据,**不管去标识化之后的训练记录**。sets / e1RM / readiness / 计划 / 聊天指向一个已经无名的 user id,对审核无碍,对产品有用。
- 原「非目标」里把软删除/冷静期列为不做项时已注明「V1 直删,内测期口径,**上架前可复议**」——本次即那次复议。**本条不是软删除/冷静期**:注销即时生效、不可撤销、无恢复通道,只是清理方式从 `DELETE` 换成 `UPDATE`。

**连带效应(重要)**:不再执行 `DELETE FROM users` 之后,`plans.trainee_id` RESTRICT(0003)、`attachments.source_plan_id` / `source_coach_id` RESTRICT(0035)、聊天四条裸外键(0045)**全都不会被触发**。「学员注销后教练写的计划归谁」这道产品难题随之消失。据此 **PR #99(迁移 0048 给聊天外键加 CASCADE)已关闭,迁移号 0048 已释放,不复活**。

### 1.1 契约(不变)

- 鉴权:`requireRole('coached_student', 'self_train_student')`。**coach 仍不开放**:教练的 offboarding 语义(在飞的学员、已发布计划的归属)需单独设计(开放项,不阻塞 Apple 合规——审核针对的是提交的学员端功能面)。
  - ⚠️ **既有偏差(本卡不改,登记备查)**:早稿写 403 `COACH_DELETE_UNSUPPORTED`,实装是 `requireRole` 的通用 403 `AUTHORIZATION_FORBIDDEN`,自上线起一直如此。改错误码属客户端可见的响应变更(硬规则 8),且 coach 端根本不显示注销入口、该路径无人触发,故本卡维持现状、以实装为准。若日后要专有错误码,单独一卡并同步 iOS。
- 成功返回 **204**。
- 幂等:重复调用仍 204(已匿名化的行直接短路返回,不二次改写 `deleted_at`)。

### 1.2 迁移 0050(现场取号:staging 最高 0049,全仓无 0050)

```sql
ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ;   -- NULL = 活账号
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;    -- 释放号码的前提
ALTER TABLE users ADD CONSTRAINT users_phone_present_unless_deleted
  CHECK (deleted_at IS NOT NULL OR phone IS NOT NULL); -- 活账号仍必须有手机号
```

**手机号必须能被同一个人日后重新注册**,所以取「置空」而非「打散」:

- `users_phone_key` 是普通 UNIQUE,Postgres 视 NULL 互不相等,**多行 NULL 天然共存**,不需要改成部分唯一索引。
- 置空 = 号码即刻释放,`POST /auth/register` 拿同一手机号建的是**全新 user id**,与旧行零关联(旧训练数据不会「跟回来」)。
- 不选「打散成 `deleted:<id>` 之类哨兵」:phone 列里放伪手机号,迟早有人当真号用。
- 代价:`UsersTable.phone` 变 `string | null`,波及 3 处(见 §1.5)。

### 1.3 抹除清单(事务内一把做完)

| 表                                                              | 动作                              | 理由                                                                    |
| --------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `users.phone`                                                   | → `NULL`                          | 释放号码,PII 抹除                                                       |
| `users.password_hash`                                           | → 不可用哨兵 `'!anonymized'`      | 凭证痕迹清除;非 bcrypt 串,`bcrypt.compare` 恒 false                     |
| `users.apple_user_id`                                           | → `NULL`                          | 外部身份标识;部分唯一索引允许多 NULL                                    |
| `users.refresh_token_jti`                                       | → `NULL`                          | 迁移 0039 遗留单槽列,仍是 `/auth/refresh` 的 legacy 回填凭证,必须一并清 |
| `users.deleted_at`                                              | → `now()`                         | 注销标记,登录路径据此拒绝                                               |
| `sessions`                                                      | 该 user 全部 `revoked_at = now()` | 撤销多设备会话(0039)                                                    |
| `device_tokens`                                                 | 该 user 全部 **DELETE 行**        | APNs token 是设备标识,且不该再向已注销账号推送                          |
| `coach_profiles.display_name` / `student_profiles.display_name` | → `'已注销用户'`                  | 列 NOT NULL + CHECK(1..100),故置占位而非置空;教练端历史视图仍能渲染     |
| `student_onboarding_profiles.injury_notes`                      | → `NULL`                          | 自填自由文本(伤病描述)                                                  |
| `student_onboarding_profiles.note_to_coach`                     | → `NULL`                          | 自填自由文本(给教练的话)                                                |

**头像**:当前 schema **没有任何 avatar 列**(全仓 grep 无),故本卡无对应动作;日后加头像列时须同步进本清单。

**刻意保留**(去标识化后的训练数据,拍板范围内):`set_logs` / `session_reviews` / `readiness_checkins` / `training_sessions` / `plans` 及其子表 / `feedback` / `messages` / `conversations` / `student_events` / `student_signals` / `bind_requests` / `evaluation_periods` / `student_evaluations`。

**刻意保留(有意识的取舍,非遗漏)**:`student_onboarding_profiles` 的结构化字段(`gender` / `birth_date` / `height_cm` / `weight_kg` / 1RM / 训练环境 / 恢复量表 / `injury_areas` 枚举 token / `target_weight_class`)——这些是算法引擎的输入,且脱离手机号与姓名后不具可识别性。

### 1.4 开放项(本卡不做,登记备查)

- **OSS 对象**:`attachments` 里的训练视频与 onboarding 上传件是**本人出镜**的素材,严格说属可识别信息。本卡只做数据库层匿名化,不删 OSS 对象。Apple 审核不触达 OSS;若日后要做,是独立一卡(需要 OSS 批量删除 + `attachments` 生命周期联动,见 0035)。
- **access token 存活窗口**:`requireAuth` 是纯 JWT 校验、不查库(有意为之,避免每请求一次 DB 往返),所以注销后至多 15 分钟内旧 access token 仍可打接口。与 §2 改密的既有口径一致,不为本卡单独引入每请求查库。iOS 侧注销后立即清 token 并回登录页,窗口不可见。
- **教练注销**:仍未开放,同 §1.1。

### 1.5 实装波及面

- `src/db/types.ts`:`UsersTable.phone` → `NullableColumn<string>`,新增 `deleted_at: NullableColumn<Date>`。
- `src/routes/auth/index.ts`:登录按 phone 查行加 `deleted_at IS NULL`;`/auth/refresh` 三条 session 查询与 legacy 回填查询同样加闸;`ClientUser.phone` **保持非空**(硬规则 8:不破坏在飞客户端的响应形状),用 `row.phone ?? ''` 收口——该路径结构上取不到已注销行。
- `src/handlers/admin.ts`:行类型转 `string | null`,对外 `AdminUser.phone` 仍是 `string`(同上,`?? ''`)。
- `src/handlers/coach-bind-requests.ts`:`maskPhone` 早已接受 `string | null`,零改动。

## 2. PUT /me/password(改密)

- 鉴权:三角色皆可(改密无副作用歧义)。
- Body:`{ old_password, new_password }`,new_password 复用注册的 zod 规则(实施时现场对齐 schemas.ts)。
- 行为:bcrypt 校验 old_password(错 → 403 `PASSWORD_MISMATCH`)→ 一条 UPDATE 同时写新 hash + **清空 `users.refresh_token_jti`**(刷新是单槽 jti 列,置空即撤销在外的 refresh token,与 logout 同习语;当前设备 access token 存活到过期)→ 204。实施更正:早稿「删 refresh_tokens 表」——该表不存在,单槽模型。
- 实施现状(0039 之后):同一事务里同时把 `sessions` 全部置 `revoked_at`,单槽列仅作 legacy 回填凭证清理。

## 非目标

忘记密码(SMS 通道,post-incorporation,接口不预留实现);coach 注销;数据导出(纯客户端,spec 048);**冷静期 / 注销恢复**(注销即时且不可逆——匿名化后无从恢复,这是形态,不是待办);OSS 对象删除(§1.4);注销文案与后果说明(iOS 半,spec 048,若需改文案另提)。

## 测试

- **注销(自练学员,既有用例改口径)**:建 onboarding 数据 → DELETE /me 204 → `users` 行**仍在**且 `deleted_at` 非空、`phone` 为 NULL、`onboarding` 行**仍在**但自由文本已空 → 重复 DELETE 仍 204。
- **注销(coached_student,补测试盲区)**:带**聊天记录 + 计划 + set_logs + device_token** 的绑定学员 → DELETE /me 204 → 断言四件事:
  1. PII 全空(`phone` NULL / `apple_user_id` NULL / `password_hash` 非原值 / `refresh_token_jti` NULL / `student_profiles.display_name` = 占位 / `injury_notes` 与 `note_to_coach` NULL);
  2. token 全失效(`sessions` 全部 `revoked_at` 非空、`device_tokens` 行数 0);
  3. 训练数据行数不变(`plans` / `set_logs` / `messages` / `conversations` 逐表计数与注销前相等);
  4. 手机号可被重新注册(同号 `POST /auth/register` 201,且新 user id ≠ 旧 user id)。
- **coach** → 403(实装为 `AUTHORIZATION_FORBIDDEN`,见 §1.1 偏差登记),`users` 行不变、`deleted_at` 仍空。
- **登录闸**:已注销账号的原手机号+原密码登录 401;同号重新注册后走的是新账号(新 id)。
- **迁移 0050**:跑真 SQL,断言 `deleted_at` 列存在、`phone` 可空、CHECK 拒绝「活账号 + phone NULL」。
- 改密:旧密错 403;成功后旧密登录 401、新密登录 200;refresh token 全清(旧 refresh 换新 401)。
