# 047 — 用户头像（上传、设置、移除；向本人与其教练下发）

- **状态**: Approved（David 2026-10-09 grill 拍板：6A「顺便加个头像上传」、11A「教练端也动」、12A 分步、13A 教练端只显示学员头像；安卓 spec 088 共识）
- **级别 / 节奏**: T2（迁移 + 新接口 + 现有响应加字段）；P1。合并等 David 放行；staging 部署随合并；**Global 生产的迁移与部署不在本 spec 授权内**，另等 David 放行。
- **对应**: 安卓 `meetpr-rn` `specs/088-profile-redesign/SPEC.md` §4（学员上传）、§5（教练端显示）。iOS 与 plan-web 本轮不消费。
- **迁移号**: **0072**（2026-10-09 现场核实：origin/staging 头 0070；open PR #267 占 0069；open PR #289（spec 046）占 0071）。本分支叠在 `feat/046-body-weight-records` 上；**#289 合并前不派卡**，实装时再核一次迁移号。
- **先读**: 仓根 `CONTEXT.md`（头像）。

## 问题（为什么做）

学员端 Profile 改版后顶部是一张身份摘要卡，需要头像与名字。现状：`users` 没有头像字段；上传通道明确拒收 `avatar` 种类；学员自己的名字（`student_profiles.display_name`）没有任何学员侧接口下发，`GET /me` 只有 id / phone / email / role。

## 语义（一句话）

每个用户至多一张当前头像；本人随时可换可删；本人与其**当前绑定的教练**能读到，其他人读不到。

## §1 数据模型（0072-user-avatar.sql）

- `attachments.kind` 的检查约束加入 `'avatar'`（做法同 0045 加 `chat_image`）。
- `users` 新增一列 `avatar_attachment_id UUID NULL REFERENCES attachments(id) ON DELETE SET NULL`。
- 纯加法：不改任何现有行，存量用户该列全为 NULL（= 没有头像），不需要回填。
- `src/db/types.ts` 手工补：`ATTACHMENT_KINDS` 加 `avatar`，`UsersTable` 加新列。
- 删号：`users` 行删除时 `attachments` 行按现有外键级联删除；对象存储里的头像文件见 §5。

## §2 上传（复用现有上传通道）

- `POST /uploads/initiate` 接受 `kind: "avatar"`：`content_type` 只收 `image/jpeg`、`image/png`；`size_bytes` 上限 2 MB；`part_count` 必须为 1；不接受 `set_log_id`。超限或类型不符走现有的校验错误。学员与教练两种角色都可以发起（字段挂在用户上、不分角色；教练端本轮没有上传入口）。
- `complete` / `abort` / `reconcile` 沿用现有流程，不为头像加特例。
- `GET /uploads/:attachmentId/url` 对 `avatar` 种类只允许所有者本人读取；教练读取学员头像走 §4 的字段，不走这个接口。

## §3 设置与移除

### PUT `/me/avatar`

请求体 `{ "attachment_id": "<uuid>" }`（strict）。

- 该附件必须属于当前用户、`kind = 'avatar'`、`status = 'ready'`；否则 400 `AVATAR_ATTACHMENT_INVALID`（不存在、不是本人的、种类或状态不对都是这一个错误码，不区分，避免探测他人附件）。
- 把 `users.avatar_attachment_id` 指向它。若之前有另一张头像：旧附件行删除，旧对象文件尽力删除（失败只记日志，不影响本次响应）。
- 重复提交当前已生效的同一 `attachment_id`：幂等，200，不删任何东西。
- 200：`{ "avatar_url": "<签名读地址>", "avatar_version": "<不透明字符串>" }`。

### DELETE `/me/avatar`

- 有头像：清空 `users.avatar_attachment_id`，删除附件行，尽力删除对象文件。没有头像：幂等。
- 204。

两个接口对 `coached_student`、`self_train_student`、`coach` 三种角色都开放，只能操作自己。

## §4 下发

所有新增字段都是**加法**；现有字段的名称、类型、取值一个不改。

- `GET /me` 的 `user` 里新增：
  - `display_name`：学员取 `student_profiles.display_name`，教练取 `coach_profiles.display_name`；没有对应行或为空串时为 `null`。
  - `avatar_url`：有头像时是有时效的签名读地址（时效沿用现有图片读地址的口径），否则 `null`。
  - `avatar_version`：有头像时等于当前头像附件的 id，否则 `null`。客户端用它做图片缓存键（签名地址每次请求都会变，不能当缓存键）。
- 教练侧读到学员的三处各新增 `avatar_url` 与 `avatar_version`（同上口径，可空）：
  1. `GET /coach/students` 的每个学员；
  2. `GET /coach/students/:id`；
  3. 会话列表与会话详情里的 `other_party`（教练看学员时有值；学员看教练时，教练没有头像即为 `null`，不做特殊处理）。
- 可见范围由这些接口现有的可见范围决定：教练只能在自己名下学员的数据里拿到头像地址；解绑后拿不到。不新增任何「按用户 id 查头像」的公共接口。
- 登录 / 注册 / 刷新令牌的响应**不加**这些字段（保持那几个响应的形状不变；客户端需要时读 `GET /me`）。

## §5 删除与隐私

- 换头像、移除头像：旧对象文件即时尽力删除（§3）。
- 删号（`DELETE /me`）：在删除 `users` 行**之前**读出当前头像的对象键，删除用户后尽力删除该对象文件；删除对象失败只记日志（带用户 id 与对象键），不影响删号结果（仍是 204）。
- 上传发起了但从未被设为头像的 `avatar` 附件（用户选了图又取消、或上传成功但 `PUT /me/avatar` 没发出）：不在本 spec 清理，见 Out of Scope。
- 不做内容审核；头像只对本人与其教练可见。
- 日志里不得打印签名读地址。

## §6 兼容

- 新列、新种类、新路由、现有响应加字段；不加环境开关。线上 iOS 与旧版安卓零感知（两端对这些响应的解析都忽略未知字段——实装时对 `GET /me`、教练学员列表 / 详情、会话三处各核一次两端的解析方式，若某端是严格解析则停下回报，不得硬加）。
- 不新增推送。
- 限流沿用全局中间件。

## Out of Scope

教练端上传入口（接口已允许，客户端不做）；学员看到教练头像的任何客户端展示；plan-web 展示；修改 `display_name` 的接口；头像审核、裁剪、缩略图生成（裁剪与压缩在客户端）；清理从未被引用的 `avatar` 附件与历史上视频类孤儿对象（现状：`DELETE /me` 只级联数据库行，`deleteObject` 只在上传的中止与单条删除里被调用，删号不删对象存储里的训练视频与聊天图片——这是既有行为，本 spec 不改，2026-10-09 已报给 David 另行处理）；Global 生产迁移与部署。

## 测试 seam

1. `tests/migrations/0072-user-avatar.test.ts`（沿用该目录现有迁移测试的方式）：约束接受 `avatar`、仍拒绝未知种类；新列存在且默认 NULL；附件行删除后该列自动置 NULL；`users` 表其余列与存量行逐行不变；迁移重跑不报错。
2. `tests/uploads-initiate.test.ts`（已有，补用例；其中「`avatar` 是非法种类」那条断言按本 spec 改为合法，这是唯一允许改的旧断言）：`avatar` 的类型白名单、2 MB 上限、`part_count` 必须为 1、带 `set_log_id` 被拒。
3. `tests/me-avatar.test.ts`（新增，supertest，沿用现有鉴权 helper）：
   - PUT：设置成功并返回地址与版本；用别人的附件、非 `avatar` 种类、未 `ready` 的附件都是 400 `AVATAR_ATTACHMENT_INVALID`；换头像后旧附件行不存在且对存储的删除被调用一次；重复提交同一 id 幂等且不触发删除；存储删除抛错时仍 200。
   - DELETE：有头像 → 204 且附件行不存在、存储删除被调用；没有头像 → 204。
   - `GET /me`：新增三个字段在有 / 无头像、有 / 无档案名字四种组合下的取值；原有字段逐字段不变。
   - `GET /uploads/:id/url`：所有者可读自己的 `avatar`；教练与其他学员读同一附件被拒。
4. 教练侧（补进现有的学员列表 / 详情 / 会话测试，不改旧断言）：名下学员有头像时三处都带地址与版本；没有头像为 `null`；解绑后列表里不再出现该学员（现有行为）因而拿不到地址；别的教练拿不到。
5. 删号测试（已有，补用例）：有头像的用户删号后存储删除被调用一次；存储删除抛错时删号仍 204。

## 验收清单（开发前定，Opus 逐项收货）

- [ ] 1 迁移在干净库与已有数据的库上都能应用；`users` 存量行逐行不变、新列全 NULL；重跑不报错。
- [ ] 2 `avatar` 上传的类型、大小、分片数限制符合 §2；其他种类的限制未变。
- [ ] 3 `PUT /me/avatar`、`DELETE /me/avatar` 的全部状态码与响应形状符合 §3；换与删之后旧对象文件被删除（staging 上对着真实存储核一次对象确实不在了）。
- [ ] 4 `GET /me` 新增三个字段符合 §4；教练侧三处新增两个字段符合 §4；这些响应里原有字段逐字段不变（现有测试不改断言全部通过，§测试 seam 第 2 条那一处除外）。
- [ ] 5 越权：学员 A 拿不到学员 B 的头像地址；教练拿不到非名下学员的头像地址；`/uploads/:id/url` 对 `avatar` 只认所有者。
- [ ] 6 删号后头像对象文件被删除；存储不可用时删号仍成功。
- [ ] 7 **老用户第一屏**：对迁移前就存在的学员与教练账号，迁移后 `GET /me`、教练学员列表 / 详情、会话列表的原有字段与迁移前逐字段相同，新字段为 `null`（有档案名字的 `display_name` 为该名字）。
- [ ] 8 iOS 当前线上包与安卓 `main` 包指向 staging 各走一遍登录、花名册、聊天，不因新增字段解析失败。
- [ ] 9 `pnpm typecheck && pnpm lint && pnpm test` 全绿；`db/MIGRATIONS-APPLIED*.md` 不由实装方改（部署台账由 Opus 在部署后登记）。

## 拆卡

一张卡、一个 PR：`CARD.md`。#289（046）合并后派。
