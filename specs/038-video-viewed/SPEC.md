# 038 — 视频「已审」真观看语义（coach_viewed_at，additive）

- **Status: InProgress**（2026-08-11 David 拍板「点进看完视频的 1/2 就当已审核」并批准部署，同日开工）
- **级别**: T2（跨 backend/plan-web 两仓 + 一列 additive 迁移带回填）

plan-web 视频页的「待审 / 已反馈」徽章读的是 `video.viewed_at`（[VideosPage.tsx:41]），但这个字段
**后端从未实装**：`GET /students/:id/videos` 不返回、无列、无写入端点，前端也没有本地打标——
结果是所有视频永远「待审」，教练看完也不消（2026-08-11 教练实测反馈）。

⚖️ 拍板（2026-08-11，David）：**教练点进视频、播放过半（≥ 时长 1/2）即算已审**。
不挂反馈/打点——看完就清，发没发反馈是另一回事。

## Scope

- 迁移 **0062**：`attachments` 加可选 `coach_viewed_at`，并按「已发过视频级反馈或打过点 = 显然审过」
  回填存量（交付红线：换口径必须交代存量照护）。取号已三源核实（2026-08-11 fetch 后：staging 已应用
  head = **0061**（账本 2026-08-10 行）；open PR 占号最高 0050 = PR #110；0053 为账本明示空号但排序
  在已应用段之前，不复用）→ **0062** 为空号。
- 新端点 `POST /videos/:videoId/viewed`（coach-only，幂等）。
- `GET /students/:id/videos` 每条 item 增加 `viewed_at`。
- **plan-web 配套**（同波另卡，meetpr-plan-web 仓）：播放进度首次达到 `duration / 2` 时调一次
  新端点，成功后本地把该视频 `viewed_at` 置为返回值（或 `refreshVideos()`）。API 类型
  `StudentVideo.viewed_at` 已存在（optional），徽章/筛选/计数逻辑零改动。

**不在范围**：学员端 iOS（不读此字段）；「已看」与「已反馈」拆成两档徽章（今日拍板 = 单档，
看过即清）；累计观看时长统计；按教练维度的多教练已读表（见 §已知取舍）。

## 迁移 0062

```sql
BEGIN;
SET search_path TO public;

ALTER TABLE attachments
  ADD COLUMN coach_viewed_at TIMESTAMPTZ;

-- 存量照护:教练已发过视频级反馈(0046)或打过点(0054)的视频,显然已经审看过,
-- 回填为其最早的处理时间,避免升级后第一屏满墙假「待审」。
UPDATE attachments a
SET coach_viewed_at = sub.first_reviewed
FROM (
  SELECT video_id, MIN(created) AS first_reviewed
  FROM (
    SELECT video_id, posted_at AS created FROM feedback WHERE video_id IS NOT NULL
    UNION ALL
    SELECT video_id, created_at AS created FROM video_markers
  ) events
  GROUP BY video_id
) sub
WHERE a.id = sub.video_id
  AND a.coach_viewed_at IS NULL;

COMMIT;
```

- **additive-only**：无 NOT NULL、无 default、不动既有列（hard rule 8）。
- 回填只认「有物理凭证」的审看（feedback.video_id / video_markers），不做任何猜测性置位。
- 列名已对照 `src/db/types.ts` 现场核实：`feedback.posted_at`（[types.ts:541]）、
  `video_markers.created_at`（[types.ts:581]）。
- 同步手改 `src/db/types.ts` 的 `AttachmentsTable`（hand-augmented per migration，hard rule 1）。

## 端点契约

### `POST /videos/:videoId/viewed`（`requireRole('coach')`）

挂载在 markers 同一路由前缀下，授权完全复用 `resolveSetVideoAccess`（与
`POST /videos/:videoId/markers` 逐段一致）：

1. `not_found` → 404 `ATTACHMENT_NOT_FOUND`；`forbidden` 或 `relation !== 'bonded_coach'`
   → 403 `AUTHORIZATION_FORBIDDEN`（学员本人看自己的视频**不**触发已审——这是教练审看语义）。
2. `status !== 'ready'` → 409 `ATTACHMENT_NOT_READY`。
3. 通过 → `UPDATE attachments SET coach_viewed_at = now() WHERE id = $1 AND coach_viewed_at IS NULL`
   （**首次写入，后不覆盖**——已审时间是「第一次看完」，重复调用幂等）。
4. 响应 200：`{ "viewed_at": "<ISO 时间戳>" }`（无论本次写入还是既已存在，都回读当前值）。

无 body；不需要 zod body schema。

### `GET /students/:id/videos`

select 增加 `'a.coach_viewed_at as viewed_at'`，序列化：

```jsonc
{ "viewed_at": "2026-08-11T… | null" } // timestamp() 同现有 created_at 口径
```

学员 self 视角同样返回（additive，iOS `Codable` 忽略未知 key，不受影响）。

## 已知取舍

- `coach_viewed_at` 是**单列全局态**，不按教练分维。spec 007 的 provenance 谓词已保证
  set-linked 视频只对单一教练可见；仅「无 set_log 链接的共享视频」在双教练场景下会
  一人看完、两人消审。V0.1 双教练共享视频近乎不存在，接受；若未来要分维，再起
  `video_views(video_id, coach_id)` 表，本列可平滑弃用（读端换 join，additive）。
- 进度判定在前端（`currentTime >= duration / 2` 首次达标），后端不校验「真的看了一半」——
  教练伪造对自己无利益，不设防。

## 兼容性

- 迁移 additive、响应仅新增字段：已发布 iOS 与线上 plan-web bundle 均不受影响。
- 现部署的 plan-web bundle（index-BWIPt9_J.js）**已在读 `viewed_at`**：backend 先行部署 +
  跑 0062 后，回填命中的历史视频立即翻「已反馈」；新看的视频要等 plan-web 配套卡
  上线（新 bundle 换装 `web/`）才会实时清。两步各自独立可部署，顺序：先 backend。
- 老 plan-web 请求路径零变化；新端点对旧 bundle 是 dead code。

## 验收

vitest（`tests/` 视频套件同址扩写）：

1. bonded coach 对 provenance 内 ready 视频 POST viewed → 200 带 `viewed_at`，落库正确。
2. 重复 POST → 200，`viewed_at` 不变（首写不覆盖）。
3. 学员本人 POST → 403（requireRole('coach') 拦截）；未绑定教练 → 403；不存在 → 404；
   `status != 'ready'` → 409。
4. `GET /students/:id/videos` → 已审视频带 `viewed_at`，未审为 `null`；其余字段与改动前逐字节一致。
5. 回填语义（handler 层等价测试）：有 video_id 反馈或 marker 的视频，迁移后 `coach_viewed_at`
   = 最早事件时间。

plan-web 卡验收（另卡）：播放过半徽章当场翻绿；刷新后仍为「已反馈」；同一视频二刷不重复请求。
