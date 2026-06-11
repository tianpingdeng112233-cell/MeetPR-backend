# 004-attachment-upload

**Status:** InProgress
**Date:** 2026-05-15

## 修订记录

| 日期       | 变更                                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-05-15 | 初稿 `004-video-upload`(学员记组视频专用管线,PR #8 五轮 review 决议 D1=c / D2=c / D3=a 已吸收)                                                                                                                     |
| 2026-06-11 | **扩展为通用附件管线 per V0.1b wave**(David 批准)。目录改名 `004-attachment-upload`;表 `video_attachments` → 通用 `attachments`;endpoint 改 `/uploads/*`;新增 onboarding 文档/视频消费方(iOS spec 032)。详见下文。 |

## Goal

落地**通用附件上传管线**:backend 用 OSS AK/SK 给 multipart 各 part 签 presigned PUT URL(app 不持任何密钥),附件元数据进 `attachments` 表,读取走短期 presigned GET URL。服务两个消费方:

1. **学员记组视频**(iOS spec 027):≤120s H.264 视频,iOS 端转码 + 分片
2. **学员 onboarding 上传**(iOS spec 032):过往训练计划 PNG/JPG/PDF + 三大项视频各 ≤3 个

本 spec 只管"上传 + 元数据 + 取回"。**附件与业务实体的关联**(set_logs / onboarding 各自加 `attachment_id` 列)留给消费方 spec,本 spec 不动那些表。

Refs:

- iOS [spec 027 video upload](../../../MeetPR/specs/027-video-upload/SPEC.md) — 记组视频消费方
- iOS spec 032 onboarding upload — onboarding 文档/视频消费方
- [ADR 004 §1 / §4](~/Brain/wiki/projects/MeetPR/decisions/004-backend-selection.md) — Aliyun OSS bucket
- 原 `004-video-upload` draft(本文件 git 历史)— PR #8 review 五 blocker 决议沿用之处已标注

Upstream backend: [001-auth](../001-auth/SPEC.md)(JWT requireAuth 复用)+ [003-student-actions](../003-student-actions/SPEC.md)(`bind_requests` 授权 join 复用)。

## 技术决策(V0.1b wave 已拍板)

- **Presigned multipart 直传 OSS**:backend 持 OSS AK/SK(env),给每个 part 签 presigned PUT URL(1h 有效),app 直传 OSS。**不用 STS**(不引 RAM AssumeRole 依赖)。
- **OSS SDK**:`ali-oss` npm 官方包。OSS 交互封装在 `src/services/oss.ts` 的 `OssService` 接口,注入 app deps(`createApp({ ...oss })`),测试 mock 该服务边界(repo 规范:mock only at network/DB boundaries)。
- **OSS 配置可选**:本地 dev 无凭证时 config 不报错;`/uploads/*` 路由在未配置时统一返回 `503 { error: 'UPLOADS_NOT_CONFIGURED' }`。
- **kind 驱动的限制**(initiate 时校验):

  | kind               | content_type 白名单                        | size 上限 |
  | ------------------ | ------------------------------------------ | --------- |
  | `set_video`        | `video/mp4` `video/quicktime`              | 200 MB    |
  | `onboarding_video` | `video/mp4` `video/quicktime`              | 200 MB    |
  | `onboarding_doc`   | `image/png` `image/jpeg` `application/pdf` | 20 MB     |

- **状态机**:`uploading → ready`(complete)/ `uploading → aborted`(abort)。终态不可再转移(409)。
- **size_bytes 为 client 申报值**:initiate 收 client 报的 size 做上限 gate。V0.1 不在 complete 时 HeadObject 验真 size(原 video spec D2=c 的 HeadObject authoritative-size 检查推迟到消费方 spec 关联时按需加;见 Out of scope)。bucket 私有、presigned PUT 1h 过期,滥用面有限。

## Scope

### Migration `0007-init-attachments.sql`

```sql
CREATE TABLE attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('set_video', 'onboarding_video', 'onboarding_doc')),
  oss_key       TEXT NOT NULL UNIQUE,
  oss_upload_id TEXT,
  content_type  TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL CHECK (size_bytes > 0),
  filename      TEXT CHECK (filename IS NULL OR length(filename) BETWEEN 1 AND 255),
  status        TEXT NOT NULL DEFAULT 'uploading'
                CHECK (status IN ('uploading', 'ready', 'aborted')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX attachments_owner_created_idx ON attachments (owner_id, created_at DESC);
```

- `oss_key` 格式:`attachments/<owner_id>/<uuid>.<ext>`,ext 由 content_type 推导(`.mp4` / `.mov` / `.png` / `.jpg` / `.pdf`)。UUID 由 backend 生成,**client 无法指定 key,也不再回传 key**(原 video spec blocker 4 的 anchored-regex 解析问题在新设计下不存在 — 一切 OSS 坐标都从 DB 行读)。
- `oss_upload_id`:multipart upload ID,initiate 时写入,**complete/abort 后保留**(audit 用,沿用原 spec PR #8 non-blocking #3 决议)。
- `filename`:client 原始文件名(可选),onboarding 文档列表 UI 展示用。不参与 oss_key,不做路径语义解析。
- `size_bytes`:client 申报值(见上文技术决策)。

### Endpoints

全部挂在 `/uploads`,全部 `requireAuth`(任何登录角色都可上传/管理**自己**的附件)。错误信封 `{ error: '<CODE>', ... }`。HTTP wire 全 snake_case(zod `.strict()` 拒 camelCase → 400 VALIDATION_ERROR)。OSS 未配置时全部 503 `UPLOADS_NOT_CONFIGURED`。

| Method + Path                          | 授权                          | Request                                                     | Response                                            |
| -------------------------------------- | ----------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| `POST /uploads/initiate`               | 任何登录用户                  | `{ kind, content_type, size_bytes, part_count, filename? }` | `201 { attachment_id, upload_id, part_urls }`       |
| `POST /uploads/:attachmentId/complete` | owner                         | `{ parts: [{ part_number, etag }] }`                        | `200 Attachment`(元数据)                            |
| `POST /uploads/:attachmentId/abort`    | owner                         | `{}`(空 body)                                               | `204`(幂等)                                         |
| `GET /uploads/:attachmentId/url`       | owner 或其 accepted-bind 教练 | —                                                           | `200 { url, expires_in }`(presigned GET,15min 有效) |

#### `POST /uploads/initiate`

```ts
z.object({
  kind: z.enum(['set_video', 'onboarding_video', 'onboarding_doc']),
  content_type: z.string().min(1),
  size_bytes: z.number().int().positive(),
  part_count: z.number().int().min(1).max(10_000), // OSS multipart 上限
  filename: z.string().min(1).max(255).optional(),
}).strict();
```

流程:

1. 校验 `content_type` 在 kind 白名单内,否则 `400 UPLOAD_CONTENT_TYPE_MISMATCH`
2. 校验 `size_bytes` ≤ kind 上限,否则 `400 UPLOAD_TOO_LARGE`
3. 生成 `oss_key = attachments/<req.user.id>/<uuid>.<ext>`
4. OSS `InitiateMultipartUpload(key, content_type)` → `upload_id`
5. INSERT `attachments` 行(status='uploading',oss_upload_id=upload_id)
6. 给 part 1..part_count 各签 presigned PUT URL(`expires=3600`,带 partNumber + uploadId subresource)
7. 返回 `201`:

```json
{
  "attachment_id": "uuid",
  "upload_id": "...",
  "part_urls": [
    {
      "part_number": 1,
      "url": "https://<bucket>.<endpoint>/attachments/...?partNumber=1&uploadId=...&Expires=..."
    }
  ]
}
```

> presigned URL TTL = 1h 是 invariant(沿用原 spec 决议:别"为方便"延长到 24h — 长 TTL 扩大 replay 面)。URL 过期重传场景 V0.1 由 client 重新 initiate(产生新附件行,旧 uploading 行成 stale,见 Out of scope 清理 job)。

#### `POST /uploads/:attachmentId/complete`

```ts
z.object({
  parts: z
    .array(
      z
        .object({ part_number: z.number().int().min(1).max(10_000), etag: z.string().min(1) })
        .strict(),
    )
    .min(1)
    .max(10_000),
}).strict();
```

流程:

1. 按 `id + owner_id = req.user.id` 查 `attachments` 行;无 → `404 ATTACHMENT_NOT_FOUND`(对非 owner 同样 404,不泄露存在性)
2. `status !== 'uploading'` → `409 UPLOAD_INVALID_STATE`
3. OSS `CompleteMultipartUpload(oss_key, oss_upload_id, parts)`;OSS 报错(etag mismatch 等)→ `400 UPLOAD_INVALID_PARTS`(状态保持 uploading,client 可重试)
4. 条件 UPDATE `status='ready', updated_at=now()` WHERE `status='uploading'`(原子 claim,并发 double-complete 输家拿 409)
5. 返回 `200` 附件元数据(snake_case):

```json
{
  "id": "uuid",
  "owner_id": "uuid",
  "kind": "set_video",
  "oss_key": "attachments/<owner_id>/<uuid>.mp4",
  "content_type": "video/mp4",
  "size_bytes": 12345678,
  "filename": "squat-day1.mp4",
  "status": "ready",
  "created_at": "2026-06-11T10:00:00.000Z",
  "updated_at": "2026-06-11T10:02:30.000Z"
}
```

#### `POST /uploads/:attachmentId/abort`

1. owner 查行,无 → `404 ATTACHMENT_NOT_FOUND`
2. `status === 'aborted'` → `204`(幂等 re-abort)
3. `status === 'ready'` → `409 UPLOAD_INVALID_STATE`(已完成的附件不能 abort;删除是未来 DELETE endpoint 的事)
4. OSS `AbortMultipartUpload(oss_key, oss_upload_id)`;OSS 返 NoSuchUpload(已过期/已被清)→ swallow(service 层处理),其他错误 → 500
5. UPDATE `status='aborted'` → `204`

#### `GET /uploads/:attachmentId/url`

授权(**唯一允许非 owner 读取的入口**):

- `req.user.id === owner_id` → 允许
- 否则查 `bind_requests` 存在 `(student_id = owner_id, coach_id = req.user.id, status = 'accepted')` → 允许
- 否则 → `404 ATTACHMENT_NOT_FOUND`(陌生教练/其他学员一律 404,不泄露存在性;pending/rejected bind 同样 404)

流程:

1. 授权检查(如上)
2. `status !== 'ready'` → `409 ATTACHMENT_NOT_READY`(uploading/aborted 附件无可读对象)
3. 本地签 presigned GET URL(`expires=900`,纯 HMAC 计算,不调 OSS server-side)
4. 返回 `200 { "url": "https://...", "expires_in": 900 }`

### Error code catalogue (additions)

| Code                           | HTTP | Meaning                                                         |
| ------------------------------ | ---- | --------------------------------------------------------------- |
| `UPLOADS_NOT_CONFIGURED`       | 503  | OSS env 未配置(本地 dev / misconfig),所有 `/uploads/*` 路由     |
| `VALIDATION_ERROR`             | 400  | zod 校验失败(含 camelCase 字段被 `.strict()` 拒)                |
| `UPLOAD_CONTENT_TYPE_MISMATCH` | 400  | content_type 不在该 kind 白名单                                 |
| `UPLOAD_TOO_LARGE`             | 400  | size_bytes 超该 kind 上限                                       |
| `UPLOAD_INVALID_PARTS`         | 400  | OSS CompleteMultipartUpload 失败(etag mismatch / upload 不存在) |
| `ATTACHMENT_NOT_FOUND`         | 404  | 附件不存在,或请求者无权知道它存在                               |
| `UPLOAD_INVALID_STATE`         | 409  | complete/abort 作用在非法状态(终态不可再转移)                   |
| `ATTACHMENT_NOT_READY`         | 409  | GET url 作用在非 ready 附件                                     |

### File layout

```
src/
├── routes/
│   ├── uploads/
│   │   ├── index.ts      # NEW: uploadsRouter — 4 endpoints + 503 gate
│   │   └── schemas.ts    # NEW: zod schemas + kind 限制表
│   └── index.ts          # mount: app.use('/uploads', requireAuth, uploadsRouter(...))
├── handlers/
│   └── attachments.ts    # NEW: DB helpers(insert / find / 条件状态转移 / bind 授权查询)+ wire serialization
├── services/
│   └── oss.ts            # NEW: OssService 接口 + ali-oss 实装 + maybeCreateOssService(config)
└── db/types.ts           # extend: AttachmentsTable + ATTACHMENT_KINDS/STATUSES
```

`createApp({ config, logger, db, oss? })` — `oss` 可选注入;`server.ts` 用 `maybeCreateOssService(config)` 装配。

### Environment / secrets

| Env var                 | Source                           | V0.1                    |
| ----------------------- | -------------------------------- | ----------------------- |
| `OSS_ACCESS_KEY_ID`     | Bitwarden `MeetPR OSS AK`        | prod 必填;本地 dev 可缺 |
| `OSS_ACCESS_KEY_SECRET` | Bitwarden `MeetPR OSS AK`        | prod 必填;本地 dev 可缺 |
| `OSS_BUCKET`            | SAE env                          | prod 必填               |
| `OSS_REGION`            | SAE env(如 `oss-cn-hangzhou`)    | prod 必填               |
| `OSS_ENDPOINT`          | SAE env(可选;缺省由 region 推导) | 可选                    |

四项必填任一缺失 → `maybeCreateOssService` 返回 undefined → 路由 503。config zod 全部 optional,不影响现有 dev/test 启动。

### Tests

全部用 pg-mem + FakeOssService(注入 `OssService` 边界,无网络)。

| File                                        | Coverage                                                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/uploads-initiate.test.ts`            | 各 kind happy path;content_type × kind 错配 → 400;size 边界(=上限 ok,+1 → 400);part_count 边界;camelCase 拒收;DB 行 status='uploading' + oss_key 格式;part_urls 数量 |
| `tests/uploads-complete.test.ts`            | happy → ready + 元数据;非 owner 404;重复 complete 409;aborted 后 complete 409;OSS 失败 → 400 UPLOAD_INVALID_PARTS 且状态保持 uploading                               |
| `tests/uploads-abort.test.ts`               | happy → 204 + aborted;幂等 re-abort 204;ready 后 abort 409;非 owner 404                                                                                              |
| `tests/uploads-url.test.ts`                 | owner ok;accepted-bind 教练 ok;陌生教练 404;其他学员 404;pending bind 404;非 ready 409;15min expiry 传给 service                                                     |
| `tests/uploads-not-configured.test.ts`      | oss 未注入时 4 endpoint 全 503 UPLOADS_NOT_CONFIGURED                                                                                                                |
| `tests/migrations/0007-attachments.test.ts` | 迁移可跑;kind/status/size CHECK 生效;index 存在                                                                                                                      |
| `tests/unit/oss-config.test.ts`             | maybeCreateOssService:env 齐 → service;任一缺 → undefined                                                                                                            |

### 隐私 / 合规(保留自原 004-video-upload spec)

以下原则继续成立,实施位置随 scope 调整:

- **Bucket 读写权限 = 私有**,只有 presigned URL 能读写。Referer 防盗链对原生 app 是纸面 gate,不依赖。
- **Presigned GET 短 TTL(15min)**:读 URL 即取即用,client 不缓存 URL(缓存附件内容本身可以)。PUT URL 1h(上传耗时需要)。
- **RAM 最小权限**:backend AK 用 dedicated RAM user + 自定义 least-privilege policy(只授该 bucket 的 object 级读写 + multipart 操作),**绝不**用 root AK / `AliyunOSSFullAccess`(沿用原 spec PR #8 non-blocking #2 决议;RAM user 已于 2026-05-15 创建,见 secrets-pointer §4)。
- **教练可见性以 accepted bind 为授权边界**:`GET /uploads/:id/url` 是唯一非 owner 读取入口,以 `bind_requests.status='accepted'` join 判定。解绑(bind 不再 accepted)即时切断教练读取。
- **隐私同意 ledger(`privacy_consents` 表 + `POST /privacy/consent`)移交消费方 spec**:原 D3=a strict consent ordering 针对"视频对教练可见"这一业务语义,属于 set_video 消费方(iOS spec 027 关联 spec)的关注点,不属于通用上传管线。通用管线只保证授权边界(owner + accepted bind),业务级同意由消费方 spec 在关联时 enforce。原 spec 的 consent 设计(UNIQUE(user_id, consent_kind) 幂等 ledger + UA/IP audit 字段)在消费方 spec 直接复用。
- **生命周期/归档**:90 天低频 / 180 天归档规则 V0.1 不启用(Stage 4)。

### Out of scope

- **附件与业务实体关联**(set_logs / onboarding 表加 `attachment_id` 列)— 消费方 spec
- **隐私同意 ledger**(`privacy_consents` + `POST /privacy/consent`)— set_video 消费方 spec(见上节)
- **缩略图管线** — 消费方 spec 按需(可直接复用本管线,thumbnail 即一个 `kind`)
- **part URL 过期后 re-sign endpoint** — V0.1 client 重新 initiate;量大再加 `POST /uploads/:id/sign-parts`
- **DELETE endpoint / 孤儿对象清理 job** — V0.1.x(stale uploading 行 + abort 后 OSS 残留 + 重传孤儿)
- **HeadObject 验真 size** — 消费方 spec 关联时按需(V0.1 信 client 申报 + kind 上限 gate)
- **MPS 转码 / CDN / KMS 加密 / 多地域** — Stage 4+(沿用原 spec)

### Deploy / OSS bucket prep (one-time)

沿用原 spec 清单(bucket 私有 + CORS PUT/GET/HEAD + RAM least-privilege AK + Bitwarden 记录 + SAE env 注入)。bucket 沿用现有 bucket 即可(key prefix `attachments/` 自隔离)。

## Codex review focus

- 0007 migration:kind/status CHECK + size_bytes > 0 + (owner_id, created_at DESC) index
- initiate 的 kind × content_type × size 三重 gate 在 zod 之后、OSS 调用之前
- complete 的原子状态转移(条件 UPDATE,不是 read-then-write)
- abort 幂等(re-abort 204;service 层 swallow NoSuchUpload)
- GET url 授权:非 owner 一律走 accepted-bind join;查无 → 404 而非 403(不泄露存在性)
- OSS 交互全部走 `OssService` 接口;route/handler 不 import `ali-oss`
- 未配置 OSS → 503 gate 在 zod 之前,4 endpoint 全覆盖
- wire 全 snake_case;zod `.strict()`

## Per backend Spec workflow

本 spec 与 impl 同 PR(V0.1b wave 决议直接驱动 scope,Claude 实装)。分支 `feat/004-attachment-upload`。
