# Spec 048 · 邮箱注册验证码 + 国内部署接通发信

- Status: Draft
- 来源：David 2026-10-10 「以最新的 rn 安卓端为标准，出 CN 的双端版本」→ /grill 两轮，共识「App 端只用邮箱登录和注册」，最后一题（注册时要不要验证邮箱）答「B」＝要验证。
- 级别／节奏：T2 / P1（新端点 + 一张新表 + 新 env）。合并与部署等 David「放行」。
- 配套：安卓 `meetpr-rn` `specs/091-cn-android-first/SPEC.md`（客户端流程与屏幕）；iOS 交接见该目录 `IOS-HANDOFF.md`。
- 本 spec 只管后端契约。客户端长什么样不在这里定。

## 现状（2026-10-10 现场核实，`origin/staging`）

- `POST /auth/email/register` 填邮箱 + 密码直接建号，`email_verified_at` 写 `null`，不发信。
- 唯一发信点是 `POST /auth/email/forgot`（6 位码，10 分钟，`password_reset_codes` 表按 `user_id` 存）。
- 发信走 Resend（`src/services/mail.ts`），正文只有英文。
- Global 部署配了 `RESEND_API_KEY` / `EMAIL_FROM`（发信域 `send.meetpr.app`）；**国内部署（SAE，杭州）没配**，所以国内现在点「忘记密码」回 204 但不发信。
- 邮箱路由不分轨，国内 staging `121.40.160.241:3000` 上 `POST /auth/email/forgot` 已可达（空 body 回 400）。
- 国内部署的 `SELF_SIGNUP_ROLES` 当前取值未核实——开工时现场核实，须含 `coached_student`。

## 已拍板口径

| 题 | 结论 |
|---|---|
| 注册要不要验证邮箱 | 要（B）。先验码、后建号 |
| 作用范围 | 只在国内部署打开；Global 部署行为一行不变（我定的默认，David 未单独拍，可推翻） |
| 手机号登录接口 | 保留不删，旧 iOS 包与测试号照常能登 |
| 老账号 | 不要求补验证，登录永不以 `email_verified_at` 为闸 |

## §1 开关与配置

新增 env，全部 optional：

- `EMAIL_SIGNUP_VERIFICATION`：`off`（默认）｜`required`。
- `MAIL_LOCALE`：`en`（默认）｜`zh`。决定本部署发出的所有邮件用哪种语言。

启动校验：`EMAIL_SIGNUP_VERIFICATION=required` 而 `RESEND_API_KEY` 或 `EMAIL_FROM` 缺一 → 配置解析失败，进程拒绝启动。理由：开了验证却发不出信等于注册入口静默坏掉，宁可部署失败、旧版本继续跑。

国内部署目标值：`EMAIL_SIGNUP_VERIFICATION=required`、`MAIL_LOCALE=zh`、`EMAIL_FROM` 复用 `send.meetpr.app` 发信域、`RESEND_API_KEY`（David 人工件，只进 SAE 环境变量）。Global 部署不加这两个新 env。

## §2 端点契约

### `POST /auth/email/register/code`（新）

入参 `{ email }`。

- `EMAIL_SIGNUP_VERIFICATION=off` → `404`（Global 上不暴露多余的发信入口）。
- 自助注册整体关闭（`SELF_SIGNUP_ROLES` 为空）→ `403 AUTH_REGISTRATION_DISABLED`。
- 其余一律 **`204`**，不暴露邮箱是否已注册：
  - 邮箱尚无 email 身份 → 作废该邮箱所有未用码 → 生成 6 位随机码（`randomInt`）→ 存 sha256 → 发「注册验证码」邮件。码 10 分钟有效。
  - 邮箱已有 email 身份 → 不发码，改发一封「该邮箱已注册，请直接登录或找回密码」提示信。
  - 发信失败仍回 204，错误进日志（与 forgot 同形态）。
- 限速：per-email 5 次/小时；per-IP 30 次/小时（健身房共用出口，放宽于 forgot 的 10 次）。超限仍回 204，静默不发信。

### `POST /auth/email/register`（扩展）

入参新增可选 `code`（`^\d{6}$`）。

- `off`：`code` 即使带上也忽略，行为与今天完全一致（`email_verified_at` 仍写 `null`）。
- `required`：
  - 校验顺序：body 校验 → `signupError` → 验码 → 建号。
  - 取该邮箱最新一条未用、未过期、`attempts < 5` 的码；`attempts+1` 先行落库；哈希常量时间比对。
  - 缺 `code`／无码／过期／码错／超次 → 统一 `401 AUTH_INVALID_SIGNUP_CODE`。第 5 次错即作废该码。
  - 通过 → 与建号同一个事务里标记 `used_at`，`users.email_verified_at = now()`，其余（身份行、session、返回体）不变。
  - 并发下邮箱被别人抢注 → 沿用 `409 AUTH_EMAIL_TAKEN`。

返回体、错误信封、`role` 规则均不变。

## §3 数据

新迁移（号取开工时 `staging` 最新号 +1，现场核实；046 已占 0071，047 可能占 0072）：

```sql
CREATE TABLE IF NOT EXISTS email_signup_codes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT        NOT NULL,             -- normalizeEmail 之后
  code_hash  TEXT        NOT NULL,             -- sha256;明文只进邮件
  expires_at TIMESTAMPTZ NOT NULL,             -- 签发 +10min
  attempts   INTEGER     NOT NULL DEFAULT 0,   -- 达 5 即作废
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_signup_codes_email_idx ON email_signup_codes (email);
```

- 纯新增表，不动存量列，可重入；回滚＝`DROP TABLE`。
- 存量照护：现有账号 `email_verified_at` 保持原值，无回填。Global 存量用户不受任何影响。
- 清理：每次给某邮箱签新码时顺手删掉该邮箱已过期的旧行，不另起定时任务。

## §4 邮件内容

三封信各出 `en` / `zh` 两版，纯文本 + 简单 HTML 双份，按 `MAIL_LOCALE` 选：

| 信 | zh 主题 | 正文要点 |
|---|---|---|
| 注册验证码 | MeetPR 注册验证码 | 码；10 分钟内有效；不是你本人操作可忽略 |
| 该邮箱已注册 | 你已经有 MeetPR 账号了 | 这个邮箱已注册；请直接登录，忘了密码可在登录页找回；不是你本人操作可忽略 |
| 重置密码验证码（已有，补 zh） | MeetPR 重置密码验证码 | 码；10 分钟内有效；不是你本人操作可忽略 |

英文版重置信文案不改。

## §5 两个老账号补邮箱身份（数据操作，不是代码）

内测真实账号只有一个教练、一个学员，都是手机号账号。给各自补一条 email 身份，使其能用邮箱登录新 App：

- 每个账号：`user_identities` 插一行（`provider='email'`，`provider_uid`=`email_at_provider`=规范化邮箱），`users.email` 写入该邮箱，`email_verified_at = now()`（由 David 提供邮箱并担保）。
- 用户 id、`password_hash`、`phone` 不动——数据一行不搬，密码不变，旧 iOS 包照常用手机号登录。
- 动之前：导出这两行 `users` 与其 `user_identities` 作备份；核对目标邮箱未被占用（`users_email_lower_key`）。
- 回滚：删掉新插的身份行，`users.email` / `email_verified_at` 置回备份值。
- **执行门禁**：脚本与备份先给 David 过目，拿到明确同意再对国内库执行。邮箱由 David 提供。不进任务卡，Opus 陪跑执行。

教练开号改用邮箱：复用 `scripts/provision-coach-global.ts` 的逻辑指向国内库（脚本若写死 Global 连接方式，本卡顺手参数化，不改行为）。

## §6 上线前探针（发信链路）

验证码成了注册的硬依赖，下面两项必须在国内部署上实测通过才能把 `required` 打开：

1. 杭州 SAE 出网能连上 `api.resend.com`（看一次真实发信的日志与 Resend 后台送达记录）。
2. QQ 邮箱、163 邮箱各收一封，进收件箱而不是垃圾箱。

任一不过 → 不开 `required`，另开一张小卡给 `sendMail` 加第二发信商（阿里云邮件推送，每天 200 封免费额度），本 spec 的端点契约不变。

## 验收清单

1. `off` 下 `register` 行为与今天逐字节一致（现有测试全绿，不改断言）；`register/code` 回 404。
2. `required` 下：不带码／错码／过期码／用过的码注册 → 401 `AUTH_INVALID_SIGNUP_CODE`，库里不产生用户。
3. `required` 下：请求码 → 用正确码注册 → 201，`email_verified_at` 非空，能立即用该邮箱密码登录。
4. 同一邮箱重新请求码后，旧码失效。
5. 连错 5 次后，正确的码也不再可用。
6. 已注册邮箱请求码 → 204，不产生码行，发出的是「已注册」提示信。
7. 限速命中时仍回 204 且不发信。
8. `required` 且缺发信 env → 进程启动失败，报错信息指明缺哪一项。
9. `MAIL_LOCALE=zh` 时三封信主题与正文为中文；缺省为英文且重置信与今天一致。
10. 迁移在干净库与重入两种情况下都通过。
11. §6 两项探针在国内部署上有实测证据（日志或截图）。
12. §5 执行后：两个老账号用邮箱 + 原密码登录成功，用手机号 + 原密码也仍然成功，登录后看到的训练数据与执行前一致。

## 测试 seam

- HTTP 路由层（supertest 打 app，与 `tests/auth/email-recovery.test.ts` 同法）：验收 1–7 全在这一层先红后绿。
- 配置解析（`src/config.ts` 的 schema）：验收 8。
- `sendMail` 的 fetch 注入点（与 `tests/services/mail.test.ts` 同法）：验收 9，断言发给 Resend 的主题与正文，不打真外网。
- 迁移测试跟新迁移号（与 `tests/migrations/0065-email-channel.test.ts` 同法）：验收 10。

## Out of Scope

- 给存量未验证账号补验证、或以「已验证」作为任何功能的闸。
- Global 部署打开验证。
- 删除或改动手机号注册／登录接口。
- 短信验证码、第三方登录在国内轨的任何形态。
- 第二发信商（仅当 §6 探针不过才另开卡）。
- 改邮箱、邮箱找回以外的账号恢复手段。

## David 人工前置

1. 把 `RESEND_API_KEY` 加进国内 SAE 的环境变量（值只在 Bitwarden，不入仓、不入卡、不进对话）。
2. 提供教练与学员两个老账号各自要用的邮箱。
