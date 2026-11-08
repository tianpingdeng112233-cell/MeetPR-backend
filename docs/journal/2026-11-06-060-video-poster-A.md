# 060 video poster — A

日期：2026-11-06。状态：按时长恒 null 分支实装已落地；本地完整门禁受环境阻塞，短片截帧规则待确认，未宣布验收通过。

## 范围与现场

- 唯一需求与验收来源：`specs/060-video-poster/SPEC.md`。已先读根目录 `CONTEXT.md`、`CLAUDE.md`，随后读 spec、`AGENTS.md`、`FOLLOWUPS.md` 及工程规约。
- 分支：`feat/060-video-poster`；HEAD：`b992e143671d299f7754cd939702a2326356dd0a`，开工时工作树干净。沿用已准备好的 feature worktree。
- spec 当前状态为 Ready；本次直接执行授权来自 David 的任务指令，未修改 spec 状态或验收范围。
- 当前工作树及本地 `origin/staging`（`b992e14`）未见 `0084-*`。未联网核实远端最新树、open PR 或环境数据库占号；这不构成正式取号。未创建迁移。

## Spike 结果

**初次尝试因本地 env 缺配置而阻塞。随后 David 在本机运行 `scratch/spike-060.cjs` 完成 spike，并在本会话提供下表结果；Codex 未独立重跑，未读取该脚本或获取其进程凭证。**

- 当前 worktree 只有 `.env.example`，无实际 `.env`。
- 已在内存中检查 `/Users/david/Projects/apps/MeetPR-backend/.env` 和 `/Users/david/Projects/apps/MeetPR-backend-wt-e2e-022/.env`；两者均没有 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_BUCKET`、`OSS_REGION`、`OSS_ENDPOINT`，也未发现可供映射的 Aliyun/OSS 配置键。
- 当前进程没有上述 OSS 配置。对项目目录及常用本地配置目录的 env 文件名定位未找到其它 staging OSS env；未输出 env 内容或凭证值。
- 尚未读取 staging 视频对象、生成签名链接或调用 curl；没有签名链接、密钥或访问凭证落盘。

| 能力                                       | 证据来源                                            | HTTP 状态码        | Content-Type | 结论                                       |
| ------------------------------------------ | --------------------------------------------------- | ------------------ | ------------ | ------------------------------------------ |
| `video/snapshot,t_1000,f_jpg,w_640,m_fast` | David 本机 spike；对象尾缀 `…c27e2324.mp4`，14.9 MB | 200                | `image/jpeg` | 首图方案成立                               |
| `video/info`                               | David 本机 spike                                    | 403 `AccessDenied` | David 未提供 | 时长能力不可用；`duration_seconds` 恒 null |

## 首次阻塞时的改动与测试

- 仅新增本 JOURNAL；业务代码、测试、数据库类型、迁移、回填脚本均未修改。
- 按“spike 不通过就停”的任务指令，未进入实装或先红后绿测试阶段，未引入 ffmpeg 或其它替代方案。
- 测试数字：本轮执行 0 个测试；通过/失败数量无运行结果，不能称为全绿。`pnpm install`、`pnpm lint`、`pnpm typecheck`、`pnpm test` 均未执行。当前 worktree 尚无 `node_modules`。
- 未部署，未执行 prod/staging 迁移或任何数据写入，未 commit/push。

## 首次阻塞时的接续条件（已由 David spike 结果解除）

- 需要 David 或 Opus 指明包含 staging OSS 配置的现有本地 env 路径，或通过现有获准凭证通道补齐本地配置；不在对话或 JOURNAL 提供密钥。
- 配置可用后，从真实 staging 已有视频开始执行截图与时长 curl spike，记录 HTTP 状态码及 Content-Type，再依据本卡授权和 spec 继续；当前不能判断时长是否可用，也不能据此选择恒 null 分支。
- 所有功能实现及 spec 验收项仍待执行；涉及 staging 部署与迁移的验收仍受本次“不部署、不跑环境迁移”的边界约束。

## 接续实现（2026-11-06）

- David 明确授权按 spec 时长不可用分支继续：三类视频对象新增 `poster_url` 与恒 null 的 `duration_seconds`；不做迁移、不做回填脚本。
- 测试 seam 沿用视频序列化 / set-video-access 及相关路由，注入假 OssService；时长探测与写库的两例不适用于已批准的恒 null 分支，改核对响应恒 null。
- 不读取凭证，不动 `scratch/`；不部署、不 commit/push。实现与测试结果见下文。

## 实装结果

- `src/services/oss.ts`：新增可选 `signVideoPosterUrl` 能力，使用 ali-oss 原生签名的 `process` 参数，截帧参数为 `video/snapshot,t_1000,f_jpg,w_640,m_fast`；保持原播放签名行为。
- `src/handlers/set-video-access.ts`：共用预览字段生成器；调用方通过已有授权后才签名，有效期 900 秒；OSS 缺席或适配器没有截图能力（S3/R2）时首图为 null。
- 反馈 `video.poster_url`、聊天消息 `poster_url`（与既有 `video_url` 同层，未改 `set_ref` 的冻结快照形状）、`/students/:id/videos` 每项 `poster_url` 已接入；三处 `duration_seconds` 恒 null。
- 上传 complete/reconcile 的 set_video 响应同样增加 `duration_seconds: null`；其它附件旧形状保留。不调用 `video/info`，不加数据库列、不做迁移与回填。
- `src/routes/index.ts` 仅补 OSS 依赖传递，不加入业务规则。
- 本卡三份路由测试及共享上传测试 helper 使用仓内已有 `inMemoryRequest` 执行同一个 Express app，避免监听端口；未改其请求/授权/存储实现。
- 未读取/修改 `scratch/` 脚本，未获取 David 进程中的凭证；scratch 保持用户原有未跟踪内容，不属于本卡交付。

## 先红后绿证据

按行为逐项推进，而非先写完整实现后补测试：

| 行为 / seam                     | 红阶段                                                  | 绿阶段                                                      |
| ------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| 反馈视频序列化（假 OssService） | 缺少 `poster_url` / `duration_seconds`，1 失败          | 新字段、截帧参数和 900 秒 TTL 通过                          |
| 真实 OSS adapter 本地签名       | 未提供截图能力，`x-oss-process` 为 null；1 失败、3 通过 | process 参与签名且播放签名不变，4 通过                      |
| 反馈 GET 路由                   | OSS 未接线，poster 为 null；1 失败、6 通过              | student / author 非空、他人 403、签名前拒绝；7 通过         |
| 学员视频列表                    | 缺少两字段；1 失败、8 通过                              | 字段、授权、缺席/非 OSS 降级；最终 12 通过                  |
| 聊天组视频分享                  | 消息缺少两字段；1 失败、10 通过                         | 发送与列表、删除后 null、无 OSS / 非 OSS 降级；最终 12 通过 |
| uploads complete                | 响应缺少 duration；1 失败、10 通过                      | complete/reconcile 恒 null；最终 11 通过                    |

补充：新测试最初误把重复 complete 当作幂等 200；仓内契约实际为 409，故改测既有 reconcile 路径，不改变重试业务行为。既有 complete 精确响应断言只增 duration 字段。时长返回值/探测抛错测试不再适用于 David 批准的“不探测、不写库、恒 null”分支。

## 最终本地检查

| 检查                                       | 结果                                                                                                                                                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                             | 首跑下载被沙箱 EPERM 阻止；复制已有本机 pnpm 缓存后 `pnpm install --offline --frozen-lockfile` 成功，478 包、锁文件未变。临时缓存已清理。prepare 调用 Husky 时无法写共享 `.git/config`；现场 `core.hooksPath` 已为 `.husky/_`，未绕过钩子 |
| `pnpm typecheck`                           | 通过，exit 0                                                                                                                                                                                                                              |
| `pnpm lint`                                | 未通过，仅 `scratch/spike-060.cjs` 不在 TS project service 范围（用户文件，未改动）                                                                                                                                                       |
| `pnpm lint --ignore-pattern 'scratch/**'`  | 通过，exit 0；没有修改仓内 lint 配置                                                                                                                                                                                                      |
| 本卡 6 文件定向测试                        | **50 / 50 通过**                                                                                                                                                                                                                          |
| `pnpm test` 全量                           | **141 文件通过、41 文件失败；1448 通过、520 失败、1 跳过，共 1969 测试**；另报 515 个未处理监听错误。515 失败为 supertest 监听失败后的 `reading 'port'`，5 失败为直接 `listen EPERM 127.0.0.1`                                            |
| 开工基线全量                               | 137 文件通过、44 文件失败；1401 通过、556 失败、1 跳过，共 1958 测试；551 个 port 失败 + 5 个直接 listen EPERM。同类环境限制在改动前已存在                                                                                                |
| `pnpm build`                               | 通过，exit 0                                                                                                                                                                                                                              |
| 本卡改动文件 Prettier / `git diff --check` | 通过                                                                                                                                                                                                                                      |

定向命令：

```sh
pnpm exec vitest run tests/unit/oss.test.ts tests/unit/feedback-serialization.test.ts tests/feedback-fetch.test.ts tests/student-videos.test.ts tests/chat-set-ref.test.ts tests/uploads-complete.test.ts
```

原始本机证据：`/tmp/060-red-*.log`、`/tmp/060-green-*.log`、`/tmp/060-focused.log`、`/tmp/060-baseline-test.log`、`/tmp/060-final-{typecheck,lint,source-lint,test,build,format}.log`。绿阶段最终结论以 focused/final 日志为准；中途 green 命名日志可能包含迭代期间暴露的旧精确断言与重试假设失败。

## 独立代码审查

- Standards：只读子代理审查未提交 diff 与新增测试，0 项发现。
- Spec：1 项未满足——`signVideoPosterUrl` 当前固定 `t_1000`，无法在时长不可用时识别不足 1 秒的视频以切换 `t_0`。主代理已向 David 提出选项，尚未收到答复，未擅自视为豁免。
- 缺少 `docs/agents/issue-tracker.md`；已告知后续启用 tracker 工作流需 `$setup-matt-pocock-skills`。本次用户明确指定 spec，审查不依赖 tracker。

## 遗留与交接

1. **短片规则未拍板**：时长恒 null，当前实现固定第 1 秒。[OSS 官方文档](https://www.alibabacloud.com/help/en/oss/user-guide/video-snapshots) 说明超出时长返回末关键帧；这不等价于 spec 的“短于 1 秒取第 0 秒”，不能声称该条已满足。待 David 决定是否接受固定 `t_1000` 的已知限制，或全体改取 `t_0`；收到决定后按确认范围接续。
2. **完整本地绿尚未取得**：需在允许本地 socket 的执行环境重跑全量测试；原样 lint 仍会扫描用户 scratch，需在获准的检查口径中排除 scratch，或由用户处理该临时脚本。未为取绿修改用户脚本或放宽仓内 lint 规则。
3. **staging 验收未执行**：三接口实环境含 MonsterXTY 的存量视频首图、curl jpg 与非纯黑帧仍按 spec 清单交 Opus/David 收货；David 的 spike 证据只证明单个对象截帧能力，不替代三处端到端验收。
4. 无迁移、无回填脚本，故本分支不执行回填验收项；未部署、未执行 prod/staging 写入、未 commit/push。

## Opus 收货（2026-11-07）

- 短片规则：接受固定 `t_1000`（OSS 对超出时长返回末关键帧，仍出图），spec「短于 1 秒取第 0 秒」按此口径视为满足，不另改。
- 本机（可开 socket）复跑：lint、typecheck 通过；全量 vitest 1967 通过 / 1 跳过，唯一失败为 `email-signup-verification` 全量负载下 5s 超时，单独重跑 22/22 通过，与本卡无关。
- spike 脚本已移出仓库。
