# 060 — 视频首图与时长下发

- **状态**: Ready（2026-11-06 David「2A」确认）
- **来源**: 学员反馈：聊天里的视频卡全黑。客户端配套为 spec 103（`MeetPR` / `meetpr-rn` 仓 `specs/103-chat-timestamps-video-poster/SPEC.md`）。
- **级别 / 节奏**: T2 / P1。合并与部署等 David「放行」；先部署 staging，客户端卡对 staging 验收。

## 现状（已核实，`origin/staging` b61e520）
- 视频经 `/uploads` 分片直传阿里云 OSS（`src/services/oss.ts`，`signGetUrl` 出签名 GET 链接），库里没有封面与时长字段；镜像无 ffmpeg。
- 客户端拿到的视频对象（反馈 `video`、聊天组分享 `set_ref` 视频、`/students/:id/videos`）只有 id、动作、组号、重量等。

## 变更
1. **首图**：用 OSS 原生视频截帧（`x-oss-process=video/snapshot,t_<ms>,f_jpg,w_<宽>,m_fast`）出封面，**不存新文件、不装 ffmpeg、老视频不用回填**。在上面三类视频对象上新增 `poster_url: string | null`：签名 GET 链接带截帧参数，有效期与现有播放链接一致；截第 1 秒（视频短于 1 秒取第 0 秒），宽 640。
2. **时长**：新增 `duration_seconds: number | null`。来源优先用 OSS 视频信息能力（如 `video/info`）在上传完成时探一次写库；拿不到就 `null`，客户端会隐藏角标。存量视频用一次性脚本按同法回填（只写 null 行、可重跑、先备份）。
3. 字段只增不改，旧客户端忽略新字段不受影响。
4. OSS 未配置（本地 dev）或非 OSS 存储（Global 轨 R2）→ 两个字段都给 `null`，不报错。

## 开工第一步（spike，先于写代码）
在 staging bucket 对一个已有视频手动签一条截帧链接 curl：返回 `image/jpeg` 才继续。若 bucket 不支持（需绑定 IMM 或报 4xx），**停下写进 JOURNAL 回给 Opus**，不要自行改成 ffmpeg 方案。时长能力同样先 curl 验证；不可用则只做首图、`duration_seconds` 恒 null，并在 JOURNAL 写明。

## 验收清单
1. staging 上老视频（含 MonsterXTY 的反馈视频）在反馈接口、聊天分享、学员视频列表三处都带非空 `poster_url`，curl 该链接得到 jpg 且不是纯黑帧。
2. 新上传视频完成后 `duration_seconds` 为整数秒（spike 不通过时为 null 且 JOURNAL 有记录）。
3. 无权限的人拿不到他人视频的 `poster_url`（沿用现有授权，补一条 403 测试）。
4. OSS 未配置时接口照常返回、两字段为 null。
5. 回填脚本：dry-run 输出将改行数；正式跑前有备份表；重跑零变更。

## 测试 seam
- 在现有视频序列化 / `set-video-access` 层的测试里，用假 `OssService` 断言 `poster_url` 带截帧参数、OSS 缺席时为 null；上传 complete 路由测试里断言时长写入（假 OSS 返回时长 / 抛错两例）。

## Out of Scope
- Global 轨（R2）首图。
- 自选封面、多帧预览、动图封面。
- 训练页等非聊天场景的客户端改动（字段可用，客户端本期不接）。
