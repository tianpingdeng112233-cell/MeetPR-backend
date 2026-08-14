# 039 — 海外三通道登录:Sign in with Apple + Google + 邮箱密码

- **Status: InProgress**(2026-08-14 David 拍板三通道+Resend+不验证;同日终审通过,spec 封板开工)
- **级别**: T3(新身份层 + auth schema 迁移 + 新第三方依赖)

海外版(`com.meetpr.global`,ASC id 6799519592)不出手机号登录,需在**同一 backend、同一 DB**上
新增三条登录通道;国内 phone+password 通道零改动、存量用户零迁移。backend 现状(2026-08-14
origin/staging 实查):auth 仅 phone+password(`src/routes/auth/schemas.ts` PhoneSchema E.164),
`users.apple_user_id` 自 0001 起预留(nullable + partial unique 索引)从未使用,零 email/oauth 代码。

⚖️ 拍板锚(2026-08-14,David):① 登录=SiwA+邮箱密码+Google 三通道,Global track 无手机号;
② 邮件服务=Resend;③ 邮箱注册**不做**邮箱验证,靠忘记密码链路兜底。

## Scope

- 迁移 **0064**(取号 2026-08-14 现场核实:staging head=0063;实装前须按账本
  `MIGRATIONS-APPLIED.md` + open PR 占号重新三源核实,勿照字面建):users 放宽两列 NOT NULL +
  新增 `email` / `google_user_id`;新表 `password_reset_tokens`。纯增量,存量零改写。
- 六个新端点:`POST /auth/apple`、`/auth/google`、`/auth/register-email`、`/auth/login-email`、
  `/auth/forgot-password`、`/auth/reset-password`。session 签发/refresh 完全复用现有 sessions
  基建(0039 多设备会话),响应体与现有 login 同构。
- SiwA/Google identity token 的 JWKS 验签(带缓存)。
- Resend 发送密码重置邮件。
- 账号注销流程对 apple_user_id 非空用户追加 Apple token 吊销(App Review 硬要求)。

**不在范围**(防 scope 膨胀,均为明确不做):

- 跨通道账号合并/关联——同一邮箱在 Apple/Google/邮箱三边=三个独立账号(见 §反接管规则)。
- 邮箱验证(拍板 ③)。
- 国内 app 接入任何新通道;iOS 客户端改动(同波另卡,iOS 仓,依赖 #322 Global build track)。
- 教练自注册(维持恒禁,`REGISTERABLE_ROLES` 不动,海外教练号仍走预置)。

## 迁移 0064

```sql
BEGIN;
SET search_path TO public;

ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;          -- oauth/邮箱用户无手机号
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;  -- oauth 用户无密码
ALTER TABLE users ADD COLUMN email TEXT;                      -- 应用层统一 lowercase+trim 后写入
ALTER TABLE users ADD COLUMN google_user_id TEXT;

CREATE UNIQUE INDEX users_email_key
  ON users (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_google_user_id_key
  ON users (google_user_id) WHERE google_user_id IS NOT NULL;

CREATE TABLE password_reset_tokens (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT         NOT NULL,          -- sha256;明文只出现在邮件链接里,不落库
  expires_at  TIMESTAMPTZ  NOT NULL,          -- 签发 +30min
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens (user_id);

COMMIT;
```

**存量照护(交付红线自查)**:只放宽约束+加空列,不 UPDATE 任何存量行;`UNIQUE(phone)` 对多个
NULL 天然不冲突(Postgres 语义);老客户端全部查询路径不感知新列。应用层新增不变量:
phone / apple_user_id / google_user_id / email **至少存在其一**(建号路径统一校验,不上 CHECK
约束——避免对存量行为做任何断言)。

## 端点契约

全部挂 `/auth`,新端点全部限速(forgot-password 从严:per-email + per-IP)。

| 端点                         | 入参                        | 行为                                                                                                                                                                                                                             |
| ---------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/apple`           | `identity_token`, `role?`   | 验 ES256 @ Apple JWKS,`iss=https://appleid.apple.com`,`aud=APPLE_BUNDLE_ID`;`sub`→`apple_user_id` 查用户。命中→发 session;未命中且无 `role`→`409 REGISTRATION_REQUIRED`(客户端弹角色选择后带 role 重发);带 `role`→建号(受注册闸) |
| `POST /auth/google`          | `id_token`, `role?`         | 验 RS256 @ Google JWKS,`aud=GOOGLE_IOS_CLIENT_ID`,其余同上 find-or-create                                                                                                                                                        |
| `POST /auth/register-email`  | `email`, `password`, `role` | 建号;email 冲突→`409 EMAIL_TAKEN`;密码规则复用现有 PasswordSchema(bcrypt 72 字节上限那套)                                                                                                                                        |
| `POST /auth/login-email`     | `email`, `password`         | 常规校验;失败统一 `INVALID_CREDENTIALS`,不区分「无此账号/密码错」                                                                                                                                                                |
| `POST /auth/forgot-password` | `email`                     | 恒 `204`(不暴露账号存在性);仅当账号存在**且为邮箱通道**(password_hash 非空)才发 Resend 邮件,链接含一次性明文 token                                                                                                               |
| `POST /auth/reset-password`  | `token`, `new_password`     | 校验未用未过期→写新 hash + 标记 `used_at` + 吊销全部 sessions(复用改密语义)                                                                                                                                                      |

- 注册角色沿用 `REGISTERABLE_ROLES`(coach 不在内)。
- OAuth 建号时 provider 附带的邮箱写入 `email` 列作联系邮箱;若已被占用则存 NULL(见反接管规则)。
- Apple 首次授权返回的 name/email 只在首次给,实装须在建号请求里由客户端透传(iOS 卡的契约点)。

## 反接管规则(重点审)

邮箱注册不验证 ⇒ **任何「同邮箱自动关联」都是账号接管漏洞**(攻击者先用受害者邮箱注册占号,
受害者后来走 SiwA/Google 若被并入该账号,数据即落攻击者手中)。故:

- 三通道互不关联,provider uid(`apple_user_id` / `google_user_id` / `email`)是唯一身份键。
- OAuth 建号遇 provider 邮箱已被占用 → 新账号 `email` 存 NULL,不报错不阻塞(只损失联系邮箱)。
- Apple「Hide My Email」中继地址当普通邮箱对待。

## 注册闸

现有 `REGISTRATION_ENABLED` + `REGISTRATION_ALLOWLIST`(手机号精确匹配)只管 phone 通道,不动。
新通道不复用手机号 allowlist,新增独立总闸 **`INTL_REGISTRATION_ENABLED`**(default `false`;
海外内测开 true);不做邮箱 allowlist(海外形态=正式发布开放注册)。

## JWKS 与外部依赖

- Apple/Google JWKS 拉取带 24h 缓存;token `kid` 未命中缓存时强制刷新一次再判失败。
- JWKS 拉取失败 → `503`,**不降级放行**。
- Resend 调用失败:forgot-password 仍回 `204`(不暴露),错误进日志与告警。
- Apple token 吊销(注销流程):`POST https://appleid.apple.com/auth/revoke`,client_secret=用
  **Sign in with Apple key(.p8)** 签的 ES256 JWT。这把 key 与 APNs key `6PMU9UXHAD` **不是一回事**,
  需 David 在 developer 后台新建(人工前置)。吊销失败不阻塞注销主流程,记日志重试。

## env 新增

`APPLE_BUNDLE_ID` / `GOOGLE_IOS_CLIENT_ID` / `RESEND_API_KEY` / `EMAIL_FROM` /
`SIWA_KEY_ID` / `SIWA_TEAM_ID` / `SIWA_PRIVATE_KEY` / `INTL_REGISTRATION_ENABLED`。
凭证只进部署 env,不入卡不入仓;`.env.example` 补占位注释。

## 测试

- JWKS 验签用本地生成的 mock key 对签,不打真 Apple/Google。
- 迁移测试跟 0064(存量 phone 用户行为不变 + 新列约束)。
- e2e:三通道注册→登录→refresh→改密吊销全链;forgot-password 不暴露存在性(有号/无号/oauth 号三态同响应);同邮箱抢占三条路径(邮箱先占→SiwA 后来 / SiwA 先占→邮箱后来 / Google×Apple 同邮箱)全覆盖。
- 限速命中路径。

## David 人工前置(提前预警)

1. developer 后台新建 Sign in with Apple key(.p8)并交付到部署 env。
2. Google Cloud console 建 iOS OAuth client,拿 `GOOGLE_IOS_CLIENT_ID`。
3. Resend 注册 + 发信域 DNS(建议 `mail.meetpr.app`,SPF/DKIM 三条,Namecheap)。
4. `com.meetpr.global` 在 developer 后台勾 Sign in with Apple capability。
