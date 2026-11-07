# 060 poster auto-rotate — 2026-11-07

- 根因假设：OSS 截帧缺少 `ar_auto`，未按视频 rotation 信息旋转；[阿里云文档](https://www.alibabacloud.com/help/zh/oss/user-guide/video-snapshots)支持该参数语义。未调用线上 OSS，真实手机首图方向仍待部署后验证；本卡按 David 指定的签名 seam 执行，不扩展多假设诊断。
- 改动：导出 `VIDEO_POSTER_PROCESS = 'video/snapshot,t_1000,f_jpg,w_640,m_fast,ar_auto'`，签名实现、测试与替身共用；OSS 单测保留完整字面断言。不改响应、迁移或其它行为；未 commit、push、部署，未读取或写入真实密钥。
- 红绿：`pnpm exec vitest run tests/unit/oss.test.ts` 先改断言后 1 失败 / 3 通过（实际参数缺少 `ar_auto`），再改实现后 4/4 通过。
- 定向：`pnpm exec vitest run tests/unit/oss.test.ts tests/unit/feedback-serialization.test.ts tests/chat-set-ref.test.ts tests/feedback-fetch.test.ts tests/student-videos.test.ts`，5 文件 39/39 通过；`pnpm exec vitest run tests/unit tests/chat-set-ref.test.ts tests/feedback-fetch.test.ts tests/student-videos.test.ts`，19 文件通过 / 1 失败，181 通过 / 34 失败，失败均来自 `tests/unit/app.test.ts` 的端口监听限制。
- 门禁：`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、`git diff --check` 通过。`pnpm test` 改前/改后均为 141 文件通过 / 41 失败、1460 通过 / 520 失败 / 1 跳过、515 未处理错误；沙箱 `listen EPERM` 及其引起的空地址 `port` 错误阻止全绿，非数据库不可用；失败用例集在归一化随机 UUID 后一致。
- 环境：复用本机缓存后 `pnpm install --offline --frozen-lockfile` 成功，锁文件未变；Husky 写共享 `.git/config` 被拒，现场已有 `.husky/_`，未绕过钩子。临时 `.pnpm-store/` 已移除。
- 审查：`review-loop` 独立只读双轴一轮，Standards 0 项 / Spec 0 项；tracker 配置缺失，未运行 tracker 工作流。tracked diff 仅指定 7 文件，另新增本 JOURNAL。原始日志：`/tmp/poster-rotate-{baseline-*,red,final-*,focused,affected}.log`。
