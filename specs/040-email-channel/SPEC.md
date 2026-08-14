# 040 — 海外 W2:发信通道(忘记密码)+ Apple 注销吊销

- **Status: Draft**(2026-08-14 起草待终审;W1=#241 已上线 staging 后的第二波)
- **级别**: T2(单模块 auth 面 + 一条 additive 迁移 + 零新 npm 依赖)

W1(#241,已合并部署)交付了三通道登录但明确不含发信;当前**邮箱注册用户忘记密码=永久锁死**,
且 SiwA 用户注销账号不吊销 Apple token(App Review 5.1.1(v) 硬要求)——这两个都是 #241 收货审查
里点名的漏排项,W2 一并补齐。邮件服务=⚖️08-14 拍板 **Resend**;邮箱注册不做验证的拍板不变,
`email_verified_at` 本波仍无写路径。

## Scope

- 迁移 **0065**(取号 2026-08-14 现场核实:staging head=0064,open PR 零占号;实装前照例重新三源核实):
  新表 `password_reset_codes` + `user_identities` 加列 `apple_refresh_token`。纯增量,存量零改写。
- 两个新端点:`POST /auth/email/forgot`、`POST /auth/email/reset`(命名与 W1 的
  `/auth/email/register|login` 对齐)。
- Resend 发信服务(`src/services/mail.ts`,直接 `fetch` Resend REST API,不引 SDK——与 oidc.ts
  用裸 fetch 同风格,零新依赖)。
- `/auth/apple` 请求体新增**可选** `authorizationCode`:有则向 Apple 换 refresh token 存库,供
  日后吊销(iOS 未实装,契约改动零成本;W1 的 `.strict()` schema 本波放行该新键)。
- `DELETE /me`:删号前对带 Apple 身份的用户 best-effort 调 `appleid.apple.com/auth/revoke`。

**不在范围**:邮箱验证(拍板不做);改密链路本身(已存在);W1 遗留 follow-up(phone login 行锁、
auth 全面专属限速——forgot/reset 的专属限速**在**本波内,见 §限速);W3 教练试用期;W4/W5 客户端。

**协调点**:open PR #110(spec 011,DELETE /me 改匿名化)同样动删号语义。本 spec 的吊销钩子写成
「删号动作前置步骤」,与硬删/匿名化正交;若 #110 先合,实装时把钩子挂在其匿名化路径前,不冲突。

## 为什么用 6 位数字码而不是链接(设计变更,请终审确认)

spec 039 原稿写的是「邮件里带一次性 token 链接」。链接需要一个**能输入新密码的网页**——海外线
没有这个前端(plan-web 是教练端,iOS W4 未建),为一个重置页开前端工程不值。改为:邮件发
**6 位数字码**,用户回 app 里输入「码 + 新密码」完成重置。纯 app 内闭环,无网页依赖,也是移动端
主流做法。安全补偿(码空间小):10 分钟过期 + 单码最多 5 次尝试 + 专属限速,见下。

## 迁移 0065

```sql
BEGIN;
SET search_path TO public;

CREATE TABLE IF NOT EXISTS password_reset_codes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT        NOT NULL,             -- sha256;明文只进邮件
  expires_at TIMESTAMPTZ NOT NULL,             -- 签发 +10min
  attempts   INTEGER     NOT NULL DEFAULT 0,   -- 达 5 即作废
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_reset_codes_user_id_idx
  ON password_reset_codes (user_id);

-- Apple 授权码换来的 refresh token,唯一用途是注销时吊销。
ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS apple_refresh_token TEXT;

COMMIT;
```

## 端点契约

| 端点                      | 入参                           | 行为                                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/email/forgot` | `email`                        | **恒 `204`**(不暴露账号存在性)。仅当该邮箱是 email-provider 身份时:作废该用户所有未用码 → 生成 6 位随机码(`randomInt`)→ 存 sha256 → Resend 发信。Resend 失败仍 204,错误进日志                                                                                                      |
| `POST /auth/email/reset`  | `email`, `code`, `newPassword` | 查该用户最新未用未过期码;`attempts+1` 先行落库;哈希比对通过 → 写新 `password_hash`(复用 PasswordSchema/BCRYPT_COST)+ 标记 `used_at` + **吊销全部 sessions**(与改密同语义)→ `204`。任何失败(无码/过期/码错/超次)统一 `401 AUTH_INVALID_RESET_CODE`                                  |
| `POST /auth/apple`(扩展)  | + `authorizationCode?`         | 登录/建号流程不变;当 SIWA env 齐备且带 code:向 `appleid.apple.com/auth/token` 换 token(client_secret=ES256 JWT,kid=`SIWA_KEY_ID`/iss=`SIWA_TEAM_ID`/sub=`APPLE_CLIENT_ID`/aud=`https://appleid.apple.com`),把 `refresh_token` 存到该 apple 身份行。**换取失败只记日志,不影响登录** |
| `DELETE /me`(扩展)        | —                              | 删号前:该用户存在 apple 身份且有 `apple_refresh_token` 且 SIWA env 齐备 → `POST /auth/revoke`(`token_type_hint=refresh_token`)。**best-effort:吊销失败记日志照常删号**,不给用户加失败态                                                                                            |

## 限速(本波内,forgot/reset 专属)

- `forgot`:per-email 3 次/小时 + per-IP 10 次/小时(超限仍回 204,静默不发信)。
- `reset`:per-email 10 次/小时(叠加单码 5 次尝试上限)。
- 全局限速不动;更大的 auth 专属限速仍留 follow-up。

## 邮件内容(Resend)

- From:`MeetPR <no-reply@…>`(域名与 `EMAIL_FROM` env 一致,发信域 DNS=David 人工件)。
- Subject:`Your MeetPR password reset code`。
- 正文纯文本 + 简单 HTML 双份:码 + 「10 分钟内有效;不是你本人操作可忽略」。英文,不做多语言
  (海外线 primary=en;文案随英文化波统一复审)。

## env 新增(全部 optional,fail-safe)

`RESEND_API_KEY` / `EMAIL_FROM` / `SIWA_KEY_ID` / `SIWA_TEAM_ID` / `SIWA_PRIVATE_KEY`。

- Resend 两件未配:forgot 仍恒 204,只记 warn(不发信)。
- SIWA 三件未配:跳过换 token 与吊销,只记 warn。登录/删号主流程永不因此失败。
- 凭证只进部署 env;`.env.example` 补占位。SIWA 私钥经 env 注入(SAE runtime),不落文件不入仓。

## 测试

- mail/Apple token 端点全部 mock fetch(与 oidc.test 同法),不打真外网。
- 迁移测试跟 0065(干净库 + 重入)。
- e2e:forgot→reset happy path(新密码可登录、旧 session 全吊销);码错 5 次作废;过期码;
  非 email-provider 账号与不存在邮箱 forgot 同响应同耗时形态;reset 后旧码不可重用;
  authorizationCode 换 token 成功/失败两态(失败不阻塞登录);DELETE /me 吊销成功/失败/未配置
  三态均完成删号;限速命中路径。

## David 人工前置(与 W1 人工四连合并做)

1. Resend 注册 + `RESEND_API_KEY`;发信域 DNS 三条(SPF/DKIM)——⚠️ 08-14 下午起 meetpr.app 的
   DNS 已在 **Cloudflare**(不是 Namecheap),记录加在 Cloudflare 侧。
2. developer 后台新建 **Sign in with Apple key**(.p8,与 APNs key 6PMU9UXHAD 不是同一把),
   产出 SIWA 三 env。
