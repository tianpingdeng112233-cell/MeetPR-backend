# 004-video-upload

**Status:** Draft
**Date:** 2026-05-15

## Goal

Land backend OSS multipart-upload signing endpoints + DB schema for student-side video upload (iOS V0.1 wave **spec 027**), plus the privacy-consent audit ledger and a coach-readable video listing endpoint (consumed by iOS spec 029 `StudentVideoGridView`).

iOS does all transcoding (H.264 720p best-effort 1Mbps) + multipart chunking client-side; backend only signs + tracks completed uploads. No MPS / H.265 transcode this spec (Stage 4 separate spec per ADR-004 §11 lean).

Refs:

- iOS [spec 027 video upload](../../../MeetPR/specs/027-video-upload/SPEC.md) §4 backend endpoints + §技术要求 OSS multipart + 1h presigned URL re-sign flow
- iOS [spec 029 coach review](../../../MeetPR/specs/029-coach-student-detail-feedback/SPEC.md) §Backend dependencies — coach video grid reads `GET /students/:id/videos`
- [PRD §5 #14 video upload](~/Brain/wiki/projects/MeetPR/prd.md) — 60s default / 120s max + 教练 visibility + 隐私同意 audit
- [PRD §8.10 video pipeline](~/Brain/wiki/projects/MeetPR/prd.md) — client H.264 best-effort + server-side no transcode V0.1 (MPS Stage 4)
- [ADR 004 §1 / §4](~/Brain/wiki/projects/MeetPR/decisions/004-backend-selection.md) — Aliyun OSS bucket `meetpr-videos-prod`
- [ADR-005 §4 横切关注点](~/Brain/wiki/projects/MeetPR/decisions/005-ios-architecture.md) — iOS resumable upload requirements

Upstream backend: [001-auth](../001-auth/SPEC.md) (JWT requireAuth reused) + [003-student-actions](../003-student-actions/SPEC.md) (`plan_exercises` FK consumer; ownership query pattern reused; bind_requests already exists).

## Scope

### OSS bucket configuration (one-time, before impl)

Bucket `meetpr-videos-prod` already provisioned (per `~/Brain/wiki/projects/MeetPR/secrets-pointer.md` §117). This spec triggers **4 config items** (per ADR-004 §6 upline blocker):

| Item           | Setting                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| 读写权限       | **私有**(预签名 URL 才能读写)                                                                        |
| Referer 防盗链 | V0.1 不开(无自有域;Stage 3 切自有域 + ICP 备案后开)。CORS 已足够 internal 测试                       |
| CORS           | `PUT` + `GET` 来自 mobile origin `*`(impl 期 narrow to specific App User-Agent if needed)            |
| 生命周期       | 90 天后 OSS 标准 → 低频;180 天后 → 归档(Stage 4 后启;V0.1 default disabled,显式 mark "not yet" 即可) |

Configured via Aliyun console (out of code). Deploy checklist记录 + screenshot 进 Bitwarden vault entry。

### Migrations (1 new file)

#### `0007-init-video-and-consent.sql`

```sql
CREATE TABLE video_attachments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_exercise_id     UUID NOT NULL REFERENCES plan_exercises(id) ON DELETE CASCADE,
  set_index            INT NOT NULL CHECK (set_index >= 0),
  oss_key              TEXT NOT NULL UNIQUE,
  oss_upload_id        TEXT NOT NULL,   -- OSS multipart upload ID;**kept post-complete for audit + 重录 abort 路径**(per PR #8 review non-blocking #3 — 之前 "cleared after / kept for audit" 措辞自相矛盾,统一保留)
  duration_seconds     NUMERIC(5,2) NOT NULL CHECK (duration_seconds > 0 AND duration_seconds <= 121.0),
  file_size_bytes      BIGINT NOT NULL CHECK (file_size_bytes > 0 AND file_size_bytes <= 1073741824),  -- 1 GiB cap (fallback raw upload may approach)
  thumbnail_oss_key    TEXT NOT NULL,
  recorded_at          TIMESTAMPTZ NOT NULL,
  uploaded_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  coach_visible_at     TIMESTAMPTZ,    -- filled when student gives consent (NULL = not yet shareable)
  CONSTRAINT video_attachments_unique_set UNIQUE (student_id, plan_exercise_id, set_index)
    -- enforce: one video per (student, set) slot. Re-record overwrites via abort + new initiate.
);

CREATE INDEX video_attachments_student_recorded_idx
  ON video_attachments (student_id, recorded_at DESC);
CREATE INDEX video_attachments_plan_exercise_idx
  ON video_attachments (plan_exercise_id);

CREATE TABLE privacy_consents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_kind  TEXT NOT NULL,            -- e.g. 'video_visibility_v1'
  agreed_at     TIMESTAMPTZ NOT NULL,
  user_agent    TEXT,                     -- client User-Agent at consent time
  ip_address    INET,                     -- client IP at consent time
  UNIQUE (user_id, consent_kind)          -- one row per (user, consent_kind) — re-agree is no-op
);

CREATE INDEX privacy_consents_user_idx ON privacy_consents (user_id, agreed_at DESC);
```

> `coach_visible_at` defaults NULL: a video uploaded but consent not yet given is NOT served to coach. `POST /privacy/consent` of kind `video_visibility_v1` flips a flag elsewhere; for V0.1 simple, **uploading itself implies consent** because iOS spec 027 shows the modal `[同意上传] / [不上传]` before any upload starts. So in practice `coach_visible_at = uploaded_at` at insert time IF `privacy_consents.video_visibility_v1` exists for the student. Implementer logic: `coach_visible_at = (consent exists ? uploaded_at : NULL)` set during `POST /upload/complete`.

> `duration_seconds <= 121.0`: 120s max + 1.0 fp slack (iOS `AVAssetExportSession` may yield 120.04s after re-encode). Hard reject > 121.

> `file_size_bytes <= 1 GiB`: defensive cap. iOS fallback raw upload may approach this (ProRes 120s @ 4K could exceed; V0.1 students filming on phone录制 < 1 GiB). Hard reject > 1 GiB to prevent OSS bucket DoS.

> No backend table tracks in-progress multipart uploads (那是 OSS server-side state). The `oss_upload_id` is stored here only post-completion for audit/abort purposes;ListMultipartUploads on OSS is the source of truth for in-flight state。

### Endpoints

All endpoints require `requireAuth`. Roles enforced per route. Error envelope `{ error: '<CODE>', ... }` per backend conventions. **HTTP wire shape 全 snake_case**(per backend 002 + iOS `MeetPRCodec` convention,本节所有 JSON 字段为 snake_case;iOS Swift domain camelCase 由 `MeetPRCodec` 转)。

#### Wire shape convention(per PR #8 review non-blocking #1)

- backend zod schema 收 snake_case;拒绝 camelCase 输入(400 VALIDATION_ERROR)
- backend response 输出 snake_case
- DTO mapping test `tests/dto/snake-case-validation.test.ts`(新)显式覆盖

#### Upload signing flow(per PR #8 review blocker 1 — D1=c decision)

| Method + Path                                    | Roles      | Request                                                                                                                  | Response 200                                                                            |
| ------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `POST /upload/initiate`                          | student    | `{ plan_exercise_id, set_index, content_type, part_count }`                                                              | `{ upload_id, oss_key, presigned_parts: [{part_number, presigned_url}] }`(URLs 1h 过期) |
| `POST /upload/sign-parts`                        | student    | `{ upload_id, oss_key, part_numbers: [int] }`                                                                            | `{ presigned_parts: [{part_number, presigned_url}] }`(re-sign,URLs 1h 过期)             |
| **`POST /upload/sign-thumbnail`(新增 per D1=c)** | student    | `{ plan_exercise_id, set_index, thumbnail_content_type: 'image/jpeg' }`                                                  | `{ thumbnail_oss_key, presigned_url }`(单 PUT 1h 过期,**不走 multipart**)               |
| `POST /upload/complete`                          | student    | `{ upload_id, oss_key, parts: [{part_number, etag}], duration_seconds, thumbnail_oss_key, thumbnail_etag, recorded_at }` | `201 VideoAttachmentWithURLs`(含 short-lived 1h `video_url` / `thumbnail_url`)          |
| `POST /upload/abort`                             | student    | `{ upload_id, oss_key }`                                                                                                 | `204`                                                                                   |
| `POST /privacy/consent`                          | any auth'd | `{ kind: 'video_visibility_v1' }`                                                                                        | `204`(idempotent)                                                                       |

**D1 决议(2026-05-15 PR #8 review blocker 1 决议 c)**:thumbnail **不走 multipart**(thumb 文件 < 200KB,5MB chunk multipart 是 over-engineering)。专用 `POST /upload/sign-thumbnail` endpoint 返回单 PUT presigned URL;`complete` 只收 `thumbnail_oss_key + thumbnail_etag`,backend `HeadObject` 验在。

##### `POST /upload/initiate` — request body(per D1=c — 不再支持 image content type)

```ts
z.object({
  plan_exercise_id: z.string().uuid(),
  set_index: z.number().int().min(0).max(99),
  content_type: z.enum(['video/mp4', 'video/quicktime']), // image/jpeg 走 /upload/sign-thumbnail
  part_count: z.number().int().min(1).max(10_000), // OSS limit
});
```

> **去掉了 `file_size_bytes` 字段**(per D2=c — backend complete 时 HeadObject 取真 size,client 报的值不可信)

Authorization(per PR #8 review blocker 3 — D3=a strict consent ordering):

- `req.user.role ∈ {coached_student, self_train_student}` else `403 AUTHORIZATION_FORBIDDEN`
- `student_id = req.user.id`(not in body — anchored from JWT)
- `plan_exercise_id` reaches published plan with `trainee_id = req.user.id`(same ownership SQL as 003 sets log)
- **Consent precondition(per D3=a)**:check `privacy_consents` row `(user_id=$userId, consent_kind='video_visibility_v1')` exists;若不存在 → `409 CONSENT_MISSING`,iOS 必须先 POST consent 才能 initiate。**strict ordering,no race**:`/privacy/consent` 必须 200 OK 后 iOS 才发 `/upload/initiate`

OSS interaction:

```
InitiateMultipartUpload(bucket='meetpr-videos-prod', key=`students/${userId}/sets/${planExerciseId}/${setIndex}/${uuid()}.mp4`)
  → { uploadId }
for i in 1..part_count:
  signed_url = signUrl('PUT', bucket, oss_key, expires=3600, headers={partNumber: i, uploadId})
  presigned_parts.push({part_number: i, presigned_url: signed_url})
return { upload_id, oss_key, presigned_parts }
```

`oss_key` format: `students/<studentId>/sets/<planExerciseId>/<setIndex>/<uuid>.mp4`(or `.mov` if `content_type = 'video/quicktime'`)。UUID ensures re-upload doesn't collide.

##### `POST /upload/sign-thumbnail` — request body(新增 per D1=c)

```ts
z.object({
  plan_exercise_id: z.string().uuid(),
  set_index: z.number().int().min(0).max(99),
  thumbnail_content_type: z.literal('image/jpeg'), // V0.1 仅 JPEG;V0.1.x 可扩 PNG/HEIC
});
```

Authorization:同 `POST /upload/initiate`(role + plan_exercise ownership + consent precondition)。

实装:

```
oss_key = `students/${userId}/thumbs/${planExerciseId}/${setIndex}/${uuid()}.jpg`
presigned_url = signUrl('PUT', bucket, oss_key, expires=3600)
return { thumbnail_oss_key: oss_key, presigned_url }
```

不调 OSS server-side(纯本地 HMAC,跟 sign-parts 同理)。iOS PUT 单文件到 presigned_url 完成 thumbnail upload — **不走 multipart**(thumb < 200KB,multipart 的 chunk overhead 浪费)。

##### `POST /upload/sign-parts` — request body

```ts
z.object({
  upload_id: z.string().min(1),
  oss_key: z.string().min(1),
  part_numbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(10_000),
});
```

Authorization(per PR #8 review blocker 4 — strict ossKey 解析):

- `oss_key` 必须**匹配 anchored regex**(不允许 path traversal):
  ```
  ^students/(?<studentId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})
   /sets/(?<planExerciseId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})
   /(?<setIndex>\d{1,2})
   /(?<filename>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|mov))$
  ```
- 解析后 `studentId === req.user.id` else `403 UPLOAD_OSS_KEY_OWNERSHIP`
- 解析后 `planExerciseId` 走 published-plan ownership 校验(同 initiate)
- 拒绝 `oss_key` 含 `..` / `%2F` / URL-encoded slash / 非 UUID path components / 非允许扩展名(对 video 路径)
- 拒绝 `oss_key` prefix 错误(必须 `students/<self>/sets/`,不是 `students/<self>/thumbs/`)
- consent precondition 同 initiate

> **禁止** 用 `oss_key.startsWith('students/' + req.user.id + '/')` 简化判定 — `students/<self>../<other>/sets/...` 这种 traversal 字符串会 startsWith 通过但实际指向 other student。必须 anchored regex parse + each-component 独立 verify。

无 DB row(incomplete upload)→ 仅靠 oss_key 解析,**不查 OSS**(避免 cross-tenant inference + cost)。

Used by iOS when 1h presigned-URL expires mid-resume(per iOS spec 027 §2.3 + §0.2 amend re-sign flow on `403 SignatureDoesNotMatch`)。

Returns new 1h-expiry presigned PUT URLs for the requested `part_numbers`. Backend does NOT call OSS at sign-parts(signed URLs are local cryptographic ops with bucket AK/SK)。

##### `POST /upload/complete` — request body(per D1=c + D2=c + D3=a + blocker 4)

```ts
z.object({
  upload_id: z.string().min(1),
  oss_key: z.string().min(1),
  parts: z
    .array(
      z.object({
        part_number: z.number().int().min(1).max(10_000),
        etag: z.string().min(1),
      }),
    )
    .min(1)
    .max(10_000),
  duration_seconds: z.number().min(0.1).max(121),
  thumbnail_oss_key: z.string().min(1), // 从 POST /upload/sign-thumbnail 拿到的;PUT 到 OSS 完成后传回
  thumbnail_etag: z.string().min(1), // OSS PutObject 返的 etag
  recorded_at: z.string().datetime(), // ISO-8601 from client AVAsset metadata
});
```

> **D1=c 重写**:thumbnail **不走** multipart — 上面 `POST /upload/sign-thumbnail` 已签 1 个 PUT URL,iOS 单 PUT 完后 OSS 返 etag,只要传 `thumbnail_oss_key + thumbnail_etag` 即可。无 `thumbnail_upload_id` / `thumbnail_parts`(简化)。

Authorization + verification(per blocker 4 + D2=c + D3=a):

```
1. 解析 oss_key(anchored regex,同 sign-parts 规则)— 验证 studentId === req.user.id + planExerciseId published-plan ownership;失败 → 403
2. 解析 thumbnail_oss_key(anchored regex,但路径前缀必须是 students/<self>/thumbs/) — 验证 studentId === req.user.id;失败 → 403
3. Verify upload still in progress:ListMultipartUploads(bucket, prefix=oss_key) returns 1 row with matching upload_id;失败 → 400 UPLOAD_NOT_FOUND
4. CompleteMultipartUpload(bucket, oss_key, upload_id, parts) → final object etag;失败 → 400 UPLOAD_INVALID_PARTS
5. HeadObject(bucket, oss_key) → 取 video file_size_bytes(authoritative — 防 client 报假 size);若 > 1 GiB → 400 UPLOAD_TOO_LARGE
6. HeadObject(bucket, thumbnail_oss_key) → 验在 + 取 thumbnail file_size_bytes;若 etag mismatch → 400 UPLOAD_INVALID_THUMBNAIL
7. **Consent re-check(D3=a 防御 race)**:lookup privacy_consents row(user_id=$userId, consent_kind='video_visibility_v1');若不存在 → 409 CONSENT_MISSING(iOS 必须先 POST /privacy/consent 才能 complete;**initiate 时已检过,但这是 defense in depth**)
8. INSERT video_attachments row:
   - id = gen_random_uuid()
   - student_id = req.user.id
   - plan_exercise_id, set_index from parsed oss_key path components
   - oss_key, oss_upload_id, duration_seconds, file_size_bytes (from step 5 HeadObject), thumbnail_oss_key
   - recorded_at (validated)
   - coach_visible_at = uploaded_at(consent already exists per step 7,直接 set 时间戳)
   ON CONFLICT (student_id, plan_exercise_id, set_index) DO UPDATE SET ...   -- 重录覆盖
9. Generate response:presign GET URLs for video + thumbnail(1h)
10. Return 201 VideoAttachmentWithURLs
```

Failure modes:

- `400 UPLOAD_NOT_FOUND`:OSS ListMultipartUploads returns 0 matches(`upload_id` never initiated or already aborted)
- `400 UPLOAD_INVALID_PARTS`:CompleteMultipartUpload OSS error(mismatched etags)
- `400 UPLOAD_INVALID_THUMBNAIL`:`thumbnail_oss_key` HeadObject 失败 / etag mismatch
- `400 UPLOAD_TOO_LARGE`:HeadObject 取出 video file size > 1 GiB(authoritative size,不信 client 报)
- `400 UPLOAD_PLAN_EXERCISE_NOT_PUBLISHED`:解析 `plan_exercise_id` 不指向 student 的 published plan(e.g. coach paused mid-upload)
- `403 UPLOAD_OSS_KEY_OWNERSHIP`:解析 `oss_key` / `thumbnail_oss_key` student_id != req.user.id 或 prefix 错(video 必须 `students/<self>/sets/`,thumbnail 必须 `students/<self>/thumbs/`)
- `409 CONSENT_MISSING`:`privacy_consents.video_visibility_v1` 不存在 — iOS 必须先 `POST /privacy/consent`(per D3=a strict ordering)

`VideoAttachmentWithURLs` response shape(snake_case wire — iOS `MeetPRCodec` 转 camelCase domain):

```json
{
  "id": "uuid",
  "student_id": "uuid",
  "plan_exercise_id": "uuid",
  "set_index": 2,
  "oss_key": "students/.../...mp4",
  "duration_seconds": "45.20",
  "file_size_bytes": 12345678,
  "thumbnail_oss_key": "students/.../thumbs/...jpg",
  "recorded_at": "2026-05-15T14:00:00.000Z",
  "uploaded_at": "2026-05-15T14:02:30.000Z",
  "coach_visible_at": "2026-05-15T14:02:30.000Z",
  "video_url": "https://meetpr-videos-prod.oss-cn-hangzhou.aliyuncs.com/students/.../...mp4?Expires=...&OSSAccessKeyId=...&Signature=...",
  "thumbnail_url": "https://meetpr-videos-prod.oss-cn-hangzhou.aliyuncs.com/students/.../thumbs/...jpg?Expires=...&OSSAccessKeyId=...&Signature=..."
}
```

##### `POST /upload/abort` — request body(simplified per D1=c)

```ts
z.object({
  upload_id: z.string().min(1),
  oss_key: z.string().min(1),
  // thumbnail 单 PUT 不需要 abort(无 in-progress multipart state);若 PUT 成功后想撤销,V0.1.x 加专门 delete endpoint
});
```

Implementation:`AbortMultipartUpload(bucket, oss_key, upload_id)`。Authorization:解析 `oss_key` 严格 regex 验 studentId(同 sign-parts)。Idempotent:re-abort 返 204(OSS 已 abort 返 404 → swallow)。

#### Read-side endpoints

| Method + Path              | Roles                        | Request                           | Response 200                                                                                    |
| -------------------------- | ---------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /students/:id/videos` | student(self) / coach(owner) | —                                 | `200 { items: VideoAttachmentWithURLs[] }`(每条带短期 1h presigned `videoURL` / `thumbnailURL`) |
| `POST /privacy/consent`    | any auth'd                   | `{ kind: 'video_visibility_v1' }` | `204`(idempotent)                                                                               |

##### `GET /students/:id/videos`

Authorization (same pattern as 003 `/students/:id/sets`):

- If `req.user.id === params.id`(self student) → allow,query 学员自己全部视频
- Else require `req.user.role === 'coach'`,且 **每条返回的 video 都必须来自当前 coach 的 published plan**(per PR #8 review blocker 5 — 防多 coach 数据泄露)

Student self query(全 own videos,consent state 不限):

```sql
SELECT va.*
  FROM video_attachments va
 WHERE va.student_id = $userId
 ORDER BY va.recorded_at DESC;
```

Coach query(**必须 join plans 加 coach_id 过滤**,per PR #8 review blocker 5):

```sql
SELECT va.*
  FROM video_attachments va
  JOIN plan_exercises pe ON va.plan_exercise_id = pe.id
  JOIN plan_days pd      ON pe.plan_day_id      = pd.id
  JOIN plans p           ON pd.plan_id          = p.id
 WHERE va.student_id      = $studentId
   AND va.coach_visible_at IS NOT NULL    -- consent given
   AND p.coach_id          = $coachId      -- ← 关键:当前 coach 拥有该 plan_exercise
   AND p.trainee_id        = $studentId
   AND p.status            = 'published'
 ORDER BY va.recorded_at DESC;
```

**禁止** coach query 简化为 `SELECT * FROM video_attachments WHERE student_id = $studentId AND coach_visible_at IS NOT NULL` 在 ownership precondition 通过后跑 — 会泄露 student 在**其他 coach plan_exercise** 下产出的视频给当前 coach。

For each row, generate short-lived 1h presigned GET URLs(signed locally, no OSS call):

```
video_url     = signUrl('GET', bucket, va.oss_key,            expires=3600)
thumbnail_url = signUrl('GET', bucket, va.thumbnail_oss_key,  expires=3600)
```

##### `POST /privacy/consent`

```ts
z.object({
  kind: z.enum(['video_visibility_v1']),
});
```

Inserts a `privacy_consents` row `(user_id, consent_kind=$kind, agreed_at=now(), user_agent=req.headers['user-agent'], ip_address=req.ip)`. `ON CONFLICT (user_id, consent_kind) DO NOTHING` for idempotency.

V0.1 only `video_visibility_v1` kind defined;V0.1.x adds `terms_of_service_vN` / `privacy_policy_vN`。

Returns 204。

**iOS 调用顺序(per D3=a strict consent ordering)**:

```
学员 app 首次想上传视频
  ↓ iOS 显示"视频对教练可见"同意 modal
  ↓ 用户点同意
await POST /privacy/consent { kind: 'video_visibility_v1' } → 200 OK
  ↓
await POST /upload/initiate { ... } → 200 OK { upload_id, ... }
  ↓
await POST /upload/sign-thumbnail { ... } → 200 OK { thumbnail_oss_key, presigned_url }
  ↓
多个 PUT to presigned_part_urls(并行)
PUT to thumbnail presigned_url
  ↓
await POST /upload/complete { ... }  → 201 VideoAttachmentWithURLs
```

backend 在 `/upload/initiate` 和 `/upload/complete` 两处都 enforce consent precondition(defense in depth) — `409 CONSENT_MISSING` if `privacy_consents.video_visibility_v1` row 不存在 for `req.user.id`。**禁止** consent 后到达 retro update `coach_visible_at`(无 race / audit clean / 时序确定)。

### Authorization helpers

Reuse `requireAuth` from 001 + `requireRole(...)` from 002. **`oss_key` 解析必须用 anchored regex parser**(per PR #8 review blocker 4)— **禁止** 用 `oss_key.split('/')[1]` 或 `oss_key.startsWith('students/...')` 简化判定,因为 `students/<self>../<other>/sets/...` 这种 path traversal 字符串能 startsWith 通过但实际指向 other student。

```ts
// helpers/oss-key-parse.ts(新建)
const VIDEO_OSS_KEY_RE =
  /^students\/(?<studentId>[0-9a-f-]{36})\/sets\/(?<planExerciseId>[0-9a-f-]{36})\/(?<setIndex>\d{1,2})\/(?<filename>[0-9a-f-]{36}\.(?:mp4|mov))$/;
const THUMB_OSS_KEY_RE =
  /^students\/(?<studentId>[0-9a-f-]{36})\/thumbs\/(?<planExerciseId>[0-9a-f-]{36})\/(?<setIndex>\d{1,2})\/(?<filename>[0-9a-f-]{36}\.jpg)$/;

export function parseVideoOssKey(key: string): {
  studentId: string;
  planExerciseId: string;
  setIndex: number;
} {
  const m = VIDEO_OSS_KEY_RE.exec(key);
  if (!m) throw new ApiError('UPLOAD_OSS_KEY_OWNERSHIP', 403);
  return {
    studentId: m.groups!.studentId,
    planExerciseId: m.groups!.planExerciseId,
    setIndex: parseInt(m.groups!.setIndex, 10),
  };
}
// 同 parseThumbnailOssKey
```

每个 upload handler 第一步:`parseVideoOssKey(req.body.oss_key)` + `parseThumbnailOssKey(req.body.thumbnail_oss_key)` → 比 `parsed.studentId === req.user.id` else throw 403。

`tests/oss-key-parse.test.ts`(新)必须覆盖 traversal:

- `students/<self>/../<other>/sets/<pe>/0/<uuid>.mp4` → 403
- `students/<self>/sets/<pe>%2F0/<uuid>.mp4` → 403(URL-encoded slash)
- `students/<self>/thumbs/<pe>/0/<uuid>.mp4` 用 video parser → 403(wrong prefix `thumbs` vs `sets`)
- `students/<self>/sets/<pe>/0/<uuid>.jpg` 用 video parser → 403(wrong extension)
- `students/<self>/sets/<pe>/100/<uuid>.mp4` → 403(set_index 超 2 digit)
- `students/<self>/sets/not-uuid/0/<uuid>.mp4` → 403(plan_exercise_id 非 UUID 格式)

### Error code catalogue (additions)

| Code                                 | HTTP | Meaning                                                                           |
| ------------------------------------ | ---- | --------------------------------------------------------------------------------- |
| `UPLOAD_VALIDATION_ERROR`            | 400  | zod validation fails on initiate / sign-thumbnail / sign-parts / complete / abort |
| `UPLOAD_PLAN_EXERCISE_NOT_PUBLISHED` | 400  | plan_exercise_id does not reach published plan for req.user.id                    |
| `UPLOAD_NOT_FOUND`                   | 400  | `upload_id` not found via OSS ListMultipartUploads                                |
| `UPLOAD_INVALID_PARTS`               | 400  | CompleteMultipartUpload fails(etag mismatch)                                      |
| `UPLOAD_INVALID_THUMBNAIL`           | 400  | thumbnail HeadObject 失败 / etag mismatch                                         |
| `UPLOAD_TOO_LARGE`                   | 400  | HeadObject 取出 file size > 1 GiB(authoritative,不信 client 报)                   |
| `UPLOAD_OSS_KEY_OWNERSHIP`           | 403  | parsed oss_key student_id != req.user.id / wrong prefix / 含 traversal            |
| `CONSENT_MISSING`                    | 409  | `privacy_consents.video_visibility_v1` row 不存在 for req.user.id;先 POST consent |
| `VIDEO_NOT_FOUND`                    | 404  | Reserved for future per-video endpoints(V0.1.x delete / re-upload)                |

### File layout

```
src/
├── routes/
│   ├── ... (existing)
│   ├── upload.ts                  # NEW (this spec): POST /upload/{initiate,sign-thumbnail,sign-parts,complete,abort}
│   ├── videos.ts                  # NEW: GET /students/:id/videos
│   └── privacy.ts                 # NEW: POST /privacy/consent
├── handlers/
│   ├── upload-initiate.ts         # NEW
│   ├── upload-sign-thumbnail.ts   # NEW(per D1=c — thumbnail 不走 multipart)
│   ├── upload-sign-parts.ts       # NEW
│   ├── upload-complete.ts         # NEW(most logic;OSS Complete + HeadObject + DB INSERT + presign read URLs)
│   ├── upload-abort.ts            # NEW
│   ├── videos-fetch.ts            # NEW
│   └── privacy-consent.ts         # NEW
├── helpers/
│   └── oss-key-parse.ts           # NEW: anchored regex parser for video / thumbnail oss_key,traversal-safe
├── oss/
│   ├── client.ts                  # NEW: aliyun-oss-nodejs wrapper, AccessKey/SecretKey via env
│   └── presign.ts                 # NEW: signUrl helper for PUT/GET with TTL
└── db/types.ts                    # extend with VideoAttachmentsTable + PrivacyConsentsTable
```

`createApp({ config, logger, db, oss })` — add `oss` to factory args, inject the aliyun-oss client.

### Environment / secrets

| Env var                 | Source                                         | V0.1     |
| ----------------------- | ---------------------------------------------- | -------- |
| `OSS_ACCESS_KEY_ID`     | Bitwarden `MeetPR OSS AK`                      | Required |
| `OSS_ACCESS_KEY_SECRET` | Bitwarden `MeetPR OSS AK`                      | Required |
| `OSS_BUCKET`            | hardcode `meetpr-videos-prod` in config        | Default  |
| `OSS_REGION`            | hardcode `oss-cn-hangzhou` in config           | Default  |
| `OSS_ENDPOINT`          | derived `https://oss-cn-hangzhou.aliyuncs.com` | Default  |

SAE env vars per iOS spec 026 §1.2 deploy step.

### Tests

| File                                                              | Coverage                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/upload-initiate.test.ts`(new)                              | POST happy;authorization(own student_id via oss_key parse);403 not student role;400 plan_exercise_id not published;**409 CONSENT_MISSING when consent row 不在**;mock OSS InitiateMultipartUpload                                                                                                                    |
| `tests/upload-sign-thumbnail.test.ts`(新 per D1=c)                | POST happy;authorization;无 OSS call;只签单 PUT URL(no multipart parts);CONSENT_MISSING                                                                                                                                                                                                                              |
| `tests/upload-sign-parts.test.ts`(new)                            | POST happy;**oss_key anchored regex** parse;no OSS call;deterministic re-sign URLs                                                                                                                                                                                                                                   |
| `tests/upload-complete.test.ts`(new)                              | POST happy → DB row insert;ON CONFLICT 重录 update;authorization;UPLOAD_NOT_FOUND / UPLOAD_INVALID_PARTS / UPLOAD_INVALID_THUMBNAIL / **UPLOAD_TOO_LARGE**(HeadObject 取出 size > 1 GiB) / **CONSENT_MISSING**(consent 后到 race);**coach_visible_at = uploaded_at**(consent always exists per D3=a strict ordering) |
| `tests/upload-abort.test.ts`(new)                                 | Idempotent;authorization                                                                                                                                                                                                                                                                                             |
| `tests/videos-fetch.test.ts`(new)                                 | Self student sees all own videos;**coach 仅看自己 plan_exercise 下的视频**(per blocker 5 — fixture 加 multi-coach scenario:student A 同时被 coach B + coach C 接收,coach B 不能看到 coach C plan_exercise 下的 video);403 non-owner coach;ordering                                                                   |
| `tests/privacy-consent.test.ts`(new)                              | POST happy → DB row;idempotent re-POST DO NOTHING;UA + IP captured                                                                                                                                                                                                                                                   |
| `tests/migrations/0007-video-and-consent.test.ts`(new)            | Migration runs;UNIQUE(student_id, plan_exercise_id, set_index);CHECK duration ≤ 121;CHECK file size ≤ 1 GiB;UNIQUE(user_id, consent_kind)                                                                                                                                                                            |
| `tests/oss/presign.test.ts`(new)                                  | signUrl returns valid presigned URL format;expiry parameter respected;PUT vs GET distinction;**1h TTL invariant 校验**(per D3 ordering)                                                                                                                                                                              |
| `tests/helpers/oss-key-parse.test.ts`(新 per blocker 4)           | Anchored regex 解析;rejected:`..` traversal / `%2F` encoded slash / wrong prefix(thumbs vs sets)/ wrong extension / set_index 超 99 / 非 UUID path components / video parser 不接 image / thumbnail parser 不接 video                                                                                                |
| `tests/dto/snake-case-validation.test.ts`(新 per non-blocking #1) | zod schema 拒绝 camelCase 输入(400 VALIDATION_ERROR);response 全 snake_case;round-trip with iOS MeetPRCodec test fixture                                                                                                                                                                                             |

OSS client mock strategy: wrap `aliyun-oss` calls in `src/oss/client.ts` interface; tests inject a `FakeOSSClient` that returns canned `InitiateMultipartUpload` / `CompleteMultipartUpload` / `ListMultipartUploads` results without network. Integration tests use a separate Aliyun "staging" OSS bucket (out of CI; manual only — added to deploy checklist).

### Out of scope

- **MPS H.265 transcode** for "主项 key set" — Stage 4 separate spec (per ADR-004 §11 lean,Stage 1-3 client H.264 only)
- **Server-side thumbnail generation** — client生成 + uploads via same multipart pipeline (per iOS spec 027 §2.4)
- **OSS bucket cross-region replication / CDN** — Stage 5+ overseas学员
- **Video delete / re-record UI flow** — V0.1.x candidate (DB schema already supports ON CONFLICT overwrite,but no explicit DELETE endpoint)
- **Video annotation / timestamp feedback** — V0.2+ evaluation-workflow
- **Watermark / DRM** — never V1 (small target audience)
- **Encrypted at rest** — V1.5+ KMS (per lifecycle-stages §11)
- **Multi-region OSS** — V1.5+
- **Stream / range download** — V0.1 simple full-object presigned GET;V0.1.x optimize

### Deploy / OSS bucket prep (one-time)

Aliyun console steps (record in deploy checklist):

1. Navigate to OSS console → bucket `meetpr-videos-prod`
2. Permissions tab → 读写权限 → 私有
3. CORS tab → add rule: `PUT, GET, HEAD` from `*` (V0.1.x narrow when custom domain ready)
4. Lifecycle tab → 留待 Stage 4 (do not enable transitions yet)
5. AccessKey:create **dedicated RAM user** `meetpr-backend-oss-v01` 用 **自定义 least-privilege policy `meetpr-videos-prod-readwrite`**(per PR #8 review non-blocking #2 — **不要** 用 `AliyunOSSFullAccess` 系统策略,即便加 scope 也是宽 managed policy)。Custom policy 只允许:`PutObject` / `GetObject` / `DeleteObject` / `AbortMultipartUpload` / `ListMultipartUploads` / `ListParts` / `HeadObject` on `acs:oss:*:*:meetpr-videos-prod/*` + `ListObjects` / `GetBucketInfo` on `acs:oss:*:*:meetpr-videos-prod`。**绝不** 使用 root account AK(per ADR-004 §6 + secrets-pointer §4 强制)
6. Record AK ID + Secret in Bitwarden `MeetPR OSS AK`
7. Inject into SAE env vars `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET`

## Estimate (impl PR)

| Block                                                                       | Days     |
| --------------------------------------------------------------------------- | -------- |
| 0007 migration + tests                                                      | 0.4d     |
| OSS client wrapper + presign helper + tests                                 | 0.8d     |
| /upload/initiate handler + tests                                            | 0.5d     |
| /upload/sign-parts handler + tests                                          | 0.3d     |
| /upload/complete handler + tests (most complex)                             | 1.2d     |
| /upload/abort handler + tests                                               | 0.2d     |
| GET /students/:id/videos + tests                                            | 0.5d     |
| POST /privacy/consent + tests                                               | 0.3d     |
| DB Database type extension + integration tests                              | 0.3d     |
| Manual: OSS bucket config + RAM user + AccessKey + Bitwarden + Postman test | 0.5d     |
| **Total**                                                                   | **≈ 5d** |

## Risks / implementer notes

1. **Aliyun OSS SDK choice**:`ali-oss`(official)supports multipart server-side ops + presigned URL signing. Confirm version pin in package.json,Node 22 compatibility verified.
2. **Presigned URL TTL = 1h is invariant**:iOS spec 027 §4.4 says all presigned URLs(initiate / sign-thumbnail / sign-parts / read)**统一 1h 过期**。Don't extend to 24h "for convenience" — long TTLs increase replay attack surface。test 校验 expiry parameter。
3. **ossKey 解析必须用 anchored regex parser**(per PR #8 review blocker 4):`helpers/oss-key-parse.ts` 用 explicit regex 校验 `students/<UUID>/sets/<UUID>/<digits>/<UUID>.(mp4|mov)` 完整路径 + thumbnail 单独 parser 校验 `students/<UUID>/thumbs/<UUID>/<digits>/<UUID>.jpg`。**禁止** `oss_key.startsWith('students/' + userId)` / `oss_key.split('/')[1]` — 这些 startsWith 会让 `students/<self>../<other>/sets/...` 通过但实际指向 other student。每个解析过的 component(studentId / planExerciseId / setIndex)独立 verify。
4. **RAM user scope**(per non-blocking #2):never use root AccessKey for bucket access;use **dedicated RAM user `meetpr-backend-oss-v01` + 自定义 least-privilege policy `meetpr-videos-prod-readwrite`**(已在 2026-05-15 OSS RAM user setup 中创建,per secrets-pointer §4)。**不要** 用系统策略 `AliyunOSSFullAccess`(即便加 scope condition 也是 broad managed policy)。
5. **D3=a strict consent ordering**(per PR #8 review blocker 3):consent 必须先 POST `/privacy/consent` 200 OK 后才能 initiate / complete;backend 在 initiate + complete 两处都 enforce(409 CONSENT_MISSING)。**禁止** retro update `coach_visible_at`:`coach_visible_at = uploaded_at` 一次性 set,无 NULL 中间态。audit 角度 clean — 任何 video row 一旦 INSERT,visible 时序确定。
6. **D2=c authoritative file size**(per PR #8 review blocker 2):backend complete handler 用 `HeadObject(bucket, oss_key)` 取 OSS 真 size,**不信** client 报的 `file_size_bytes`(易被 spoof / lying client)。`UPLOAD_TOO_LARGE` 在 HeadObject 后判定。
7. **OSS object lifecycle on overwrite**:`ON CONFLICT (student_id, plan_exercise_id, set_index)` overwrites `oss_key` to the new UUID;**old OSS object becomes orphan**(no DB row points to it)。V0.1 accepts orphan storage cost(内测期 < ¥1/month)。V0.1.x adds cleanup job that diff `video_attachments.oss_key` against bucket ListObjects + deletes orphans nightly。
8. **D1=c — thumbnail 不走 multipart**(per PR #8 review blocker 1):新 `POST /upload/sign-thumbnail` endpoint 返单 PUT URL。Rationale:thumb 文件 < 200KB,5MB multipart chunk 是 over-engineering(每个 thumb 1 part 的"假 multipart")。专用 endpoint + 单 PUT 更 explicit + 资源类型 right-sized。
9. **`POST /upload/sign-parts` + `POST /upload/sign-thumbnail` 都 does NOT call OSS**:presigned URLs are pure crypto ops with bucket AK/SK。这俩 endpoint 都是 "give me HMAC signatures"。Don't accidentally call `ListMultipartUploads` here — wastes API quota + reveals nothing useful。
10. **V0.1 file size cap = 1 GiB**:defensive against ProRes / 4K 原片 fallback。Internal 内测 < 1 GiB always;if hit cap iOS spec 027 fallback already gates by file size 并 warn "蜂窝可能耗大量流量"。Backend hard rejects > 1 GiB(via HeadObject size check)regardless。
11. **Multi-coach video leakage prevention**(per PR #8 review blocker 5):`GET /students/:id/videos` coach query 必须 join `plans` + `plans.coach_id = $coachId` 过滤,**不是** 先 ownership precondition 通过后返该 student 全部 consent-given videos。fixture 必须覆盖 "student 同时被 2 coaches 接收 + 各 coach plan 下产 video" 验证 coach A 不能看 coach B 的 plan_exercise 下视频。

## Codex review focus

- 0007 migration:`UNIQUE (student_id, plan_exercise_id, set_index)` + CHECK constraints valid PG;`UNIQUE (user_id, consent_kind)` on privacy_consents
- `POST /upload/initiate` 不再支持 `image/jpeg` content type;thumbnail 走专用 `/upload/sign-thumbnail`(per D1=c blocker 1)
- `POST /upload/sign-thumbnail` 单 PUT URL,不走 multipart
- `POST /upload/sign-parts` + `/upload/sign-thumbnail` 都 not call OSS server-side(纯本地 HMAC)
- `POST /upload/complete` HeadObject 取真 file_size_bytes(per D2=c blocker 2);双 consent check(initiate + complete defense in depth,per D3=a blocker 3);`coach_visible_at = uploaded_at` 一次性 set,无 NULL 中间态
- `GET /students/:id/videos` **coach query 必须 join plans + coach_id 过滤**(per blocker 5 防多 coach 数据泄露)
- **`oss_key` 解析用 anchored regex**(per blocker 4):`helpers/oss-key-parse.ts` video + thumbnail 两套 parser;拒绝 `..` / `%2F` / 非 UUID path components / wrong prefix / wrong extension
- All HTTP DTO snake_case;`tests/dto/snake-case-validation.test.ts` 校验
- Test coverage:11 个 new test files(migrations + 5 upload endpoints + videos-fetch + privacy-consent + oss-key-parse + presign + DTO)
- RAM user 用 **自定义 least-privilege policy** `meetpr-videos-prod-readwrite`,**不要** 用 `AliyunOSSFullAccess` 系统策略(per non-blocking #2)
- iOS spec 027 0.2 amend 的 `POST /upload/sign-parts` re-sign 流程在本 spec endpoint contract 中完整体现
- 1h URL TTL invariant 统一覆盖 initiate / sign-thumbnail / sign-parts / read URL,不被实装期"为方便延长到 24h"破坏
- `oss_upload_id` 注释一致(per non-blocking #3):kept post-complete for audit + 重录 abort 路径,**不** cleared after

## Per backend Spec workflow

This is the **spec PR** (Step 1). Codex impl PR `feat/004-video-upload` follows after this merges. iOS spec 027 + 029 impl PRs depend on Codex backend 004 impl PR landing on `staging`.

## Cross-PR dependency map

| Upstream PR                                                  | Required state        | Why                                                                                                                                                 |
| ------------------------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| backend PR #6 (`chore/v01-unfreeze`)                         | merged to staging     | CLAUDE.md ❄️ FROZEN callout removed                                                                                                                 |
| backend PR #7 (`chore/spec-003-student-actions`)             | spec merged           | This spec doesn't depend on 003 endpoints,but **003 must impl first** so SAE deploy / DB migrations / Postgres setup is in place when 004 impl runs |
| iOS PR #115 (`chore/spec-027-video-upload`)                  | merged to iOS main ✅ | iOS spec 027 references this backend spec                                                                                                           |
| iOS PR #117 (`chore/spec-029-coach-student-detail-feedback`) | merged to iOS main ✅ | iOS spec 029 consumes `GET /students/:id/videos`                                                                                                    |
