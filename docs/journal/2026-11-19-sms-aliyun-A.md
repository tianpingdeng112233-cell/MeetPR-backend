# 2026-11-19 · 真实短信接入（阿里云短信）· 卡 A

> 先读仓根 `CONTEXT.md` 与 `AGENTS.md`。本卡自包含；本文件同时是本卡的 JOURNAL，交付记录追加在文末「交付记录」节。
> 级别 T2（新外部集成 + 配置项）：PR 开向 `staging`，等 David「放行」，不合并、不部署。

## 目标

把 `src/services/sms.ts` 里的占位 `sendOtp`（永远返回 `000000`、不发短信）换成可切换的实现：

- `SMS_PROVIDER=stub`（**默认**）：行为与今天一致，现网零变化。
- `SMS_PROVIDER=aliyun`：生成随机 6 位验证码，通过阿里云短信服务 `SendSms` 发到手机号，并返回该验证码给调用方（调用方负责哈希入库，现有逻辑不变）。

背景：公司主体已注册，阿里云「企业」短信签名正在申请，签名与模板审核通过前开关保持关闭；代码先合进来，下来后只改环境变量即可启用。唯一调用方目前是教练点评登录（`src/services/coach-reviews/auth.ts`）。

## 文件范围

- `src/services/sms.ts`（主体改动）
- `src/config.ts`（新增配置项与校验）
- `src/services/coach-reviews/auth.ts`（仅在 `sendOtp` 签名变化时做最小适配）
- `.env.example`（新增变量的注释示例，值一律占位）
- 测试：`tests/` 下与 sms / config / coach-reviews auth 对应的测试文件
- 本 JOURNAL 文件

不碰：迁移、路由、前端、部署脚本、其它服务。

## 约束

1. **不新增 npm 依赖**。参照 `src/services/mail.ts` 的写法：用注入的 `fetchImpl: typeof fetch = fetch` 直接调阿里云 HTTP API（RPC 风格，`https://dysmsapi.aliyuncs.com/`，`Action=SendSms`，`Version=2017-05-25`，参数 `PhoneNumbers`、`SignName`、`TemplateCode`、`TemplateParam={"code":"<6位>"}`），按阿里云公开文档实现请求签名（V1 HMAC-SHA1 或 V3 ACS3-HMAC-SHA256 二选一，在 JOURNAL 写明选了哪个、依据哪份文档）。超时 5 秒，与 mail.ts 一致。
2. 验证码用 `node:crypto` 的 `randomInt` 生成，固定 6 位（含前导 0）。
3. 阿里云返回 HTTP 非 2xx 或响应体 `Code !== 'OK'` 时抛错；错误信息里只带阿里云的 `Code`，**不带手机号、不带验证码、不带密钥**。
4. 日志里手机号只允许打掩码形式（如 `138****1234`），验证码与 AccessKey 永远不进日志。现有 stub 的 `logger.warn({ phone })` 一并改成掩码。
5. 新配置项（`src/config.ts`）：
   - `SMS_PROVIDER`：`'stub' | 'aliyun'`，默认 `'stub'`
   - `ALIYUN_SMS_ACCESS_KEY_ID`、`ALIYUN_SMS_ACCESS_KEY_SECRET`、`ALIYUN_SMS_SIGN_NAME`、`ALIYUN_SMS_TEMPLATE_CODE`：可选字符串；当 `SMS_PROVIDER=aliyun` 时四项必填，缺任一项启动校验失败（仿照现有 `EMAIL_SIGNUP_VERIFICATION=required` 的 superRefine 写法）。
   - 安全闸：当 `NODE_ENV=production` 且 `COACH_REVIEWS_ENABLED=true` 且 `SMS_PROVIDER=stub` 时启动校验失败（防止生产上用 `000000` 就能登录点评）。
6. 仓库是 public：`.env.example` 和测试里只能出现明显的占位值，严禁任何真实密钥、签名名或模板号。
7. 不 commit、不 push（沙箱做不了，收货时由 Opus 处理）；改动留在工作树。

## 测试 seam（先红后绿）

优先复用现有 seam，层级尽量高：

1. **`sendOtp` 单元测试**（新，注入假 `fetchImpl`）：
   - `aliyun` 模式：断言请求打到 dysmsapi、带 `Action=SendSms`、`PhoneNumbers`、`SignName`、`TemplateCode`，`TemplateParam` 里的 code 与返回值相同且为 6 位数字，带签名字段；
   - 阿里云返回 `Code: 'isv.BUSINESS_LIMIT_CONTROL'` 等非 OK → 抛错，错误信息不含手机号与验证码；
   - HTTP 500 → 抛错；
   - `stub` 模式：返回 `000000`，不调用 fetch。
2. **配置校验测试**（复用现有 config 测试）：`aliyun` 缺字段失败；生产 + 点评开启 + stub 失败；默认值为 stub。
3. **教练点评登录现有测试**保持全绿（`requestCoachReviewOtp` / `loginCoachReviewer`），证明调用方行为不变。

先把 1、2 写成失败的测试并跑一次确认红，再实现到绿。

## 验收清单

- [ ] `pnpm typecheck && pnpm lint && pnpm test` 全绿，贴结果行数
- [ ] 上述三组测试存在且覆盖所列分支
- [ ] 默认配置下现网行为不变（stub，返回 `000000`）
- [ ] 日志与错误信息中无完整手机号、无验证码、无密钥（grep 自查并在 JOURNAL 写明）
- [ ] `.env.example` 新增五个变量的注释说明，值为占位
- [ ] 无新增依赖（`package.json` / lockfile 未变）
- [ ] JOURNAL「交付记录」写清：签名算法选择与文档出处、改动文件清单、测试输出摘要、未决问题

## Out of Scope

- 用户主登录（邮箱验证码 / 密码）改用短信 —— 不做
- 申请签名与模板、往 SAE 写环境变量、部署 —— David / Opus 另行处理
- 短信发送频控（现有 60 秒冷却 + 每日 10 次已在调用方实现，不动）

## 交付记录

（Codex 在此追加）

### 2026-11-19 · Codex 交付

实现已落在当前 `feat/sms-aliyun` 工作树，基线 `dc90b16`；未 commit、push、开 PR 或部署。未安装新依赖，`package.json` / `pnpm-lock.yaml` 无改动。

**签名选择与依据**

- 采用 **V3 ACS3-HMAC-SHA256**。官方旧 RPC HMAC-SHA1 文档已标记停用，故采用卡片允许的 V3 选项。
- 签名依据：[阿里云《V3 版本请求体 & 签名机制》](https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature)（2026-11-19 核实）：RFC 3986 查询编码、排序请求头、空请求体 SHA256、规范请求摘要及 HMAC-SHA256 Authorization。
- 接口依据：[阿里云《SendSms - 发送短信》](https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms)（同日核实）：HTTPS POST、业务参数放 query，Action / Version 按 V3 协议放 `x-acs-action: SendSms` / `x-acs-version: 2017-05-25`，成功须 HTTP 2xx 且 `Code=OK`。
- 固定向量测试包含中文、空格及 `!'()*~`，预期签名由独立 Python `hashlib` / `hmac` 对手写规范请求计算，不在测试内重新实现签名逻辑。

**改动文件**

1. `src/services/sms.ts`：默认 stub；Aliyun 随机六位码、注入 fetch、5 秒超时、V3 签名；业务/HTTP/网络/响应解析失败均抛脱敏错误；stub 日志只记掩码，非法号码形状统一隐藏。
2. `src/config.ts`：五个配置项、Aliyun 四项必填且非空白、生产点评启用时禁止 stub。沿用既有 Config DI 兼容方式，直接构造配置可省略 provider，`loadConfig` 实体化默认值。
3. `src/services/coach-reviews/auth.ts`：只将现有 config 传给 sendOtp，哈希、冷却、配额及登录逻辑保持原样。
4. `.env.example`：五个变量的注释示例、生产安全闸说明；仅占位凭证、签名名、模板号。
5. `tests/services/sms.test.ts`：新增 13 项，涵盖签名固定向量、前导零、超时信号、stub 不联网、日志掩码、HTTP/业务/解析/网络失败脱敏。
6. `tests/unit/config.test.ts`：新增 9 项，涵盖默认值、非法 provider、四项各自缺失/空值/空白、生产安全闸及允许组合。
7. `tests/coach-reviews.test.ts`：新增 1 项，经真实调用链使用 Aliyun 配置发送并登录；错误码拒绝、正确码成功、验证码一次性消费。
8. 本任务卡：追加交付记录。

**先红后绿与验证证据**

- 修改实现前先写 sms/config 测试并执行：`2 failed`；`17 failed | 27 passed (44)`，确认红。
- 第一轮实现后：sms/config `2 passed`；`44 passed (44)`。
- 补非法号码掩码回归：先 `1 failed | 12 passed (13)`，修复后通过。
- 最终相关回归命令：`COACH_REVIEWS_TEST_TRANSPORT=memory pnpm exec vitest run tests/services/sms.test.ts tests/unit/config.test.ts tests/coach-reviews.test.ts tests/coach-reviews-moderation.test.ts`。

```text
✓ tests/services/sms.test.ts (13 tests)
✓ tests/unit/config.test.ts (34 tests)
✓ tests/coach-reviews.test.ts (23 tests)
✓ tests/coach-reviews-moderation.test.ts (8 tests)
Test Files  4 passed (4)
Tests       78 passed (78)
```

- `pnpm typecheck`、`pnpm lint` 均退出 0；改动 TS 文件的 Prettier check 及 `git diff --check` 通过。
- 已执行要求的完整命令 `pnpm typecheck && pnpm lint && pnpm test`，**全量测试未全绿**：当前沙箱禁止 HTTP 测试监听本地端口，报 `listen EPERM` 及随后读取空 server address 的 `port` 错误。

```text
修改前基线：Test Files 41 failed | 156 passed (197)
            Tests 565 failed | 1674 passed | 6 skipped (2245)
修改后全量：Test Files 41 failed | 157 passed (198)
            Tests 566 failed | 1696 passed | 6 skipped (2268)
            Errors 561 errors
```

- 新增的 HTTP 调用链用例使受端口限制的失败数增加 1；同一用例经仓库已有 `COACH_REVIEWS_TEST_TRANSPORT=memory` 入口通过。未改全局测试设施或规避沙箱限制。
- `rg -n 'logger|throw new Error|Authorization|TemplateParam' src/services/sms.ts` 自查：唯一日志为 `phone: maskedPhone`；不记录请求 URL、code、AccessKey、响应 Message/body 或原始异常。错误测试使用含占位敏感值的 Message/网络异常验证不会透传；真实密钥未读取、未写入。
- Standards 独立只读审查：0 项；Spec 独立只读审查：0 项。掩码与排序最后调整后 Spec 复核通过。

**验收状态与未决项**

- 卡片三组测试、默认 stub、脱敏、示例占位、无新依赖、交付记录均已覆盖；实现范围无偏离。
- 唯一未满足项是「全量测试全绿」：需在允许监听本机端口的收货环境重跑完整三项命令，当前不能标记全卡验收完成。
- 未发真实短信；签名/模板审核与部署联调仍按卡片 Out of Scope 另行处理。没有新增产品或实现决策待确认。
