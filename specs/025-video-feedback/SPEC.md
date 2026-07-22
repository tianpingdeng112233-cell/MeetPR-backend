# 025 — 视频级教练反馈（feedback.video_id，additive）

教练在 plan-web 的训练视频弹窗里看完一条动作视频，顺手写一句反馈。现有 `feedback` 表最细只能关联
到「某天 · 某个计划动作」（0006），关联不回**具体哪条视频 / 哪一组**——学员在 App 收件箱看到
「7/17 的反馈」，无从知道教练在说哪条。本 spec 加一列 `video_id`，把这条线接上。

⚖️ 拍板（2026-07-21，David）：入口形态 = 弹窗内嵌输入框；关联粒度 = **精确到视频**（而非复用
现有动作级关联）。学员端 iOS 渲染「查看关联视频」是独立一卡，本 spec 只负责把字段种下去——
在 iOS 那卡落地前，`video_id` 只写不读，学员端表现不变（向后兼容，见 §兼容性）。

## Scope

- 迁移 **0046**：`feedback` 加可选 `video_id`。取号已三源核实（`origin/staging` 头 0044；open PR
  最高 0045 = PR #92 聊天波；staging DB 账本 0044 已应用）→ 0046 为空号。
- `POST /coach/feedback` 接受可选 `video_id`，并做**独立于 plan_exercise 的归属校验**。
- `GET /students/:id/feedback` 返回 `video_id` 与该视频的展示元信息，供学员端一次拿全、不必二次请求。

**不在范围**：学员端 iOS 播放界面（StudentKit 现在零播放能力，另开一卡）；plan-web 弹窗改动（W2）；
反馈的编辑 / 删除；把 `video_id` 回灌进 `analytics_feedback`（无关的另一张表）。

## 迁移 0046

```sql
ALTER TABLE feedback
  ADD COLUMN video_id UUID REFERENCES attachments(id) ON DELETE SET NULL;
```

- **additive-only**，无 NOT NULL、无 default、不动既有列 —— 老镜像读新库不受影响（hard rule 8）。
- `ON DELETE SET NULL` 与同表 `plan_exercise_id` 一致：视频被 lifecycle 清掉时反馈正文留存，只掉链接。
- 索引：不加。查询恒以 `student_id` 起手（已有 `feedback_student_posted_idx`），`video_id` 只做投影。
- 文件首行 `BEGIN;` 后必须有 `SET search_path TO public;`（DMS 控制台坑，见 `db/MIGRATIONS-APPLIED.md`）。
- 同步手改 `src/db/types.ts` 的 `FeedbackTable`（hand-augmented per migration，hard rule 1）。

## 端点契约

### `POST /coach/feedback`（`requireRole('coach')`）

body 增加：`video_id?: uuid | null`（其余字段不变）。

校验顺序（新增段落插在现有 plan_exercise / student 授权之后）：

1. 现有校验原样保留：带 `plan_exercise_id` → `coachOwnsPublishedPlanExercise`，否则
   `coachHasPublishedPlanForStudent`。
2. 若带 `video_id`，**另外**校验该 attachment 满足全部：
   `owner_id = body.student_id`、`kind = 'set_video'`、`status = 'ready'`。
   不满足 → `400 { "error": "FEEDBACK_VIDEO_NOT_OWNED" }`。
   （教练↔学员的关系已由第 1 步把住；这一步只防「把 A 学员的视频挂到 B 学员的反馈上」。）
3. 三个关联字段互相独立：只带 `video_id` 不带 `plan_exercise_id` 合法（自由记录的组，视频没绑计划动作）。

响应 201，形状增加 `video_id`。

### `GET /students/:id/feedback`（本人 or 已绑定教练）

每条 item 增加两个字段：

```jsonc
{
  "video_id": "uuid | null",
  "video": {           // video_id 为 null、或视频已被删 → 整个对象为 null
    "id": "uuid",
    "exercise_name": "低杠位深蹲 | null",
    "set_index": 2,     // null 时前端只显示动作名
    "weight_kg": "125.0 | null",
    "reps": 4,
    "logged_at": "2026-07-17T… | null"
  } | null
}
```

- 元信息来源与 `GET /students/:id/videos` 同一套 join（`attachments → set_logs → exercises`），
  口径必须一致——不要另起一套命名。
- `weight_kg` 维持 DATE/NUMERIC-as-text 纪律（hard rule 3 同源精神），字符串返回。
- 不返回播放 URL：播放一律走 `GET /uploads/:id/url` 逐条短期签发（spec 007 既定纪律，
  一个被截获的响应不该泄漏一墙可播链接）。学员本人签自己的视频已被现有权限放行。

## 兼容性

- 迁移 additive、响应仅新增字段：**已发布的 iOS 1.0(13) 与线上 plan-web 均不受影响**。
  Swift `Codable` 忽略未知 key，`CoachFeedback` 不改也能解码。
- 老客户端发不带 `video_id` 的 POST，行为逐字节不变（新字段 optional，缺省 null）。
- 本 spec 不改任何既有响应字段的名字 / 类型 / 可空性。

## 验收

vitest（`tests/` 现有 feedback 套件同址扩写）：

1. 带合法 `video_id` POST → 201，返回体含 `video_id`，落库正确。
2. `video_id` 指向**另一个学员**的视频 → 400 `FEEDBACK_VIDEO_NOT_OWNED`。
3. `video_id` 指向 `status != 'ready'` 或 `kind != 'set_video'` 的 attachment → 400 同上。
4. 只带 `video_id`、不带 `plan_exercise_id` → 201（自由记录路径）。
5. 不带 `video_id` 的老请求 → 201，响应形状除新增字段外与改动前一致。
6. `GET /students/:id/feedback` → 关联视频的 item 带完整 `video` 对象；无关联的 item `video: null`。
7. 视频被删（attachment 行消失）后再 GET → `video_id: null`、`video: null`，反馈正文仍在。
