# 057 — 教练解绑学员 + 学员备注 + 学员栏数据

- **状态**: Ready（2026-10-30 /grill 共识「确认」）
- **产品正典**: `meetpr-plan-web` 仓 `specs/021-student-rail-unbind/SPEC.md`。学员端提示见 meetpr-rn `specs/098-unbind-notice`。本 spec 只定后端改动。
- **级别 / 节奏**: T2 / P1（一条迁移 + 新接口 + 读权限放宽）。分支 `feat/057-coach-unbind-alias` → `staging`。合并后必须部署国内 staging；迁移由 David 在 DMS 执行。

## 现状

- 师生关系 = `bind_requests` 中 `status='accepted'` 的行；唯一索引保证同一 (学员, 教练) 最多一条 accepted、同一学员最多一条 pending。没有解绑接口。
- 授权大量依赖 accepted：`src/db/bonds.ts` 的 `hasAcceptedBond` 等，约 20 个文件。
- `GET /coach/students`（`listCoachStudents`）只列 accepted；iOS 与安卓 RN 教练端都在用，不能改变它的默认成员范围。
- `PATCH /coach/students/:id`（`renameCoachStudent`）upsert 的是 `student_profiles.display_name`，即学员本人名字。
- iOS `BindRequestStatus` 是严格枚举（pending/accepted/rejected/expired/cancelled），旧版遇到新值会解码失败。

## 变更

### 1. 迁移（下一个空号，派卡时现场核实，目前应为 0081）

- `bind_request_status` 增加枚举值 `ended`。
- `bind_requests` 增加 `ended_at TIMESTAMPTZ NULL`。
- 新表 `coach_student_aliases`：`coach_id`、`student_id`（均 FK users，级联删除）、`alias TEXT NOT NULL`（1–100）、`created_at`、`updated_at`，主键 (coach_id, student_id)。以 (教练, 学员) 为键而不是挂在绑定行上，这样重新绑定后备注还在。
- 纯新增，不改存量行、不需回填。整段脚本要能在 DMS SQLConsole 一次执行；新枚举值不要在同一事务里使用。附 Down 说明。

### 2. 解绑接口

- `POST /coach/students/:id/unbind`（教练）：该 (教练, 学员) 的 accepted 行改为 `ended`，写 `ended_at=now()`；返回 200。
- 没有 accepted 关系 → 404 `COACH_STUDENT_NOT_FOUND`（与 rename 一致，不泄露名单）；已是 ended 的重复调用也走 404。
- 成功后入队推送 `bind_ended` 给学员（先例：055 的 `tryEnqueuePushOutbox`），入队失败只记日志、接口仍 200。
  - 中文 title「{教练显示名}已与你解绑」，空名兜底「教练已与你解绑」；body「训练记录都还在，输入邀请码可重新绑定」。英文 title「{coach} has unlinked you」/「Your coach has unlinked you」，body「Your training history is kept. Enter an invite code to link again.」。繁体走 `copy()`。
  - custom `{ kind: 'bind_ended', student_id, request_id }`。

### 3. 对外状态兼容

- 凡是序列化绑定申请给客户端的地方（`toBindRequest` 及同类），DB 的 `ended` 一律输出为 `status: 'cancelled'`，并新增字段 `ended_at`（非 ended 行为 null）。新客户端靠 `ended_at` 非空识别「被解绑」；旧客户端只看到熟悉的 cancelled。
- 学员 `GET /bind-requests/me`（或现行等价接口）在学员被解绑后、未提交新申请前，返回这条 ended 行（带 `coach_display_name`）。

### 4. 读权限：已解绑可只读

- 新增 `hasCoachReadAccess(coach, student)` = 存在 accepted 或 ended 的绑定行。
- 网页编辑器只读打开已解绑学员时用到的**教练读接口**改用它：计划列表/详情、训练记录与历史、视频、动作统计、入学资料/1RM、准备度、评估读取、教练已发反馈读取（实装时逐个列入 JOURNAL）。
- 所有**写接口**、聊天发送、总览提醒、每日摘要、活动结算继续只认 accepted，保证已解绑学员不进任何统计与提醒。

### 5. 花名册与学员栏数据

- `GET /coach/students` 默认成员范围不变（只 accepted）；新增查询参数 `include_ended=1` 时追加 ended 学员。
- 每个学员追加字段（附加字段，旧客户端忽略）：
  - `alias`：教练备注名或 null。`display_name` 保持学员本名，语义不变。
  - `bond_status`：`active` | `ended`；`ended_at`。
  - `today`：`{ state: 'completed' | 'scheduled' | 'rest', completed_at }`。「今天」= 学员时区的训练日（与 `overview-alerts` 同一 `trainingDay` 口径）；completed = 今天有训练日完成记录（多个取最早 `completed_at`）；scheduled = 今天有已发布计划的训练日（计入顺延）但未完成；否则 rest。ended 学员该字段为 null。
  - `pending_video_count`：与网页反馈按钮角标同一口径。
- 查询条数固定，不随学员数增长（参照 054 的「50 名学员固定 8 条查询」做法写测试）。

### 6. 学员备注

- `PATCH /coach/students/:id` 改为写 `coach_student_aliases`：body `{ alias: string | null }`（null 或空串清除）。兼容旧请求体 `{ display_name }`：按 alias 处理。**不再写 `student_profiles.display_name`**。
- 只有在训学员可改备注；已解绑 → 404。
- 已经被旧接口改过的学员本名保持现状，不回滚（无法恢复原名）。

### 7. 老学员再申请

- `GET /coach/bind-requests` 每条申请追加 `previously_ended_at`：该学员与本教练最近一次 ended 的 `ended_at`，没有则 null。
- 接受申请照旧新建 accepted 行；不自动接受。

## 验收清单

1. 迁移在空库与带存量数据的库上都能整段执行、可重跑；存量 `bind_requests` 行不变。
2. 解绑：200；DB 行变 ended 且 `ended_at` 有值；重复调用 404；非本教练学员 404；学员角色调用 403。
3. 解绑后：outbox 有一条 `bind_ended`，三语文案与兜底正确；入队失败接口仍 200。
4. 学员 `/bind-requests/me` 返回 `status:'cancelled'` + `ended_at` 非空 + 教练名；任何接口都不输出 `ended` 字面值。
5. 已解绑学员：§4 列出的读接口教练可读；任一写接口 403；聊天发送 403；总览提醒、每日摘要不含该学员。
6. 花名册：默认响应成员与现网一致；`include_ended=1` 追加 ended；`today` 三种状态在跨时区与凌晨边界上正确；查询条数固定。
7. 备注：设置/清除生效；`student_profiles.display_name` 不变；旧请求体 `{display_name}` 写入 alias。
8. 学员重新申请 → 申请带 `previously_ended_at` → 接受后 accepted，花名册回到 active，alias 仍在。
9. 全量测试绿；部署国内 staging 后用一对测试师生走一遍解绑与重新绑定。

## 测试 seam

- 现有 coach 路由测试（`/coach/students`、rename）：补解绑、备注、`include_ended`、`today` 字段，先红后绿。
- 现有 bind-requests 路由/序列化测试：断言 ended → cancelled + `ended_at`、`previously_ended_at`。
- `bonds.ts`：`hasCoachReadAccess` 单测；挑一个读接口与一个写接口各写一条授权测试即可，其余在 JOURNAL 列清单。
- 现有 `push-payloads` 测试：补 `bind_ended`。

## Out of Scope

- 学员主动解绑、换教练。
- 解绑后学员继续访问计划（两端绑定关卡不放行）。
- 聊天、反馈等其他接口返回备注名；iOS/安卓教练端使用 alias。
- 合并或删除账号。
