# Spec 031 — 语音消息 + 服务端转写（backend）

> 状态：草案 · 2026-07-29
> 触发：David 拍板「聊天加语音输入」→ 方案 C2（语音条 + 服务端 ASR 转写）
> 关联：spec 024（coach-student chat W1）、spec 029（set-ref chat card）、spec 004（upload 管线）
> 客户端对应卡：iOS spec 062、plan-web（语音条 UI）

## 1. 目标

在既有 1:1 聊天里增加第三种消息形态 `audio`：发送方录一段 ≤60 秒语音，
接收方既能播放，也能读到服务端异步转写出的文字。

**非目标**：群聊语音、语音通话、端上转写、实时流式识别、语音搜索。

## 2. 交付切分

本 spec 覆盖两张可独立验收的卡：

| 卡 | 范围 | 外部依赖 |
|---|---|---|
| **A · 语音消息通道** | 迁移 0053 + 上传白名单 + 收发/播放 API + 老客户端降级 | 无 |
| **B · ASR 转写旁路** | 阿里云录音文件识别接入 + 异步回填 + 降级 | 需 David 先开通 NLS 并配置 AppKey |

卡 A 独立验收标准：能录、能发、能播、老客户端不炸——**不含任何转写**。
卡 B 独立验收标准：卡 A 发出的语音在数秒内回填出 `transcript`，失败不影响消息本身。

## 3. 数据模型（迁移 0053）

迁移号 0053 已现场核实为空闲（全分支扫描，2026-07-29）。**加性迁移，无破坏性变更。**

```sql
-- messages 支持 audio
ALTER TABLE messages DROP CONSTRAINT messages_kind_check;  -- 名称以实际为准
ALTER TABLE messages ADD CONSTRAINT messages_kind_check
  CHECK (kind IN ('text', 'image', 'audio'));

ALTER TABLE messages ADD COLUMN duration_ms INTEGER;
ALTER TABLE messages ADD COLUMN transcript TEXT;
ALTER TABLE messages ADD COLUMN transcript_status TEXT;

-- audio 消息：必须有 attachment + duration，body 恒空（正文由 transcript 承载）
ALTER TABLE messages ADD CONSTRAINT messages_audio_shape_check CHECK (
  kind <> 'audio' OR (
    attachment_id IS NOT NULL AND body IS NULL
    AND duration_ms IS NOT NULL AND duration_ms BETWEEN 1000 AND 60000
  )
);
-- 非 audio 消息不得携带语音字段
ALTER TABLE messages ADD CONSTRAINT messages_non_audio_shape_check CHECK (
  kind = 'audio' OR (duration_ms IS NULL AND transcript IS NULL AND transcript_status IS NULL)
);
ALTER TABLE messages ADD CONSTRAINT messages_transcript_status_check CHECK (
  transcript_status IS NULL
  OR transcript_status IN ('pending', 'succeeded', 'failed', 'skipped')
);
ALTER TABLE messages ADD CONSTRAINT messages_transcript_length_check CHECK (
  transcript IS NULL OR length(transcript) BETWEEN 1 AND 4000
);

-- 转写 worker 的取件索引（只扫待办，不全表扫）
CREATE INDEX messages_transcript_pending_idx
  ON messages (created_at) WHERE transcript_status = 'pending';

-- attachments 白名单加一种介质
ALTER TABLE attachments DROP CONSTRAINT attachments_kind_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_kind_check
  CHECK (kind IN ('set_video', 'onboarding_video', 'onboarding_doc', 'chat_image', 'chat_audio'));
```

⚠️ 既有 0045 的两条 kind 形态 CHECK（`text`/`image` 互斥那条）必须一并重写以容纳
`audio`，否则 INSERT 会被旧约束挡下。改约束前先 `\d messages` 核实真实约束名。

`src/db/types.ts` 的 `MessagesTable` / `ATTACHMENT_KINDS` 手工同步（无 ORM，硬规则 1）。

## 4. 上传（复用 spec 004 管线）

`src/routes/uploads/schemas.ts` 增加一档：

```ts
chat_audio: {
  maxSizeBytes: 2 * MB,          // 60s AAC 约 200KB，2MB 留足余量
  contentTypes: ['audio/mp4', 'audio/aac', 'audio/webm'],
},
```

`CONTENT_TYPE_EXTENSIONS` 补 `'audio/mp4': '.m4a'`、`'audio/aac': '.aac'`、`'audio/webm': '.webm'`。

**格式决策（已核实，别改回去）**：iOS 自然产物是 AAC/m4a，浏览器 `MediaRecorder`
在 Chrome 出 webm/opus、Safari 出 mp4/aac。阿里云**一句话识别只吃 PCM/WAV**，
喂不进这些容器；**录音文件识别兼容 aac/wav/mp3/m4a** —— 所以选录音文件识别接口，
客户端和服务端都不做转码。webm/opus 的兼容性在卡 B 实测确认，若不支持则
plan-web 侧改录 `audio/mp4`（Chrome 亦支持），仍然不引入转码。

## 5. 收发 API

### 5.1 发送 `POST /conversations/:id/messages`

`SendMessageBodySchema` 增加 `kind: 'audio'` 分支：

```
{ kind: 'audio', attachment_id: uuid, duration_ms: int(1000..60000), client_id: string }
```

- 复用 image 分支既有的归属校验：attachment 必须属于本人、`kind='chat_audio'`、
  已 complete、未被别的消息占用（照抄 `src/routes/conversations/index.ts` 现有 image 校验分支）。
- 落库时 `transcript_status = 'pending'`（未配置 NLS 时写 `'skipped'`，见 §6.4）。
- 幂等、seq 分配、bind 校验全部沿用现有路径，不新增语义。

### 5.2 读取 `GET /conversations/:id/messages`

`MessageWire` 增加四个字段：`audio_url`、`audio_expires_in`、`duration_ms`、`transcript`。
presign TTL 复用 `IMAGE_URL_TTL_SECONDS`（900s）。

### 5.3 老客户端降级（**红线**）

已核实：iOS `ChatMessageKind` 是 `enum: String, Codable` 且**无 unknown 兜底**，
`try container.decode(ChatMessageKind.self)` 遇到 `"audio"` 直接 throw；
客户端也不发任何版本头，服务端无从按版本协商。若无条件下发 `audio`，
**TestFlight 在测的 1.0(14) 及更早版本聊天页会整页解码失败** —— 违反 CLAUDE.md 硬规则 8。

因此读取接口按 **opt-in 能力声明**下发：

- 请求带 `?client_caps=audio`（新客户端）→ 原样下发 `kind: "audio"`。
- 不带（老客户端、plan-web 旧版）→ 该条降级为 `kind: "text"` 下发，`body` 取值：
  - 转写成功：`"[语音] " + transcript`
  - 其余情况：`"[语音消息] 请升级 App 查看"`
  - `attachment_id` / `audio_url` 一律不下发，避免老端拿到无法处理的附件。

降级发生在序列化边界，不改库里的行。`client_caps` 为逗号分隔白名单，
未知能力值忽略而非报错（为后续 W2 能力位留路）。

## 6. 转写（卡 B）

### 6.1 接口选型

阿里云智能语音交互 · **录音文件识别**（异步提交 + 轮询取结果）。
计费 ¥2.50/小时（0–299 小时档），一条 15 秒语音约 ¥0.0104。
**不用闲时版**（¥1.00/小时）——闲时版延迟可达数小时，语音消息要求秒级出字。

### 6.2 执行模型

复用既有 `src/jobs/scheduler.ts` 轮询模式（与 `push-consumer` 同构，不引入新队列基础设施）：

1. 取 `transcript_status='pending'` 且 `created_at` 最早的 N 条（`FOR UPDATE SKIP LOCKED`）。
2. 用 OSS 内网可读 URL 提交识别任务 → 轮询任务结果。
3. 成功写 `transcript` + `'succeeded'`；失败写 `'failed'` 并记结构化日志。
4. 重试上限 3 次后落 `'failed'`，不无限重试；单条失败不影响其它条。

幂等：`transcript_status` 的状态机本身即幂等闸，只有 `pending` 会被取件。

### 6.3 配置

新增 env（zod 校验，全部 optional）：`NLS_APP_KEY`、`NLS_ACCESS_KEY_ID`、
`NLS_ACCESS_KEY_SECRET`、`NLS_REGION`（默认 `cn-shanghai`）。

**凭证只存 Bitwarden**，`.env.example` 仅放占位符（硬规则 7）。

### 6.4 降级（legacy-safe 默认）

未配置 NLS 时：发送侧直接写 `transcript_status='skipped'`，worker 不取件，
语音消息照常收发播放，只是没有文字。这让卡 A 能先于阿里云开通独立上线（硬规则 8）。

## 7. 验收标准

**卡 A**
- [ ] 迁移 0053 可正向应用于 staging 快照；`tests/migrations/0053-*.test.ts` 覆盖新旧约束
- [ ] `chat_audio` 走完 initiate → sign-parts → complete，非白名单 content-type 被拒
- [ ] 发送/读取语音消息全链路通过；duration 越界（<1s / >60s）被 400
- [ ] 借用他人 attachment、复用已占用 attachment、跨会话 attachment 均被拒
- [ ] **不带 `client_caps` 的请求在响应里绝不出现 `kind: "audio"`**（回归测试锁死）
- [ ] 既有 chat 测试（`chat-messages` / `chat-uploads` / `chat-set-ref` / `chat-bonds`）全绿

**卡 B**
- [ ] 真发一条 15 秒中文语音，数秒内 `transcript` 落库且内容可读（贴实证）
- [ ] 断开 NLS 配置后语音消息仍可正常收发（降级实证）
- [ ] 识别失败的消息落 `'failed'`，不阻塞后续取件，不重复扣费

## 8. 已知风险

1. **webm/opus 兼容性** —— 录音文件识别对 webm 容器的支持未实测，卡 B 首个动作就是拿
   一条 Chrome 录的 webm 去打接口，不支持就让 plan-web 改录 `audio/mp4`。
2. **推送预览** —— W2 APNs 尚未开工；届时语音消息的推送文案取 `transcript`，
   无转写时退化为「[语音消息]」。本 spec 不实装。
3. **隐私合规** —— 录音需要补 App Store 隐私清单条目与用户协议措辞，属客户端卡范围。
4. **教练端扫视态** —— 语音在教练侧天然不可扫视，转写文本必须与语音条同屏直出
   （不是「点开才看」），这是选 C2 而非 B 的全部理由，客户端卡不得省略。
