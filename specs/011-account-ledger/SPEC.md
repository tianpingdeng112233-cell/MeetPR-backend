# SPEC 011 — 账号台账:注销 + 改密(backend 半)

- **状态**: Draft
- **来源**: 自己练 Free 档 wave A6;Apple App Review 5.1.1(v) 硬性要求(app 内可发起账号删除)。iOS 半 = spec 048。
- **侦察(2026-07-04)**:①users 直系外键 17 个**全部** ON DELETE CASCADE(级联链完备,单条 DELETE FROM users 即全量清理;set_logs.plan_exercise_id 的 SET NULL 与行级 student_id CASCADE 同删终态一致);②/me 现为 501 stub(GET);③auth 路由无改密端点;④011 空号核实(specs/ 无占用,open PR 无占号)。**无迁移需求**(纯端点)。

## 1. DELETE /me(注销)

- 鉴权:`requireRole('coached_student', 'self_train_student')`。**coach 暂不开放**(403 `COACH_DELETE_UNSUPPORTED`):教练注销会级联删除其计划并波及 bonded 学员,offboarding 语义需单独设计(开放项,不阻塞 Apple 合规——审核针对的是提交的学员端功能面)。
- 行为:事务内 `DELETE FROM users WHERE id = req.user.id`(CASCADE 清 set_logs/e1rm 无后端表/onboarding/reviews/readiness/bind/uploads/refresh tokens 全链)→ 204。幂等:已删除的 token 再打 → 401(token 校验自然拒绝)。
- 日志:`account_deleted`(userId, role)——运营审计留痕,不留业务数据。

## 2. PUT /me/password(改密)

- 鉴权:三角色皆可(改密无副作用歧义)。
- Body:`{ old_password, new_password }`,new_password 复用注册的 zod 规则(实施时现场对齐 schemas.ts)。
- 行为:bcrypt 校验 old_password(错 → 403 `PASSWORD_MISMATCH`)→ 一条 UPDATE 同时写新 hash + **清空 `users.refresh_token_jti`**(刷新是单槽 jti 列,置空即撤销在外的 refresh token,与 logout 同习语;当前设备 access token 存活到过期)→ 204。实施更正:早稿「删 refresh_tokens 表」——该表不存在,单槽模型。

## 非目标

忘记密码(SMS 通道,post-incorporation,接口不预留实现);coach 注销;数据导出(纯客户端,spec 048);软删除/冷静期(V1 直删,内测期口径,上架前可复议)。

## 测试

- 注销:学员建数据(sets/review/readiness)→ DELETE /me 204 → 各表按 student_id 查空 → 原 token 打任意端点 401;coach → 403。
- 改密:旧密错 403;成功后旧密登录 401、新密登录 200;refresh token 全清(旧 refresh 换新 401)。
