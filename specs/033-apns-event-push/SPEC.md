# SPEC 033 — APNs 事件推送:六类教练感知事件接通离线推送(服务端)

- **Status: InProgress(David 2026-08-03 拍板 APNs 波 + 六类内容清单;实装中)**
- **级别**: T2(消费者重构 + 六个事件源接线;零迁移——0036/0042 表结构够用)。**P1**。
- **来源**: 教练零感知专项。David 拍板六类推送:①聊天新消息 ②学员缺练 ③学员破 PR
  ④新视频待反馈 ⑤绑定申请 ⑥学员自行顺延计划。
- **拍板变更登记**: ③破 PR 推送**取代** 2026-07-04 D-a「不发 per-event push、只做分诊正向行」
  的约束——本次为 David 直接拍板,台账以本 spec 为准(分诊正向行不受影响,仍在 V0.2 轨道)。
- **端**: backend(本仓)+ iOS(对端 spec **067**)。基于 staging(spec 032 已合并,PR #190)。

## 0. 已核实前提

1. 投递链已完整:`notification_outbox`(0036,UNIQUE(event_type, aggregate_id, recipient_id))
   → `consumePushOutbox`(`src/jobs/push-consumer.ts`,每分钟 cron,batch 50,重试 5 次,
   410 清 token)→ `src/services/apns.ts`(HTTP/2 + provider JWT)→ `device_tokens`(0042)。
   `POST /devices/token` 注册端点在 `src/routes/devices.ts:27`。
2. env 契约:`PUSH_ENABLED=true` 强制要求 `APNS_KEY / APNS_KEY_ID / APNS_TEAM_ID /
APNS_BUNDLE_ID / APNS_ENV`(`src/config.ts:92-105`),p8 私钥走 env 不落文件。
3. **现存 bug 一并修**:`push-consumer.ts:9` 写死 `PUSH_EVENT_TYPE='coach_daily_digest'`,
   `plan_published` outbox 行(`src/routes/plans/index.ts:1106` 写入)永远无人消费、
   pending 无限堆积。
4. 事件源现状:②缺练已有(`src/jobs/activity-settlement.ts` 开 `missed_training` signal)、
   ③破 PR 已有(`src/handlers/pr-detection.ts` 开 `pr_congrats` signal);①④⑤⑥无事件源,须新增
   outbox 写入点。

## 1. 目标与非目标

### 1.1 目标

- push-consumer 从单一 event_type 泛化为 **payload builder 注册表**:每种 event_type 对应
  alert 文案 / collapse-id / thread-id / custom payload 构造器;未注册类型标 `failed`
  (`last_error='unknown_event_type'`)不重试——顺带排干 `plan_published` 存量积压。
- 六类事件各自在业务成功点写 outbox(见 §3),消费者在 1 分钟 cron 内投出。
- 学员在聊天里也收教练回复的推送(①天然双向;②-⑥仅教练收)。

### 1.2 非目标

- ❌ 每日聚合 digest 的启用:digest writer 保留,但其调度改挂独立开关
  `PUSH_DAILY_DIGEST_ENABLED`(默认 false)——per-event 上线后先观察打扰度,digest 是否叠加
  另拍。`PUSH_ENABLED` 只管 consumer + per-event 事件源。
- ❌ 精确桌面角标(badge 数):服务端不算全局未读;`badge` 字段不下发,角标语义交给 iOS
  通知中心自然堆积。另议。
- ❌ `plan_published` 推送复活(学员向,不在六类内;存量行按 failed 排干)。
- ❌ 通知偏好设置(教练侧免打扰/分类开关)——V2。

## 2. 推送内容契约(六类;iOS 067 依此路由,锁死)

APNs payload:`aps.alert{title,body}` + `aps.sound=default` + `aps.thread-id` +
custom `{ "kind": <type>, ...ids }`。文案中文写死在 builder(app 全中文,不做本地化表)。

| #   | event_type        | 收件人                   | aggregate_id(幂等键) | alert 示例                                                     | collapse-id                        | custom                     |
| --- | ----------------- | ------------------------ | -------------------- | -------------------------------------------------------------- | ---------------------------------- | -------------------------- |
| ①   | `chat_message`    | 会话对端(双向)           | message id           | 「王晨曦」/正文预览≤60字(image=「[图片]」,组卡片=「[训练组]」) | `conv-<conversation_id>`           | kind, conversation_id, seq |
| ②   | `missed_training` | 教练                     | signal id            | 「学员缺练提醒」/「钱骁已 N 天未训练」                         | 无                                 | kind, student_id           |
| ③   | `pr_congrats`     | 教练                     | signal id            | 「破 PR 🎉」/「小李 深蹲 e1RM 新高 ↑2.5kg」                    | 无                                 | kind, student_id           |
| ④   | `video_pending`   | 教练(=`source_coach_id`) | attachment id        | 「新视频待反馈」/「王晨曦上传了 比赛式深蹲 视频」              | `vid-<student_id>`(同学员连传合并) | kind, student_id, video_id |
| ⑤   | `bind_request`    | 教练                     | bind request id      | 「新学员申请」/「陈某 申请绑定」                               | 无                                 | kind, request_id           |
| ⑥   | `plan_shift`      | 教练(计划归属教练)       | shift 记录 id        | 「学员顺延了计划」/「小张 将本周期顺延 N 天」                  | `shift-<plan_id>`                  | kind, student_id, plan_id  |

预览文案裁剪与脱敏:①正文超 60 字截断加省略号;不含任何凭证类内容(聊天正文本身即用户内容,照发,
与微信同口径)。

## 3. 事件源接线(写 outbox 的精确位置)

全部在**业务事务提交成功后**插入 outbox(独立于业务事务;插入失败只 warn 不影响响应——
与 `recordSetLogActivity` 同口径)。ON CONFLICT (event_type,aggregate_id,recipient_id) DO NOTHING。

1. ① `POST /conversations/:id/messages` `created===true` 后 → 对端 recipient 写一行。
   **与 032 的 hub.publish 相邻但独立**:WS 是前台即时面,APNs 是离线面,两者都发,
   前台弃显交给 iOS(067 willPresent 策略)。幂等重放不写。
2. ② `activity-settlement.ts` 开 `missed_training` signal 成功处 → 写一行(推送时机=结算
   cron 时点,沿用现有结算日界线口径,本波不动三口径问题)。
3. ③ `pr-detection.ts` 开 `pr_congrats` signal 成功处 → 写一行(同步于 set log,即时)。
4. ④ `POST /uploads/:id/complete`(及 reconcile 补完路径)中 kind=`set_video` 且状态转
   `ready` 且 `source_coach_id` 非空 → 写一行。裸上传(无 source_coach_id)不推。
5. ⑤ `POST /bind-requests` 创建成功 → 向邀请码归属教练写一行(学员撤回不推)。
6. ⑥ `POST /plans/:id/shift` 成功 → 向计划归属教练写一行(撤销顺延 DELETE 不推)。

## 4. 消费者重构(`src/jobs/push-consumer.ts`)

- 删 `PUSH_EVENT_TYPE` 常量;候选查询改为 `event_type IN (已注册类型)` + 一条独立小查询把
  未注册类型的 pending 行批量标 failed(排干存量 `plan_published`)。
- builder 注册表 `src/jobs/push-payloads.ts`:`(event_type, payload JSONB) → { alert, collapseId?, threadId?, custom }`;
  builder 抛错(payload 缺字段等)→ 该行标 failed 带 last_error,不阻塞批次。
- 现有重试/410 清 token/超时语义**原样保留**;`PUSH_POLICY` 常量不动。
- ①的 body 预览在**写入侧**就截好放进 outbox payload(消费侧不回查 messages 表,
  避免消费时消息已删/可见性变化的回查复杂度)。

## 5. 测试与验收

vitest:六类各一条「业务动作 → outbox 行形状正确(recipient/aggregate/payload)」;
consumer:注册表分发、未知类型标 failed、builder 抛错单行 failed 不阻塞、幂等冲突静默;
digest 开关:`PUSH_DAILY_DIGEST_ENABLED=false` 时 digest cron 不注册。
APNs 客户端已有测试面不重测。

人工冒烟(staging 部署 + iOS 067 装真机/TestFlight 后):六类各触发一次,锁屏收到横幅;
教练 app 前台时聊天推送不弹(067 行为)。sandbox/production 按 `APNS_ENV` 分开验。

## 6. 部署与人工环节(前置预警)

- **David 手动**:① Apple Developer 后台建 APNs Auth Key(p8,Team 28JW4SA779),Key 内容
  进 Bitwarden;② SAE env 配 `PUSH_ENABLED=true` + 五个 `APNS_*`(APNS_BUNDLE_ID=app bundle id,
  staging 先 `APNS_ENV=sandbox`?——**注意**:TestFlight 包走 production APNs,内测验收前必须
  切 `APNS_ENV=production`,模拟器/Xcode 直装才是 sandbox);③ Xcode 侧 push capability 需要
  签名配置变更(067 范围,archive 时留意)。
- 合并后立即部署 staging;部署后先跑 §5 冒烟再通知 iOS 侧联调。
