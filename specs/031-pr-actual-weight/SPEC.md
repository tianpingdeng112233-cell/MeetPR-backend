# SPEC 031 — PR 改按主项实测重量判定

- **Status: InProgress**
- **级别**: T1（既有事件触发语义与测试变更，无迁移）
- **拍板日期**: 2026-07-28
- **端**: backend（本仓）

## 1. 背景与目标

PR 判定全端从「e1RM 外推破纪录」改为「主项实测重量破纪录」。对一条
`completed = true AND failed = false` 的 `set_log`，先用
`resolveCompetitionFamily` 解析主项 family；仅当本组 `weight_kg` 严格大于以下两项中存在的最大值时，
写入 PR 事件：

1. 学员登记的该主项 1RM；
2. 该学员该主项此前完成且未失败的历史实测最高重量。

触发后的组自然进入历史查询，因此其重量会滚动成为后续判定的新基线，不新增单独的 PR 基线表。

## 2. 判定口径

### 2.1 family 与登记 1RM

- family 继续复用 `resolveCompetitionFamily`，解析不到 family 时不判 PR。
- 从 `student_onboarding_profiles` 读取 stance/style 与登记 1RM：
  - `squat` → `squat_1rm_kg`
  - `bench` → `bench_1rm_kg`
  - `deadlift` → `deadlift_1rm_kg`
- profile 或对应字段不存在时，登记 1RM 基线视为不存在。

### 2.2 历史实测最高

- 查询同一学员、同一 resolved family、检测时除当前组外已经存在的 `set_logs`；不以当前组
  `logged_at` 截断，避免回填旧日期或同毫秒记录绕过已知的全历史最高重量。
- 仅纳入 `completed = true AND failed = false` 的实测组。
- `assumed = true`（导入历史）组**永不作为触发方**，但**计入历史基线**——2026-07-09 拍板④：导入历史必须抬高 PR 基线，防老手新用户假 PR 刷屏（spec 053 同源）。
- 不设 28 天窗口，不应用 e1RM reps/RPE/confidence 门，不应用 e1RM 噪声带。
- 历史最大值与登记 1RM 中至少一项存在时，取二者最大值作为 `previous_best`。
- 两项都不存在时，本组只建立自然历史基线，不触发 PR。
- 当前 `weight_kg` 必须严格大于 `previous_best`；等于不触发。

### 2.3 与 e1RM 展示解耦

- e1RM 外推值不再参与或产生 PR 事件。
- `src/domain/e1rm.ts` 的计算规则与常量不改。
- `src/handlers/exercise-stats.ts` 的 e1RM、rolling window、`rep_prs` 次数 PR 表等展示口径全部不改。
- `rpe`、`coach_rpe`、reps、`e1rm_confidence` 与本 PR 判定无关。

## 3. 事件与 live-client 兼容

侦察结论：

- `src/jobs/daily-digest.ts` 只按 `event_type === 'pr_e1rm'` 计数，不读取 PR payload。
- `pr_congrats` signal 由 server 内部合并，但 `GET /coach/signals` 会把 signal payload 原样下发。
- `GET /coach/students/:studentId/events` 会把 `pr_e1rm` 事件 payload 原样下发。
- 因此 payload 存在 live client 直接消费路径，不能直接删除既有字段或替换事件 enum。

兼容策略：

- 沿用数据库与客户端已识别的 `event_type = 'pr_e1rm'`、`signal_type = 'pr_congrats'` 和既有 dedup key，
  避免迁移及严格客户端 enum 解码失败。
- payload additive-only 新增 `metric: 'actual_weight'`、`weight_kg` 与
  `previous_best_weight_kg`，作为新客户端的权威字段。
- 保留既有必填 `e1rm` 与 `previous_best` 数值字段，过渡期分别写入
  `weight_kg` 与 `previous_best_weight_kg` 的同值兼容别名，保证旧客户端 payload 解码和排序不崩。
- server 生成的喜报 reason 改为「实测重量新高」，不再声称 e1RM 新高。
- open `pr_congrats` 合并时优先读取 `weight_kg`；遇到部署前旧 payload 时回退到
  `e1rm`，从而兼容已有 open 行。

该策略不回写历史账本事件；历史 payload 仍按写入时的旧语义保留。

## 4. 实装范围

- 重写 `src/handlers/pr-detection.ts` 的触发组入选、登记基线、历史基线、比较和 signal 合并文案。
- 保持事件写入、教练归因、幂等、open signal 单行更新与过期刷新行为不变。
- 改写 `tests/pr-detection.test.ts` 为实测重量口径。
- 不新增数据库迁移，不改公开响应外层 shape，不改 daily digest 计数键。

## 5. 验收

1. 登记 squat 1RM 为 210kg：完成 150kg 不触发；完成 212.5kg 触发；随后完成
   211kg 不触发，证明 212.5kg 已自然滚动为历史基线。
2. 无登记 1RM 时，以同 family 的历史实测最高完成重量为基线。
3. 登记 1RM 与历史实测都不存在时，首条完成组不触发。
4. `failed = true` 或 `completed = false` 不触发。
5. `coach_rpe` / `rpe`、reps、`e1rm_confidence` 不影响判定；相同重量得到相同结果。
6. family 隔离正确，无法解析 family 时不触发。
7. payload 保留旧字段并新增实际重量字段；open signal 能兼容部署前旧 payload。
8. 同一 set-log hook 重放仍幂等，事件与 signal 不重复。
9. `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build` 全绿。
