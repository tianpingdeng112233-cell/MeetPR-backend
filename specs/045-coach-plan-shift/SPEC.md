# 045 — 教练后移计划（从选中日期起整体延后 N 天）

- **状态**: InProgress（David 2026-09-02 grill 拍板：1A 2不做 3A 4赞同 5同意 6进；入口稿拍板 A 日头入口）
- **级别 / 节奏**: T2（迁移 + 跨三仓）；P1。
- **对应**: plan-web `docs/specs/045-coach-plan-shift.md`（入口 UI）；iOS `specs/080-coach-plan-shift`（学员端消费）。
- **前置**: PR #273（`plan_updated` 推送：`push-payloads` 注册表、`pushDisplayName`、`deps.pushEnabled`）先合 staging，本 spec 从其后的 staging 切分支。
- **迁移号**: **0070**（2026-09-02 现场核实：origin/staging 头 0068；open PR #267 占 0069）。实装时再核一次。
- **先读**: 仓根 `CONTEXT.md`（推荐日期 / 后移）。

## 问题（为什么做）

学员出差、生病、比赛改期，教练想让「从某天起后面的课都往后挪几天」。现状：plan-web 只有改 `start_date` 的「整份后移 1 天」，已发布且有打卡的计划被 016 日历锁挡死，且只能整份挪、不能从某天起；学员自助顺延（V1/V2）已随推进制（035/071）下线。推进制下学员的「下一次训练」由游标决定，日期只是**推荐日期**，所以「后移」在推进制里唯一的物理含义 = 移动推荐日期（学员端展示 + 教练侧漏课/连胜结算口径），零调度风险。

## 语义（一句话）

教练对已发布计划选一个锚定日 `anchor_date` 与偏移 `offset_days`，**推荐日期 ≥ 锚定日且尚未完成**的训练日全部 `+offset_days`；以批次记录、可叠加、可撤销最近一批；不改计划树、不改游标、不改 `start_date`/`end_date`。

### 对 spec 035 拍板 2 的修订（⚖️2026-09-02）

035 的「推荐日期 = 位置投影，**不叠加** shift 覆盖层」修订为：**推荐日期 = 位置投影叠加最新一批后移（即 `effectivePlanDays` 的 `effectiveDate`）**。理由：拍板 2 反的是「学员落后就自动重算」，现在后移是教练显式动作，忠实教练排期的原意反而要求叠加。035 §「顺延域：冻结，不删」同步解冻：表与端点由本 spec 演进，学员自助入口不复活。

## 数据模型（0070-plan-shift-batches.sql）

```sql
ALTER TABLE plan_day_shifts ADD COLUMN seq BIGSERIAL NOT NULL;
-- 存量回填：按 (created_at, id) 顺序编号（相关子查询 count(*)+1，避开 pg-mem 不支持的窗口函数），再 setval 到 max(seq)
CREATE INDEX plan_day_shifts_seq_idx ON plan_day_shifts (seq);

CREATE TABLE plan_shift_batches (
  id          UUID PRIMARY KEY,                       -- = plan_day_shifts.batch_id
  plan_id     UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  actor_id    UUID NOT NULL REFERENCES users(id),
  actor_role  TEXT NOT NULL CHECK (actor_role IN ('coach', 'coached_student')),
  anchor_date DATE NOT NULL,
  offset_days INTEGER NOT NULL CHECK (offset_days BETWEEN 1 AND 30),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX plan_shift_batches_plan_created_idx ON plan_shift_batches (plan_id, created_at DESC);

-- 存量照护：既有批次（V2 整体顺延，每批固定 +1 天、作者=学员本人）逐批回填一行。
INSERT INTO plan_shift_batches (id, plan_id, actor_id, actor_role, anchor_date, offset_days, created_at)
SELECT s.batch_id, d.plan_id, min(s.student_id::text)::uuid, 'coached_student',
       min(s.shifted_to_date) - 1, 1, min(s.created_at)
FROM plan_day_shifts s JOIN plan_days d ON d.id = s.plan_day_id
GROUP BY s.batch_id, d.plan_id;
```

- `plan_day_shifts` 仍是「某天的目标日期」，只加一列 **`seq BIGSERIAL NOT NULL`**（顺序键，DB 分配；存量按 `(created_at, id)` 回填并 `setval`，加索引），批次元数据（谁 / 从哪天起 / 几天）上提到 `plan_shift_batches`。
- **真相仍是 `plan_day_shifts`**（⚖️2026-09-02 review 轮 2 修订）：有效日期、`total_shift_days`、「最新一批」一律从天级行派生；`plan_shift_batches` 只是元数据，缺父行（滚动窗口旧写者）时摘要按回填口径合成（`actor_role='coached_student'`、`offset_days=1`、`anchor_date=min(shifted_to_date)−1`、`created_at=min(row.created_at)`），无子行的空父批次不参与摘要与撤销。**批次顺序唯一定义**（⚖️2026-09-02 review 轮 4 修订）= 天级行 `seq`：批次序 = 该批天级行的 `min(seq)`，每天的有效日期取所在批次序最高的那行，`latest_shift` 与撤销对象用同一顺序——三处永不分叉。用 DB 序列而不是 `created_at`/uuid：`now()` 是事务开始时间（早于取锁）、JS 读 timestamptz 只有毫秒精度，且滚动窗口内省略 `created_at` 的旧镜像写入也必须单调——序列由 DB 在 INSERT 时分配，任何镜像在计划锁下写入都严格递增。写路径不再显式写 `created_at`。
- **expand 阶段不加 FK**（⚖️2026-09-02 review 修订）：部署序是「先迁移、后滚镜像」，旧镜像的学员 V2 路径只写 `plan_day_shifts` 不写父批次，立即加 FK 会让滚动窗口内的旧实例 500，违反硬规则 8。撤销由代码在同一事务里先删该批 `plan_day_shifts` 再删 `plan_shift_batches` 行；`batch_id → plan_shift_batches(id)` 的 FK + 级联留到 contract 阶段单独一号迁移（写入 FOLLOWUPS，条件：0070 镜像全量上线且无旧写者后；contract 迁移先做 reconciliation——用 0070 同一条 INSERT…SELECT 回填孤儿行的父批次、删除无子行的空批次——再加 FK）。
- 一个批次只属于一个计划（V2 语义），`GROUP BY batch_id` 安全；V1 单日顺延在 0038 里已各自成批。
- `src/db/types.ts` 手工增补 `PlanShiftBatchesTable`。
- 迁移测试 `tests/migrations/0070-plan-shift-batches.test.ts`：表 / CHECK / 删 plan 级联删批次 / **0070 后旧写者仍可只插 `plan_day_shifts`（无 FK）** / 回填（pg-mem 里先种两批 V2 行再跑迁移，断言各回填一行且 `offset_days=1`、`anchor_date = min(shifted_to_date)-1`）。

## 发布闸门（⚖️2026-09-02 review 轮 6 修订，硬规则 8）

新增 env `COACH_PLAN_SHIFT_ENABLED`（zod boolean，**默认 `false`**；`.env.example` 有占位）。关闭时 coach 分支的 `POST/DELETE /plans/:id/shift` 在 body 校验之后、任何 DB 读之前一律 409 `{ "error": "COACH_PLAN_SHIFT_DISABLED" }`，零写入；学员 V2 路径不受影响。上线四步：① 应用 0070 → ② 新镜像滚至全量（混跑期只有学员 V2 能写，`seq` 保证旧写者→新 reader 单调，无 coach 批次即无反向问题）→ ③ 确认无旧实例后 env 置 `true` 并重启 → ④ plan-web 再放开入口（PR #101 合并 / web swap）。台账落 `db/MIGRATIONS-APPLIED.md`。

## API

### `POST /plans/:id/shift`（新增 coach 分支；学员分支原样保留）

`requireRole(['coach', 'coached_student'])`。角色分流：

- **coach**：body（zod strict）`{ "anchor_date": "YYYY-MM-DD", "offset_days": 1..30 }`；缺失/非法 → 400 `VALIDATION_ERROR` envelope。计划须 `selectOwnedPlan` 命中，否则 404 `PLAN_NOT_FOUND`。
- **coached_student**：维持现行 V2 行为（无 body、锚今天、+1）**一字不改**——硬规矩 8：老包 iOS main 线仍可能调用。不给学员开放新 body（Q2 拍板：学员端不做入口）。

coach 分支事务内（复用 `lockPlanShiftContext`，锁序不变）：

1. `plan.status !== 'published'` → 409 `PLAN_NOT_ACTIVE`（草稿改 `start_date` 即可，不走后移）。
2. `effectivePlanDays(plan, days, shifts)` 取每天当前推荐日期；候选 = `effectiveDate >= anchor_date` **且** `plan_day_completions` 无该 day 记录（已完成天是历史事实，永不动）。候选为空 → 409 `SHIFT_NO_TARGET_DAYS`。
3. 插入 `plan_shift_batches` 一行（`id = randomUUID()`，`actor_role='coach'`），再为每个候选插入 `plan_day_shifts`（`student_id = plan.trainee_id`，`shifted_to_date = effectiveDate + offset_days`）。
4. 不检查 `set_logs`、不检查 `end_date`、不限每日次数（Q4/Q5 拍板：推进制下改日期零调度风险，允许越过 `end_date`）。

响应 201：

```json
{
  "batch_id": "uuid",
  "anchor_date": "YYYY-MM-DD",
  "offset_days": 3,
  "shifted_days": [{ "day_id": "uuid", "shifted_to_date": "YYYY-MM-DD" }],
  "skipped_completed_day_ids": ["uuid"],
  "total_shift_days": 3
}
```

事务提交后（fail-open，沿 #273 写法）：`deps.pushEnabled && status==='published'` → `tryEnqueuePushOutbox('plan_shifted', { aggregateId: batch_id, recipientId: trainee_id, payload: { coach_name, student_id, plan_id, anchor_date, offset_days } })`。日志 `plan_shifted_by_coach`。

### `DELETE /plans/:id/shift`（新增 coach 分支）

- **coach**：撤最新一批，**不看作者、不限当日窗口、不看打卡**（Q4 拍板）；最新一批按数据模型定义的批次顺序从天级行取（与学员 V2 的 `latestShiftBatch` 同源），无天级行 → 409 `NO_ACTIVE_SHIFT`。同事务先删该批 `plan_day_shifts`、再删批次行（可能不存在，无 FK，见数据模型）。204。提交后入队 `plan_shift_undone`（`aggregateId = 被删 batch_id`，payload `{ coach_name, student_id, plan_id }`）。
- **coached_student**：维持现行 V2 行为不改；唯一新增：最新一批的父批次 `actor_role='coach'` 时 → 409 `SHIFT_OWNED_BY_COACH`（教练的决定学员不能撤；无父行的孤儿批次仍按 V2 可撤）。

### 序列化（`GET /plans/:id`、`GET /students/:id/plans`）

- 每个 day 的 `shifted_to_date`：不变（学员端 iOS 080 开始消费它作推荐日期）。
- 计划级 `total_shift_days`：**口径改为** `max(effectiveDate − plannedDate)` 跨全部天、下限 0（不再是批次数）。存量数据下两者相等（每批整份 +1），老消费者无感。
- 计划级新增 `latest_shift`：`{ batch_id, actor_role, anchor_date, offset_days, created_at } | null`——批次 = 天级行派生的最新批次，元数据取父行、缺父行按回填口径合成（`toPlanShiftSummary` 扩展；一次聚合查询，禁 N+1）。
- `latest_shift_created_at` 保留（= `latest_shift.created_at`），iOS 教练端徽标继续可读。

### 推送文案（`src/jobs/push-payloads.ts` 注册两种）

| kind                | zh                                                                                     | en                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `plan_shifted`      | 标题「教练调整了你的计划日期」/ 正文「{coach_name} 把 {M月D日} 起的训练后移了 {N} 天」 | "Your plan dates changed" / "{coach_name} moved your training from {Mon D} onward by {N} day(s)" |
| `plan_shift_undone` | 「教练撤销了上次的日期调整」/「{coach_name} 恢复了原来的推荐日期」                     | "Plan date change undone" / "{coach_name} restored the previous dates"                           |

`collapseId = plan_id`，`threadId = 'plan_updated'`（与 #273 同线程，iOS 同一路由处理），`custom: { kind, student_id, plan_id }`。CJK 规则沿现有 `cjkFree` 处理。

## 与其它域的关系（全部为预期效果，不加分支）

- **结算 / 连胜 / 漏课**（`activity-settlement.ts`、`training-streak.ts`）已用 `effectivePlanDays`：教练后移自动把「该练未练」的判定推后。这是本功能对教练侧的正向价值，不是副作用。
- **计划树写端点**：`POST /plans/:id/days/batch` 的 `delete_day_ids` 会级联删该天的 `plan_day_shifts` 行（现状）——教练在网格里搬天/删天会丢那天的后移，plan-web 沿用现有 `shiftedDayMoveConfirm` 提示。不在后端补救。
- **016 日历锁**：后移是覆盖层，不碰 `start_date`/`plan_weeks`，不受锁。
- **PR #107（顺延 `target_date` 锚点）**：推进制下锚点语义已失效，建议关闭（待 David 拍板，不在本 spec 内动）。

## 测试 seam

- **路由层（主 seam）** `tests/plans/plan-day-shifts.test.ts`（supertest + pg-mem，现有文件追加 describe）：教练 happy path（3 天、跳过已完成天、越过 end_date）；再叠加一批（第二批基于第一批的有效日期）；撤销最近一批后 GET 回到上一批日期；draft → 409；非本人 → 404；候选为空 → 409；body 校验 400；学员分支回归（无 body +1 行为不变，学员带 body 仍走旧路径）；序列化 `total_shift_days`/`latest_shift`。
- **迁移** `tests/migrations/0070-plan-shift-batches.test.ts`（见上，另断言 `seq` 回填顺序 = `(created_at, id)`、新插入行 `seq` 大于全部存量）。
- **expand 兼容**（路由层）：孤儿天级行（无父批次）→ GET 显示后移日期、`total_shift_days`、合成 `latest_shift`，教练 DELETE 可撤；空父批次（无子行）不出现在摘要、不被撤销；**旧写者模拟**：新批次之后直接 INSERT 省略 `seq`/`created_at`（或 `created_at` 更早）的天级行 → 它按 `seq` 排最新，GET/DELETE 承认并依次回退；学员 V2 DELETE 遇最新为教练批次 → 409 `SHIFT_OWNED_BY_COACH` 且行不动。
- **发布闸门**（路由层）：默认 env 下 coach POST/DELETE 均 409 `COACH_PLAN_SHIFT_DISABLED` 且 DB 零写入、学员 V2 照常；测试上下文以 config 覆盖开启后跑其余 coach 用例；`tests/config` 断言 env 解析为 boolean、默认 false。
- **推送** `tests/jobs/push-payloads.test.ts`：两种 kind 的 zh/en 契约；`tests/plans/plan-day-shifts.test.ts` 中 `PUSH_ENABLED=true` 时 outbox 各落一行、`false` 时零行。

## Out of Scope

- 学员端任何写入口（Q2）；负偏移（提前）；单天任意改期；移动已完成天；改 `end_date`；同一 UTC 日次数限制。
- 学员分支（V2 +1）的收敛或下线（另起 spec，随 iOS main 线分诊）。
- 教练 iOS app 新 UI（现有「已顺延 N 天」徽标自动沿用新口径，文案改动归 iOS 080）。
- 后移写入 `plans.updated_at`（覆盖层不是树改动；plan-web 靠响应即时刷新）。
