# 028 — 学员训练结算端点(workout settle & summary)

- **状态**: InProgress
- **来源**: 黑金 v3 学员端结算页(handoff-v3 样机 `showDone`/`showReview`)的后端依赖;David 2026-07-26 拍板「结算要做」。T2 / P1。
- **权威口径**: 活动台账分类学与红线 = spec 018;gym-day 04:00 截断 = `shanghaiTrainingDay()`(`src/utils/date.ts:53`);streak = spec 027 + `src/domain/training-streak.ts`。
- **迁移**: **无**(零 schema 改动,这是本设计的硬约束,见 §设计立场)。
- **明确不做**: 聊天事件卡(chat 消息 kind 仍只有 `text|image`,合流归后续聊天皮肤卡)、教练端消费 UI(驾驶舱 wave)、离线本地先落库(iOS 独立子轮)、新信号类型(不动 `SIGNAL_TYPES`、不碰 `student_signals`)。

## 设计立场(为什么不是 CREATE TABLE workout_completions)

spec 018 已把「练完」做成一等公民:每次 `POST /sets/log` 的可失败旁路钩子
(`recordSetLogActivity`,`src/handlers/activity-ledger.ts:175`)维护
`training_sessions` 状态机((student, gym-day) 唯一行,`in_progress→completed` 终态不回退),
并在达成时写 `student_events.session_completed` 事实事件(dedup_key
`session_completed:{studentId}:{sessionDate}`,教练归因 `resolveEventCoachId`:计划教练优先、
回退最近 accepted bond)。streak(spec 027)只读 `training_sessions.session_date`,与状态无关。

因此「教练已收到你的训练日志」在台账层**已经为真**;结算页缺的只是:
① 一个把当日聚合数字(容量/组数/次数/均 RPE)+ streak + 教练名一次给全的读口;
② 当钩子曾经旁路失败时,一个**修复台账**的机会(钩子按 spec 018 硬规则 #8 是
try/catch-warn,允许静默失败)。

新开 `workout_completions` 表 = 与 `training_sessions` 平行的第二套"练完"事实源,
必然产生口径漂移(首轮评审 12 条 BLOCKER 大半源于此)。**否决**。

## API

`POST /students/me/workouts/settle`

- 挂载:`studentXxxRouter` → `/students` 前缀(`src/routes/index.ts` 现有模式);
  `requireRole('coached_student', 'self_train_student')` + handler 内 `req.user` narrowing
  (两层守卫惯例,同 `src/routes/training-streak.ts:29`)。
- 语义:POST 而非 GET,因为它可能产生写效果(台账修复);对同一输入幂等,可重放。

请求体(strict zod;`gym_day` 可选 ISO date,缺省 = `shanghaiTrainingDay(now)`):

```json
{ "gym_day": "2026-07-26" }
```

```json
{}
```

日期口径(唯一权威,消除三义性):聚合与会话都锚 `set_logs.logged_date`
——它在写入时就是 gym-day(coached 缺省 `shanghaiTrainingDay()`,adhoc 客户端必传,
`src/routes/sets.ts:81-88,146`)。离线晚结算时客户端显式传当时的 `gym_day`:
**聚合读取锚定同一 `logged_date`,不会漂到服务端收包日**;计时为近似值,首次补事件用
补写时点的归因与状态(不承诺与当日即时结算全同,见 §行为 2)。

### 行为

1. 取 `set_logs WHERE student_id = me AND logged_date = gym_day AND NOT assumed`
   (排除 assumed 与台账/缺练判定同口径,0041:97 等四处先例)。
   **已提交组**(`completed OR failed`)为空 → `409 { "error": "WORKOUT_NO_SETS_LOGGED" }`
   (UPPER_SNAKE 惯例,同 `SIGNAL_NOT_OPEN`;400 校验错走 `validationEnvelope`)。
   判 409 用"无已提交组"而非"无任何行":只有 `completed=false AND failed=false`
   占位行的日子照样 409,不返回零容量 200(需用例覆盖)。
2. **结算修复** `settleSessionForGymDay(db, studentId, gymDay)`(从
   `recordSetLogActivity`/`sweepTimedOutSessions` 内部提炼共享件):
   - 会话 upsert 沿用钩子逻辑;**终态采用 sweep 的归档规则**(这是显式拍板,
     不是钩子行为的纯复刻):`plannedComplete` 或纯 adhoc(`plan_day_ids` 空)→
     `completed`;触达计划但未练完 → `partial`;并按 `writeSessionEvent` 补写对应
     事实事件(dedup_key 幂等,`onConflict doNothing`;append-only:此后学员再补组,
     台账的 reopen/补写 completed 机制照旧,partial 事件保留)。语义 = 「学员宣告今天
     练完了,当场收账」,与 sweep 超时收账同一套终态函数,禁止第三套规则。
   - 终态不回退:已 `completed` 的会话重放 settle 不改会话行。但**事件存在性必须保证**:
     0041 只回填了 `training_sessions` 没回填 `student_events`,终态会话若缺对应事实事件,
     settle 补写之(dedup_key 幂等使补写安全);「零写入」只指会话行与已存在的事件。
   - 零已提交组不建会话(与 PR #77 的 sweep 零组 DELETE 语义一致;路由层已 409)。
   - **计时恢复规则**(会话行缺失的历史日修复):有 in-window
     (`shanghaiTrainingDay(logged_at) == gym_day`)时间戳 → 钩子同款 min/max;
     没有(补录/离线晚同步)→ `started_at = last_set_at = min(logged_at)`(该日全部
     已提交组),事件 payload 的 `duration_seconds` **恒为 0**,`occurred_at = now()`。
     回执与文档明示:历史修复日的时间点是近似值。
   本路径**不写 `student_signals`** → 不触发 LOCK CONTRACT(users FOR UPDATE)。
3. 聚合(全部服务端算,客户端不上报数字):
   - `total_volume_kg`:Σ(weight_kg × reps) over **已提交组(completed OR failed)**——
     样机口径(`rvTon` 对全部已记录组求和,含 failed)。累加用 PR #94 的整数分厘法
     (`Math.round(weight×100) × reps` 累加后 /100)防浮点漂移。
     ⚠️ 口径声明:PR #94 周容量过滤 `completed && !assumed`(不单独排 failed;
     按 0017 约定 failed 组通常同时 completed=true,两口径对常规数据一致)。
     真正的分叉面只有 `failed=true && completed=false` 的行:本端点计入(样机
     rvTon 口径),#94 不计。两者并存是产品事实,响应字段名不共用术语。
   - `completed_sets` = completed 且非 failed;`failed_sets` = failed;
     `total_reps` = Σreps(同上范围);`avg_rpe` = rpe 非 null 的已提交组均值,1 位小数,
     全空则 null(先例 `exercise-stats` / PR #94 `:264-267`)。
4. streak:结算修复后调 `getStudentTrainingStreak(db, studentId, gymDay)`(handler 层,
   自带 sessions/published plans/顺延/评估豁免装配;不是直接调纯函数
   `computeTrainingStreak`)。修复后与 `GET /students/me/streak?as_of=gym_day` 必然同值。
5. 教练归因 = **事件快照,不是现绑定重算**:settle 完成后(含事件补写),按**当前
   session status 选对应事件类型**(completed → `session_completed`;partial →
   `session_partial`;partial 补完后两事件并存时以 completed 为准)读其 `coach_id`
   作为响应的 coach(该值由 `writeSessionEvent` 的既有归因路径写入——计划教练优先、
   回退当时的 accepted bond)。事件已存在(dedup 命中)→ 用旧事件的 coach_id,
   **换教练后不得把日志错报给新教练**;`coach_id` 为 null(当时无归因)→ 响应 `null`。
   `coach.name` 锁定取 `coach_profiles.display_name`;profile 缺失 → `name: null`
   (coach 对象保留 id,iOS 文案自行回退「教练」)。

### 响应(200,序列化走 `serialization.ts` 的 `decimal/dateOnly/timestamp`)

```json
{
  "workout": {
    "gym_day": "2026-07-26",
    "session_status": "completed",
    "plan_day_ids": ["..."],
    "total_volume_kg": "6510.00",
    "completed_sets": 6,
    "failed_sets": 1,
    "total_reps": 21,
    "avg_rpe": "8.1"
  },
  "streak": { "current": 12, "as_of": "2026-07-26",
              "started_on": "2026-06-30", "last_session_date": "2026-07-26" },
  "coach": { "id": "...", "name": "李明" }
}
```

字段注:`session_status` = `training_sessions.status` 修复后现值;`plan_day_ids` 空数组
= 纯 adhoc 日;`avg_rpe` 可为 null;`coach` 可为 null,`coach.name` 可为 null(无 profile)。

错误:401 `AUTH_INVALID_TOKEN` / 403 `AUTHORIZATION_FORBIDDEN`(中间件)、
400 `VALIDATION_ERROR` envelope、409 `WORKOUT_NO_SETS_LOGGED`。
无 404:gym_day 是自然键,不存在越权维度(只查 `me`)。

## 与在飞 PR 的协调

- **PR #77(spec 020)**:唯一交叠 = `activity-ledger.ts` 的内部重构(提炼
  `settleSessionForGymDay`)与其 sweep 零组 DELETE 修复。无共享迁移(本 spec 零迁移)。
  合并顺序无关;后合的一方做常规 rebase。若 #77 先合,复用其零组语义;若本卡先合,
  #77 rebase 时零组 DELETE 不受影响(结算路径零组根本不建行)。
- **PR #94**:无文件交叠;仅口径并存声明(见 §行为 3)。
- **PR #99 / DELETE /me**:本 spec 不新增任何表与 FK,无删除策略议题。

## 验收标准

1. 单测(`settleSessionForGymDay`):
   ① 钩子已正常结算 → 结算调用零写入(幂等,`session_completed` 不重复);
   ② 模拟钩子旁路失败(会话行缺失/落后)→ 修复后 status/事件与 sweep 归档路径一致;
   ③ 零已提交组 → 不建会话,路由层 409(含"只有 completed=false/failed=false 占位行"用例);
   ④ assumed 组不参与聚合与结算;
   ⑤ 终态不回退(completed 会话重放 settle 不降级);
   ⑥ **终态规则**:纯 adhoc 日 settle → `completed` + `session_completed` 事件;
     触达计划未练完 → `partial` + `session_partial` 事件;partial 后补组再 settle →
     reopen 并可补写 completed 事件(partial 事件保留,append-only);
   ⑦ **计时恢复**:无 in-window 时间戳的历史日 → `started_at = last_set_at = min(logged_at)`,
     `duration_seconds = 0`,事件 `occurred_at = now()`;有 in-window → 与钩子 min/max 一致;
   ⑧ **事件补写**:0041 风格「终态会话行但无事实事件」→ settle 补写对应事件并可返回 coach;
     partial+completed 两事件并存 → 快照选 completed。
2. 路由测试:
   ① 未认证 401 / coach 与 admin 角色 403(envelope 断言);
   ② 非法 gym_day → 400 `VALIDATION_ERROR`;
   ③ 聚合正确:含 failed 组计容量、整数分厘无浮点尾差、rpe 空值不入分母、
     混合 coached+adhoc 同日合并聚合;
   ④ streak 与 `GET /students/me/streak?as_of=gym_day` 同值;
   ⑤ 教练快照:coached(计划教练)/纯 adhoc(当时 bond)/无绑定 null 三分支,
     以及**换绑后重放 settle 仍返回旧事件的 coach**(不错报新教练);
   ⑥ 幂等:连续两次 settle 响应一致,事件表行数不变。
   pg-mem 红线照守(不用 ON CONFLICT RETURNING/部分索引 target/COUNT(DISTINCT) 双 join;
   时区用 INTERVAL 硬算)。
3. `pnpm test` 全绿 + 仓内 lint;CI 绿。
4. 部署备注:与 #105(streak)同车随下次 staging 统一部署;iOS W4 结算页联调前必须在线。
