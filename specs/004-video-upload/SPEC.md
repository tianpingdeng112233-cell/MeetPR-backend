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
  oss_upload_id        TEXT NOT NULL,   -- OSS multipart upload ID; cleared after CompleteMultipartUpload but kept for audit
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

All endpoints require `requireAuth`. Roles enforced per route. Error envelope `{ error: '<CODE>', ... }` per backend conventions.

#### Upload signing flow

| Method + Path             | Roles   | Request                                                                                                                               | Response 200                                                                        |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `POST /upload/initiate`   | student | `{ planExerciseId, setIndex, contentType, fileSizeBytes, partCount }`                                                                 | `{ uploadId, ossKey, presignedParts: [{partNumber, presignedURL}] }`(URLs 1h 过期)  |
| `POST /upload/sign-parts` | student | `{ uploadId, ossKey, partNumbers: [int] }`                                                                                            | `{ presignedParts: [{partNumber, presignedURL}] }`(re-sign for resume,URLs 1h 过期) |
| `POST /upload/complete`   | student | `{ uploadId, ossKey, parts: [{partNumber, etag}], durationSeconds, thumbnailUploadId, thumbnailParts, thumbnailOssKey?, recordedAt }` | `201 VideoAttachmentWithURLs`(含 short-lived 1h `videoURL` / `thumbnailURL`)        |
| `POST /upload/abort`      | student | `{ uploadId, ossKey, thumbnailUploadId?, thumbnailOssKey? }`                                                                          | `204`                                                                               |

##### `POST /upload/initiate` — request body

```ts
z.object({
  planExerciseId: z.string().uuid(),
  setIndex: z.number().int().min(0).max(99),
  contentType: z.enum(['video/mp4', 'video/quicktime']),
  fileSizeBytes: z.number().int().min(1).max(1_073_741_824), // 1 GiB
  partCount: z.number().int().min(1).max(10_000), // OSS limit
});
```

Authorization:

- `req.user.role ∈ {coached_student, self_train_student}` else `403 AUTHORIZATION_FORBIDDEN`
- `student_id = req.user.id` (not in body)
- `plan_exercise_id` reaches published plan with `trainee_id = req.user.id` (same ownership SQL as 003 sets log)
- **No prior consent gate at initiate** — iOS shows modal pre-upload, but consent record creation can race;backend checks at `POST /upload/complete` and either sets `coach_visible_at` or leaves NULL

OSS interaction:

```
InitiateMultipartUpload(bucket='meetpr-videos-prod', key=`students/${userId}/sets/${planExerciseId}/${setIndex}/${uuid()}.mp4`)
  → { uploadId }
for i in 1..partCount:
  signedURL = signUrl('PUT', bucket, ossKey, expires=3600, headers={partNumber: i, uploadId})
  presignedParts.push({partNumber: i, presignedURL: signedURL})
return { uploadId, ossKey, presignedParts }
```

`ossKey` format: `students/<studentId>/sets/<planExerciseId>/<setIndex>/<uuid>.mp4` (or `.mov` if contentType = quicktime). UUID ensures re-upload doesn't collide.

##### `POST /upload/sign-parts` — request body

```ts
z.object({
  uploadId: z.string().min(1),
  ossKey: z.string().min(1),
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(10_000),
});
```

Authorization:

- Verify `ossKey` starts with `students/${req.user.id}/` — student can only re-sign own uploads
- No DB row exists yet for this upload (incomplete); ownership inferred from `ossKey` prefix only. **No `LIST` against OSS** (avoid cross-tenant inference + cost).

Used by iOS when 1h presigned-URL expires mid-resume (per iOS spec 027 §2.3 + §0.2 amend re-sign flow on `403 SignatureDoesNotMatch`).

Returns new 1h-expiry presigned PUT URLs for the requested part numbers. Backend does NOT call OSS at sign-parts (signed URLs are local cryptographic ops with bucket AK/SK).

##### `POST /upload/complete` — request body

```ts
z.object({
  uploadId: z.string().min(1),
  ossKey: z.string().min(1),
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1).max(10_000),
        etag: z.string().min(1),
      }),
    )
    .min(1)
    .max(10_000),
  durationSeconds: z.number().min(0.1).max(121),
  thumbnailUploadId: z.string().min(1), // separate small multipart upload for the thumb JPG
  thumbnailParts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1),
        etag: z.string().min(1),
      }),
    )
    .min(1),
  thumbnailOssKey: z.string().min(1).optional(), // derived if omitted; included for client-side determinism
  recordedAt: z.string().datetime(), // ISO-8601 from client AVAsset metadata
});
```

> **Thumbnail upload note**: iOS spec 027 §2.4 says thumbnails are client-generated via `AVAssetImageGenerator`. To keep this spec lean, thumbnails go through the **same multipart-upload pipeline** but with `ossKey` derived from video ossKey:
>
> ```
> videoOssKey = students/<userId>/sets/.../<uuid>.mp4
> thumbnailOssKey = students/<userId>/thumbs/.../<uuid>.jpg   # different prefix
> ```
>
> iOS pre-fetches a thumbnail-specific `uploadId` via `POST /upload/initiate` with `contentType='image/jpeg'` (or via a thumbnail-specific endpoint — V0.1.x simplification candidate). For V0.1 thumbnails are small (~50-200 KB);CompleteMultipartUpload on a 1-part upload is the simplest path.

Implementation:

```
1. Authorization: ossKey starts with students/${req.user.id}/
2. Verify upload still in progress: ListMultipartUploads(bucket, prefix=ossKey) returns 1 row with matching uploadId
3. CompleteMultipartUpload(bucket, ossKey, uploadId, parts) → etag of final object
4. CompleteMultipartUpload for thumbnail similarly
5. Lookup privacy_consents row WHERE user_id=req.user.id AND consent_kind='video_visibility_v1'
6. INSERT video_attachments row:
   - id = gen_random_uuid()
   - student_id = req.user.id
   - plan_exercise_id from ossKey path component (parse) — validate matches a published plan FK
   - set_index from ossKey path component (parse)
   - oss_key, oss_upload_id, duration_seconds, file_size_bytes, thumbnail_oss_key
   - recorded_at (validated)
   - coach_visible_at = (consent exists ? uploaded_at : NULL)
   ON CONFLICT (student_id, plan_exercise_id, set_index) DO UPDATE SET
     oss_key = EXCLUDED.oss_key,
     oss_upload_id = EXCLUDED.oss_upload_id,
     duration_seconds = EXCLUDED.duration_seconds,
     ...    -- 重录覆盖,delete old OSS object out-of-band V0.1.x
     uploaded_at = now()
7. Generate response: presign GET URLs for video + thumbnail (1h expiry)
8. Return 201 VideoAttachmentWithURLs
```

Failure modes:

- `400 UPLOAD_NOT_FOUND`: OSS ListMultipartUploads returns 0 matches (uploadId never initiated or already aborted)
- `400 UPLOAD_INVALID_PARTS`: CompleteMultipartUpload OSS error (mismatched etags)
- `403 AUTHORIZATION_FORBIDDEN`: ossKey path-component student_id != req.user.id
- `400 UPLOAD_PLAN_EXERCISE_NOT_PUBLISHED`: parsed plan_exercise_id no longer points to a published plan (e.g. coach paused mid-upload)

`VideoAttachmentWithURLs` response shape (round-trip with iOS `CoreModels.VideoAttachment` + extra URLs):

```json
{
  "id": "uuid",
  "studentId": "uuid",
  "planExerciseId": "uuid",
  "setIndex": 2,
  "ossKey": "students/.../...mp4",
  "durationSeconds": "45.20",
  "fileSizeBytes": 12345678,
  "thumbnailOssKey": "students/.../thumbs/...jpg",
  "recordedAt": "2026-05-15T14:00:00.000Z",
  "uploadedAt": "2026-05-15T14:02:30.000Z",
  "coachVisibleAt": "2026-05-15T14:02:30.000Z",
  "videoURL": "https://meetpr-videos-prod.oss-cn-hangzhou.aliyuncs.com/students/.../...mp4?Expires=...&OSSAccessKeyId=...&Signature=...",
  "thumbnailURL": "https://meetpr-videos-prod.oss-cn-hangzhou.aliyuncs.com/students/.../thumbs/...jpg?Expires=...&OSSAccessKeyId=...&Signature=..."
}
```

##### `POST /upload/abort` — request body

```ts
z.object({
  uploadId: z.string().min(1),
  ossKey: z.string().min(1),
  thumbnailUploadId: z.string().min(1).optional(),
  thumbnailOssKey: z.string().min(1).optional(),
});
```

Implementation: `AbortMultipartUpload(bucket, ossKey, uploadId)` + thumbnail abort if provided. Authorization: `ossKey` student_id matches. Idempotent: re-abort returns 204 (OSS responds 404 on already-aborted → swallow).

#### Read-side endpoints

| Method + Path              | Roles                        | Request                           | Response 200                                                                                    |
| -------------------------- | ---------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /students/:id/videos` | student(self) / coach(owner) | —                                 | `200 { items: VideoAttachmentWithURLs[] }`(每条带短期 1h presigned `videoURL` / `thumbnailURL`) |
| `POST /privacy/consent`    | any auth'd                   | `{ kind: 'video_visibility_v1' }` | `204`(idempotent)                                                                               |

##### `GET /students/:id/videos`

Authorization (same pattern as 003 `/students/:id/sets`):

- If `req.user.id === params.id` (self student) → allow
- Else require coach + owns ≥1 published plan for `params.id`

For coach role: only return videos where `coach_visible_at IS NOT NULL` (consent given). Self student: return all own videos regardless of consent state.

Query:

```sql
SELECT
  va.*
FROM video_attachments va
WHERE va.student_id = $1
  AND ($2 = TRUE OR va.coach_visible_at IS NOT NULL)  -- $2 = isSelf
ORDER BY va.recorded_at DESC;
```

For each row, generate short-lived 1h presigned GET URLs for video + thumbnail (signed locally, no OSS call):

```
videoURL = signUrl('GET', bucket, va.oss_key, expires=3600)
thumbnailURL = signUrl('GET', bucket, va.thumbnail_oss_key, expires=3600)
```

##### `POST /privacy/consent`

```ts
z.object({
  kind: z.enum(['video_visibility_v1']),
});
```

Inserts a `privacy_consents` row `(user_id, consent_kind=$kind, agreed_at=now(), user_agent=req.headers['user-agent'], ip_address=req.ip)`. `ON CONFLICT (user_id, consent_kind) DO NOTHING` for idempotency.

V0.1 only `video_visibility_v1` kind defined; V0.1.x adds `terms_of_service_vN` / `privacy_policy_vN`.

Returns 204.

### Authorization helpers

Reuse `requireAuth` from 001 + `requireRole(...)` from 002. ossKey-prefix authorization is **inline** in each upload handler (parse `ossKey.split('/')[1]` to extract `student_id`, compare with `req.user.id`). Helper extraction premature for V0.1.

### Error code catalogue (additions)

| Code                                 | HTTP | Meaning                                                             |
| ------------------------------------ | ---- | ------------------------------------------------------------------- |
| `UPLOAD_VALIDATION_ERROR`            | 400  | zod validation fails on initiate / sign-parts / complete / abort    |
| `UPLOAD_PLAN_EXERCISE_NOT_PUBLISHED` | 400  | plan_exercise_id does not reach published plan for req.user.id      |
| `UPLOAD_NOT_FOUND`                   | 400  | uploadId not found via OSS ListMultipartUploads                     |
| `UPLOAD_INVALID_PARTS`               | 400  | CompleteMultipartUpload fails (etag mismatch)                       |
| `UPLOAD_OSS_KEY_OWNERSHIP`           | 403  | ossKey student_id prefix doesn't match req.user.id                  |
| `VIDEO_NOT_FOUND`                    | 404  | Reserved for future per-video endpoints (V0.1.x delete / re-upload) |

### File layout

```
src/
├── routes/
│   ├── ... (existing)
│   ├── upload.ts                # NEW (this spec): POST /upload/{initiate,sign-parts,complete,abort}
│   ├── videos.ts                # NEW: GET /students/:id/videos
│   └── privacy.ts               # NEW: POST /privacy/consent
├── handlers/
│   ├── upload-initiate.ts       # NEW
│   ├── upload-sign-parts.ts     # NEW
│   ├── upload-complete.ts       # NEW (most logic; OSS Complete + DB INSERT + presign read URLs)
│   ├── upload-abort.ts          # NEW
│   ├── videos-fetch.ts          # NEW
│   └── privacy-consent.ts       # NEW
├── oss/
│   ├── client.ts                # NEW: aliyun-oss-nodejs wrapper, AccessKey/SecretKey via env
│   └── presign.ts               # NEW: signUrl helper for PUT/GET with TTL
└── db/types.ts                  # extend with VideoAttachmentsTable + PrivacyConsentsTable
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

| File                                                    | Coverage                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/upload-initiate.test.ts` (new)                   | POST happy;authorization (own student_id);403 not student role;400 plan_exercise_id not published;mock OSS InitiateMultipartUpload               |
| `tests/upload-sign-parts.test.ts` (new)                 | POST happy;authorization (ossKey prefix);no OSS call;deterministic re-sign URLs                                                                  |
| `tests/upload-complete.test.ts` (new)                   | POST happy → DB row insert;ON CONFLICT 重录 update;authorization;UPLOAD_NOT_FOUND;UPLOAD_INVALID_PARTS;consent-not-given → coach_visible_at NULL |
| `tests/upload-abort.test.ts` (new)                      | Idempotent;authorization                                                                                                                         |
| `tests/videos-fetch.test.ts` (new)                      | Self student sees all (including coach_visible_at NULL);coach only sees consent-given;403 non-owner coach;ordering                               |
| `tests/privacy-consent.test.ts` (new)                   | POST happy → DB row;idempotent re-POST DO NOTHING;UA + IP captured                                                                               |
| `tests/migrations/0007-video-and-consent.test.ts` (new) | Migration runs;UNIQUE (student_id, plan_exercise_id, set_index);CHECK duration ≤ 121;CHECK file size ≤ 1 GiB;UNIQUE (user_id, consent_kind)      |
| `tests/oss/presign.test.ts` (new)                       | signUrl returns valid presigned URL format;expiry parameter respected;PUT vs GET distinction                                                     |

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
5. AccessKey: create RAM user `meetpr-backend-oss-v01` with policy `AliyunOSSFullAccess` scoped to `meetpr-videos-prod` only (NOT root account AK!)
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

1. **Aliyun OSS SDK choice**: `ali-oss` (official) supports multipart server-side ops + presigned URL signing. Confirm version pin in package.json,Node 22 compatibility verified.
2. **Presigned URL TTL = 1h is invariant**: iOS spec 027 §4.4 says all presigned URLs (initiate / sign-parts / read) **统一 1h 过期**. Don't extend to 24h "for convenience" — long TTLs increase replay attack surface.
3. **ossKey path-component parsing**: `students/<studentId>/sets/<planExerciseId>/<setIndex>/<uuid>.mp4` — implementer parses via regex or split, must reject non-conforming keys (defense vs path traversal `../`). Use `path.normalize` and assert prefix matches.
4. **RAM user scope**: never use root AccessKey for bucket access; create dedicated RAM user limited to `meetpr-videos-prod` only. Future bucket addition: separate RAM users per bucket (defense in depth).
5. **`coach_visible_at` semantics**: iOS spec 027 §3.2 shows consent modal BEFORE first upload. But backend must defend against race: complete handler checks `privacy_consents` row exists for `video_visibility_v1` kind. If consent not yet recorded (e.g. iOS modal didn't fire POST /privacy/consent yet),`coach_visible_at = NULL` and the video is uploaded but hidden from coach until `POST /privacy/consent` fires (no retro update needed unless V0.1.x adds explicit "make existing videos visible" — out of scope).
6. **OSS object lifecycle on overwrite**: `ON CONFLICT (student_id, plan_exercise_id, set_index)` overwrites `oss_key` to the new UUID; **old OSS object becomes orphan** (no DB row points to it). V0.1 accepts orphan storage cost (内测期 < ¥1/month). V0.1.x adds cleanup job that diff'd `video_attachments.oss_key` against bucket ListObjects + deletes orphans nightly.
7. **iOS thumbnail upload via same multipart endpoint**: §`POST /upload/initiate` with `contentType='image/jpeg'` + 1-part. Slightly awkward (intended for video) but avoids adding a second endpoint. V0.1.x可 split if 复杂度 grows.
8. **`POST /upload/sign-parts` does NOT call OSS**: presigned URLs are pure crypto ops with bucket AK/SK. This endpoint is essentially "give me HMAC signatures for these part numbers". Don't accidentally call `ListMultipartUploads` here — wastes API quota and reveals nothing useful.
9. **V0.1 file size cap = 1 GiB**: defensive against ProRes / 4K原片 fallback. Internal 内测 < 1 GiB always; if hit cap iOS spec 027 fallback already gates by file size and warns "蜂窝可能耗大量流量". Backend hard rejects > 1 GiB regardless.

## Codex review focus

- 0007 migration: `UNIQUE (student_id, plan_exercise_id, set_index)` + CHECK constraints valid PG
- `POST /upload/initiate` ossKey path format + part URL generation
- `POST /upload/sign-parts` does NOT call OSS server-side (pure crypto local op)
- `POST /upload/complete` 步骤 5 (consent lookup) + 步骤 6 (ON CONFLICT) 顺序正确;coach_visible_at semantics correct
- `GET /students/:id/videos` 自学员看自己即使无 consent 也可见;教练仅看 consent-given (`coach_visible_at IS NOT NULL`)
- Authorization via `ossKey.startsWith('students/${req.user.id}/')` 是否够强(path traversal `../students/<other>/...` 必须被 zod string 验证或 `path.normalize` 阻止)
- Test coverage above 充足
- RAM user scope:不允许使用 root AccessKey
- iOS spec 027 0.2 amend 的 `POST /upload/sign-parts` re-sign 流程在本 spec endpoint contract 中完整体现
- 1h URL TTL invariant 不被实装期"为方便延长到 24h"破坏

## Per backend Spec workflow

This is the **spec PR** (Step 1). Codex impl PR `feat/004-video-upload` follows after this merges. iOS spec 027 + 029 impl PRs depend on Codex backend 004 impl PR landing on `staging`.

## Cross-PR dependency map

| Upstream PR                                                  | Required state        | Why                                                                                                                                                 |
| ------------------------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| backend PR #6 (`chore/v01-unfreeze`)                         | merged to staging     | CLAUDE.md ❄️ FROZEN callout removed                                                                                                                 |
| backend PR #7 (`chore/spec-003-student-actions`)             | spec merged           | This spec doesn't depend on 003 endpoints,but **003 must impl first** so SAE deploy / DB migrations / Postgres setup is in place when 004 impl runs |
| iOS PR #115 (`chore/spec-027-video-upload`)                  | merged to iOS main ✅ | iOS spec 027 references this backend spec                                                                                                           |
| iOS PR #117 (`chore/spec-029-coach-student-detail-feedback`) | merged to iOS main ✅ | iOS spec 029 consumes `GET /students/:id/videos`                                                                                                    |
