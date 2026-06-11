# 007 — set_log ↔ 视频附件服务端关联 + 学员视频墙端点

- **状态**: InProgress
- **来源**: iOS spec 027 实装注记（关联仅存学员本地 JSON，教练跨设备不可见）+ iOS spec 029 二遍视频墙前置；backend spec 004 显式把"消费方关联列"留给本 spec
- **批准语境**: V0.1b wave（David 2026-06-11"波2/3/4一口气做完"）

## 范围

1. **migration 0015**: `attachments.set_log_id UUID NULL REFERENCES set_logs(id) ON DELETE SET NULL` + 视频墙部分索引 `(owner_id, created_at DESC) WHERE kind='set_video' AND status='ready'`
2. **`POST /uploads/initiate`** 接受可选 `set_log_id`（仅 kind=set_video，zod superRefine）；**真 gate**：set_log 必须属于上传者本人，否则 404 `SET_LOG_NOT_FOUND`；附件 wire 全面带 `set_log_id`
3. **`GET /students/:id/videos`**（新）：ready 状态 set_video 列表（倒序、cap 100），每项含 `set_log_id` / `plan_exercise_id` / `logged_at`（join set_logs）+ 15min presigned 播放 URL；授权矩阵照抄 `GET /students/:id/sets`（self / accepted-bind coach）；OSS 未配置 503

## 不做

缩略图（无对应 kind）、分页（>100 是 post-V0.1 信号）、删除端点、onboarding 上传的等价列表（spec 032 的"我的资料"用 onboarding_uploads 表既有路径）。

## 下游

- iOS 027 follow-up：initiate 带 set_log_id（替代 filename 反查 hint）
- iOS 029 二遍：教练视频墙消费本端点

## 修订记录

| 日期       | 版本 | 变更             | 作者   |
| ---------- | ---- | ---------------- | ------ |
| 2026-06-11 | 0.1  | 起草 + 实装同 PR | Claude |
