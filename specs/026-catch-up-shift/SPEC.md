# 026 — 补练:漏课后的事后整体顺延(backend)

- **状态**:Draft
- **对应 iOS spec**:`061-catch-up-shift`(同一 wave 的客户端;本 spec 定义 wire 契约与服务端规则)。
  评审期在 worktree `~/Projects/apps/MeetPR-wt-061-spec/specs/061-catch-up-shift/SPEC.md`。
- **来源 / 授权**:David 2026-07-24 拍板 A「补练/事后顺延」。问题:学员漏课当天没打开 app,
  次日课已过期——iOS 记录 CTA 锁今天 + 顺延门 `SHIFT_ONLY_TODAY` 两锁叠加,漏课变永久欠账。
- **父机制**:spec 054 整体顺延 V2(`plan_day_shifts` batch 覆盖层)。

## 目标

学员存在「生效训练日 < 今天 且无 set log」的课时,允许一次调用把整份计划从最早漏课日起
整体后移 N 天(N = 今天 − 最早漏课日),使最早漏课落到今天。课序原封,复用 054 的
batch/撤销机制。

## 受影响面(全清单)

1. 迁移一个(additive):`plan_day_shifts` 加 `offset_days`;
2. `POST /plans/:planId/shift`:body 解析(新增,含兼容表)、catch_up 门与写入、
   响应累计值语义;
3. GET 计划序列化(列表 + 详情):`total_shift_days` 改从 `offset_days` 聚合;
4. `DELETE /plans/:planId/shift`:撤销窗口时区归一(两端);
5. 顺延域「今天」口径统一切 `shanghaiTrainingDay()`;
6. 测试矩阵(见 §测试要点)。

## 迁移(评审时 head = `0049`,本 spec 取 **0050**;开工时仍按仓规现场核实,被占则顺延)

```sql
BEGIN;
SET search_path TO public;
ALTER TABLE plan_day_shifts
  ADD COLUMN offset_days INTEGER NOT NULL DEFAULT 1 CHECK (offset_days >= 1),
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'today' CHECK (mode IN ('today', 'catch_up'));
COMMIT;
```

- `offset_days` 语义:该行所属 batch 的后移天数(同 batch 内所有行同值)。用 `INTEGER` 不用
  `SMALLINT`:N = 今天 − 最早漏课日无上限(`PLAN_NOT_ACTIVE` 只查 `status === published`,
  久置计划的 N 可以很大),`SMALLINT` 会在 32,767 越界变 500。
- `mode` 语义:batch 由哪种动作产生(同 batch 内同值)。撤销门按 mode 分流(见 §DELETE)——
  catch-up 与 today 的门不同,而 N=1 的 catch-up 无法从 offset_days 推断,必须落列。
  存量回填 `'today'`(V1/054 存量全是 today 族动作,门行为不变)。
- `src/db/types.ts` 中两列均声明为 `Generated<...>`(DEFAULT 兼容既有省略该列的 insert)。
- 存量回填 = DEFAULT 1:**保持现值不变**——现行 `total_shift_days` = batch 数
  (每次动作计 1),存量 batch(含 0038 从 V1 覆盖行回填的独立 batch,V1 单次动作可能
  实际跨多天)继续按「一次动作 = 1」计。**不重释历史**,新语义只对新写入的 batch 生效。
- 同步改 `src/db/types.ts`(hand-augmented,硬规则 #1)。

## API

### `POST /plans/:planId/shift`

**body 解析兼容表**(现行端点不解析 body,旧客户端发**无 body** POST——实现必须逐条满足):

| 请求形态 | 行为 |
|---|---|
| 无 body / 空 body / 无 `Content-Type` / `{}` | `mode = "today"`(与旧调用完全等价) |
| `{"mode":"today"}` | 同上 |
| `{"mode":"catch_up"}` | catch-up 语义(下述) |
| `mode` 为 null / 非字符串 / 未知值 | 400 `VALIDATION_ERROR` |
| body 为非对象 JSON(`null` / 数组 / 字符串 / 数字) | 400 `VALIDATION_ERROR`(勿让预处理默认值把 JSON `null` 当成无 body 的 today) |
| 未知多余字段 | 忽略(本端点专属兼容决策——它从「完全不解析 body」演进而来,收紧会误伤旧客户端;仓内其他计划 schema 多用 `.strict()`,本表不代表全仓惯例) |

- **`mode: "catch_up"` 语义**:
  - 服务端计算 `earliestMissed` = 生效日期 `< shanghaiTrainingDay(now)`、且该日无任何
    set log 的计划日中最早者(生效日期本身是无时区的 `YYYY-MM-DD`,**不做时区转换**,
    gym-day 只用于生成比较基准 today);`N = today − earliestMissed`(N ≥ 1)。
  - 受影响日 = 生效日期 ≥ `earliestMissed` 的所有计划日;写**一个** batch
    (`offset_days = N`,`mode = 'catch_up'`),每日 `shifted_to_date = 生效日期 + N`。
  - **门(按序判)**:现行 `NOT_PLAN_STUDENT` / `PLAN_NOT_ACTIVE` 不变 →
    `plan.kind !== 'regular'`(评估期 adaptation 等)→ 409 `PLAN_NOT_ACTIVE`
    (复用现有码与 iOS 映射;这是 061 legacy 缓存防线的服务端兜底)→
    无漏课日 → 409 `NOTHING_TO_CATCH_UP`(多设备竞态的正常态)→
    `earliestMissed` 之后存在已打卡训练日(课序已乱)→ 409 `SEQUENCE_DIVERGED`
    (一键补练只服务顺序完好场景,乱序恢复归教练)。
  - 今天的生效训练日若无 log,被一并后移(有 log 即已触发 `SEQUENCE_DIVERGED`)。
- **`mode: "today"`**:门与语义零改动(`SHIFT_ONLY_TODAY` / `ALREADY_STARTED` 照旧),
  写入 batch 的 `offset_days = 1`、`mode = 'today'`;唯一行为变化 = 「今天」口径(§时区)。
- **响应**:201 结构不变,但 **`total_offset_days` 语义升级 = Σ(各 batch `offset_days`)**
  ——与 GET 的 `total_shift_days` 恒等(iOS 直接用它更新缓存累计值,两者不一致会脏缓存;
  现行"数 batch"实现在 catch-up N>1 时即错)。
- **「已打卡 / set log」精确定义**:复用现行 `planDayHasLogs()` 口径——按 `plan_exercise_id`
  归属该 plan day 的任意 `set_logs` 行,不区分 `logged_date` 与状态(completed/failed/assumed
  一律算"动过")。与 activity-ledger 的"开练"口径(含 adhoc、排 assumed)**有意不同**,
  以"该日有没有被动过"为准。

### `DELETE /plans/:planId/shift`(撤销)

- 仍是撤最新 batch(catch-up batch 一次撤销回退整个 N),`ALREADY_STARTED` 门**按 batch 的
  `mode` 分流**:
  - `mode = 'today'`(含全部存量 batch):**保留现行判定**(只查 batch 前生效日期 = 今天的
    日子)。不推广到"任一 batch 日有 log"——`/sets/log` 不校验生效日期是否今天、且可显式传
    `logged_date`(`sets-log.ts:50` / `sets.ts:143`),today batch 内的未来日完全可能有 log,
    推广会实质收紧 today 撤销门,违背"today 零改动"承诺;
  - `mode = 'catch_up'`:**最新 batch 内任一日现存 set log → 409 `ALREADY_STARTED`**。
    现行门对 catch-up 锚点(batch 前在过去、batch 后落今天)是盲区——学员补练顺延后开练、
    再撤销,会把带日志的课退回过去;按任一日判定后,并发落进 batch 内其他日子的 log 同样
    挡撤销,不把动过的课悄悄搬回过去。
- **窗口判定两端同步归一**:现行 `utcDateOnly(now) === utcDateOnly(created_at)` 改为
  `shanghaiTrainingDay(now) === shanghaiTrainingDay(created_at)`——只换单端会出现
  「北京 05:00 创建、当场就 `UNDO_WINDOW_PASSED`」的荒谬态。
- 存量 batch 的窗口随口径切换有 ±数小时漂移:**接受**(窗口本就是"当天内反悔"的粗粒度承诺),
  spec 明示,回归测试覆盖。

### GET 序列化(列表 + 详情)

- 结构零改动;`total_shift_days` 改为 **Σ over distinct batch 的 `offset_days`**。
- 实现注意:列表 summary 现行查询只取 `batch_id, created_at`(`routes/plans/index.ts` 约 :221),
  需把 `offset_days` 带进聚合;**不做**按覆盖链推导(推导需原始计划日期 + 全序 batch fold,
  列表查询拿不到,且 `effectiveDateBeforeBatch()` 只排除目标 batch、对历史重放不适用——
  这就是落列而不推导的原因)。
- 聚合写法明确为:**先按 `batch_id` 去重(每 batch 取其唯一的 `offset_days`),再求和**;
  不得写成 `SUM(DISTINCT offset_days)`——那会把多个同为 1 的 batch 折叠成一个。

## 时区(随本 spec 一并修)

顺延域四处「今天/当天」——catch_up 的 `earliestMissed` 判定、`mode:"today"` 的训练日门、
撤销窗口**两端**——统一从 `utcDateOnly` 改为 `shanghaiTrainingDay()`(gym-day,北京 04:00
截断;`utils/date.ts:53` 现成)。UTC 与 gym-day 的分歧窗口 = **北京 04:00–08:00**
(04:00 前两者同日)。iOS 端内口径 = 现行 `WorkoutDatePolicy`(设备本地 04:00,见 061
§时区正典);设备在上海时两端恒等,旅行场景以服务端为权威,客户端检测仅乐观提示。
**范围仅限顺延域**,imported-history 等其余 `utcDateOnly` 调用点不动,归 gym-day 全量对齐卡。

## 并发(明示接受的竞态)

catch_up 事务沿用现行 `lockPlanShiftContext`(锁 `plans` + `plan_days` FOR UPDATE);
`set_logs` 写入不经过这些锁,故存在窗口:门检查通过后、batch 写入前,另一设备完成打卡,
结果是**已开练的日子被一并后移**。**接受该竞态,不为此改打卡写路径**:损害有限
(显示日期后移,数据无损)、教练可重排;为堵它引入 advisory lock 或改 set_logs 写路径,
代价与风险大于收益。注意:此场景下撤销会被推广后的 `ALREADY_STARTED` 门挡住
(batch 内已有 log)——这是有意的(不把动过的课悄悄搬回过去),恢复路径是教练侧,
不是学员自助撤销。spec 明示,不算实现缺陷。

## 测试要点

- catch_up:漏 1 天 / 漏多天(N 取最早)/ 跨周漏课 / 漏课后有已打卡日(`SEQUENCE_DIVERGED`)/
  无漏课(`NOTHING_TO_CATCH_UP`)/ 与 today 叠加(total 累计 = Σ offset_days,POST 与 GET 恒等)/
  撤销 catch-up batch 后 total 回退 N。
- body 兼容:无 body / 空 body / `{}` / `{"mode":"today"}` 全部走 today;非法 mode 400。
- 撤销门:catch-up 后对落到今天的课打卡再撤销 → `ALREADY_STARTED`;catch-up batch 内其他日
  被并发打卡再撤销 → 同样 `ALREADY_STARTED`;无 log 的 catch-up batch 当天可撤、回退整 N;
  **today batch 内未来日已有 log(显式 `logged_date`)仍可撤**(现行为保持,门未收紧)。
- 时区:北京 03:30 / 04:30 / 07:30 / **08:00 与 08:30**(分歧窗口闭合边界,防把 08:00 误含
  进窗口)× (catch_up 检测、today 门、undo 窗口)+ 跨 UTC 午夜的 `created_at` 归一;
  存量 batch 窗口漂移的显式断言。
- adaptation 计划 catch_up → `PLAN_NOT_ACTIVE`。
- ⚠️ pg-mem ≠ PG 既知坑(GREATEST / ON CONFLICT RETURNING / 无行锁),涉锁路径按仓内惯例
  用集成口径验证。

## 不做 / 边界

- 不动计划树、不做逐日单独补练;solo 无此功能;碰撞沿 054 拍板 3;
- 不做「今天没练」推送提醒(APNs W2 之后另立卡);
- 不重释存量 `total_shift_days` 历史值(见 §迁移)。
