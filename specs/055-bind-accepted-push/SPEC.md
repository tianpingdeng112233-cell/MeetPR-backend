# 055 — 教练接受绑定时给学员推送「已接受」

- **状态**: Ready（2026-10-24 /grill 共识「确认」）
- **产品正典**: `meetpr-rn` 仓 `specs/095-post-bind-first-run/SPEC.md`（iOS 仓同目录有镜像）。本 spec 只定后端改动。
- **级别 / 节奏**: T2 / P1（新推送类型，无迁移）。分支 `feat/055-bind-accepted-push` → `staging`。合并后必须部署国内 staging（不许只合不部署）。

## 现状

- `POST /bind-requests/:id/accept`（`src/routes/bind-requests.ts`）接受成功后不给学员发任何推送；学员提交申请时给教练发 `bind_request`（同文件 `tryEnqueuePushOutbox` 调用为先例）。
- 推送文案集中在 `src/jobs/push-payloads.ts`，按 `locale` 出 zh / zh-Hant（`copy()`）/ en（spec 052）。
- 老版 iOS 收到未知 `kind` 时路由为空，只打开 App（iOS `PushNotificationRouting` 对未知 kind 返回 nil，已核实）；安卓 RN 未注册推送。所以新增类型对在线客户端无破坏。

## 变更

1. 新推送类型 `bind_accepted`，收件人 = 该绑定申请的学员。
   - 中文：title「{教练显示名}已接受你的申请」，body「打开 MeetPR 看看接下来做什么」。教练显示名为空时 title 用「教练已接受你的申请」。
   - 英文：title「{coach} accepted your request」/「Your coach accepted your request」，body「Open MeetPR to see what's next」。
   - 繁体：走现有 `copy()` 生成，不手写。
   - custom：`{ kind: 'bind_accepted', student_id, request_id }`；`collapseId` = `bind-accepted-{request_id}`；`threadId` = `bind_accepted`。
2. 接受成功（`result.type === 'accepted'`）后用 `tryEnqueuePushOutbox` 入队，入队失败只记日志，**接口照常 200**、响应体不变。
3. 所有能把绑定申请变成 accepted 的路径都要发（实装时 grep `acceptBindRequest` 全部调用点）；同一申请只发一次。

## 验收清单

1. 教练接受 → 推送 outbox 出现一条 `bind_accepted`，收件人是学员，payload 字段如上。
2. 三种语言文案正确；教练显示名为空时用兜底文案。
3. 入队抛错时 accept 仍返回 200 且响应体与现网一致。
4. 拒绝、过期、取消不发。
5. 全量测试绿；部署国内 staging 后用一对测试师生实测 iOS 收到推送（随 095 iOS 卡一起验）。

## 测试 seam

- `tests/` 里现有 bind-requests 路由测试：断言 accept 后入队 `bind_accepted`、入队失败仍 200（先红后绿）。
- 现有 `push-payloads` 测试：补 `bind_accepted` 三语与兜底。

## Out of Scope

- 任何迁移、新表、新接口；客户端改动（见 095）。
- `plan_published` 等现有推送的文案与逻辑。
- 安卓推送通道。
