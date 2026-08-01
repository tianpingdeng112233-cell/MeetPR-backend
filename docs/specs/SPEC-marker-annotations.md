# SPEC — 打点携带标注帧(backend,迁移 0055)

- 状态:APPROVED(⚖️ 2026-08-01 David:标注线要永久锚在视频那一帧,学员点打点看到教练画的帧)
- 分级:T2 / P1;base = origin/staging,分支 feat/marker-annotations
- 下游:web 教练端(发送标注时把已上传的 chat_image attachment 挂上打点;点击带标注的打点弹标注帧);iOS 学员端(同渲染,排 1.0(17))

## 迁移 0055(号已现场核实:staging 头 0054,0053 被语音 spec #138 预留,open PR 无占用)

`0055-marker-annotation-attachment.sql`:

```sql
BEGIN;
SET search_path TO public;
ALTER TABLE video_markers
  ADD COLUMN attachment_id UUID NULL REFERENCES attachments(id) ON DELETE SET NULL;
COMMIT;
```

(ON DELETE SET NULL:附件被清理时打点退化为普通打点,不级联删打点。)

## API 变化(全部向后兼容)

1. `POST /videos/:videoId/markers` body 新增可选 `attachment_id: uuid`:
   - 校验:attachment 存在、`kind='chat_image'`、`status='ready'`、`owner_id = 当前 coach`(403/404/409 沿用现有错误码风格:非法 → `422 VALIDATION_ERROR` 或 `404 ATTACHMENT_NOT_FOUND`/`409 ATTACHMENT_NOT_READY`,按仓内既有语义选,测试锁定)。
2. `serializeMarker` 增加:
   - `attachment_id: uuid | null`
   - `annotation_url: string | null` — 有 attachment 时用 `oss.signGetUrl` 签短时 GET(TTL 与现有视频 playbackURL 同口径,现场看 uploads/videos 里怎么签的照抄),GET 列表时逐条签。
   - `annotation_expires_in: number | null`(秒,与签名 TTL 一致;iOS 侧续签直接重拉列表)。
3. GET 权限不变(学员可读自己视频的打点 → 学员自然能拿到 annotation_url)。
4. DELETE 不变(删打点不删附件——附件还挂在聊天消息上)。

## 测试

- 迁移测试(样板 tests/migrations/0054-video-markers.test.ts)。
- 路由测试扩展 tests/video-markers.test.ts:带合法 attachment 创建 → 序列化含 annotation_url;非本人/非 chat_image/未 ready 的 attachment 被拒;无 attachment 的旧路径回归不变;学员 GET 能拿到 annotation_url;DELETE 后附件仍在。
- 不 commit 不 push,留未提交 diff 等互审。守仓内 lint(pnpm lint/prettier,husky 为准)。
