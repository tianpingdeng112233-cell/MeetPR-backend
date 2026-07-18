# 022 — Admin role + read-only /admin/\* API

- **Status**: InProgress
- **Date**: 2026-07-18
- **Trigger**: plan-web Admin 管理后台（David 拍板 2026-07-18：V1 纯只读，写操作二期）。
- **Companion**: meetpr-plan-web `feat/admin-workspace`（同日实装波，视觉事实源 =
  claude.ai/design「MeetPR 管理后台设计」，副本在 plan-web 仓 `docs/design/admin/`）。

## Scope

新增第四个用户角色 `admin`（全平台至多一人），及一套只读 `/admin/*` 端点，
供唯一管理员在网页端俯瞰所有教练 / 学员 / 绑定关系 / 计划。**本 spec 不含任何写操作端点**
（停用账号 / 强制解绑等已明确押后二期）。

## Migration 0044（additive）

1. `users.role` CHECK 约束扩为含 `'admin'`。
2. `users_single_admin_idx`：partial unique index（`ON users ((true)) WHERE role = 'admin'`），
   数据库层强制单 admin。

## Admin 生命周期

- **入口唯一**：`scripts/create-admin.ts`（operator 手跑，读 `ADMIN_PHONE` / `ADMIN_PASSWORD` env）。
  自助注册（`/auth/register`）通过 `REGISTERABLE_ROLES` 收窄，**永不接受** `admin`。
- **语义**：无 admin → 创建（`created`）或将该手机号既有用户提升（`promoted`）；
  已有 admin 且手机号相同 → 密码轮换（`updated`）；已有 admin 且手机号不同 → 拒绝
  （`ADMIN_ALREADY_EXISTS`）。
- **会话安全不变量**：提升 / 轮换必须在同一事务内撤销该用户全部 refresh 链路凭据——
  legacy `users.refresh_token_jti` 置空 + `sessions` 全部 active 行 `revoked_at = now()`。
  旧设备的 refresh token 绝不能静默升级成 admin token。
  已签发的 access token 残余有效期 ≤ `JWT_ACCESS_TTL`（默认 15m）——这是全站一致的
  无状态 JWT 语义（密码修改 / 任何角色变更同理），不在本 spec 内引入 token versioning。
  作为靶向加固，`/admin/*` 每请求在 `requireRole('admin')` 之外**现场核对 DB 实时角色**：
  token 声称 admin 但 DB 已非 admin → 403，平台级数据面不受陈旧 token 影响。

## 端点（全部 `requireAuth` + `requireRole('admin')`，只读 GET）

响应 camelCase；`displayName` 来自 coach/student profile（全新创建的 admin 为 null；
由既有用户提升的 admin 保留其原 profile 名）；
绑定关系口径 = `bind_requests.status = 'accepted'`；数据量两位数级，不分页。
**绝不返回** `password_hash` / `refresh_token_jti` / `apple_user_id`。

| 端点                   | 形状（关键字段）                                                                                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/overview`  | `stats{coaches, coachedStudents, selfTrainStudents, activeBonds, publishedPlans}` + `recentUsers[≤10]{id, displayName, role, createdAt}` + `recentPlans[≤10]{…, publishedAt}`（表无 `published_at` 列，口径 = 曾发布计划的 `updated_at`） |
| `GET /admin/users`     | `users[]{id, displayName, role, phone, createdAt, relation}`；relation：coach→`{studentCount}`，coached_student→`{coachId, coachName}`\|null，其余 null                                                                                   |
| `GET /admin/users/:id` | `user` + `relations[]{userId, displayName, role, bondAcceptedAt}` + `plans[]{id, name, status, weeks, createdAt, coachName, studentName}`                                                                                                 |
| `GET /admin/bindings`  | `bindings[]{id, coachId, coachName, studentId, studentName, status, submittedAt, respondedAt}`（全状态全量）                                                                                                                              |
| `GET /admin/plans`     | `plans[]{id, name, coachId, coachName, traineeId, studentName, status, weeks, startDate, endDate, createdAt}`                                                                                                                             |
| `GET /admin/plans/:id` | 与教练端 `/plans/:id` 同构（复用 `getPlanWithChildren`），**每个 exercise 额外携带 `exercise_name`**——admin 无法经 coach-scoped `/exercises` 解析教练自建动作，详情必须自带显示名                                                         |

## 兼容性

Additive-only：不改任何既有端点的响应形状；现役 iOS / plan-web 客户端零影响。
`/plans/:id` 行为不变（`exercise_name` 仅 admin 详情携带）。

## 验收

- 每个 `/admin` 路由：匿名 401；coach / student token 403。
- register 提交 `role=admin` → validation 拒绝。
- 单 admin：索引拒绝二号 admin 行；脚本对异号手机拒绝、同号幂等（轮换）。
- 提升 / 轮换后：既有 sessions 全部 revoked、legacy jti 清空。
- happy path 契约形状（seed fixtures）全覆盖。
