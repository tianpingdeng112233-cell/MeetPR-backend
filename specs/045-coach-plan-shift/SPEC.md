# 045 — 教练后移计划（从选中日期起整体延后 N 天）

- **状态**: Draft（David 2026-09-02 grill 拍板：1A 2不做 3A 4赞同 5同意 6进；待 plan-web 入口稿拍板后转 InProgress）
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

ALTER TABLE plan_day_shifts
  ADD CONSTRAINT plan_day_shifts_batch_fk FOREIGN KEY (batch_id)
  REFERENCES plan_shift_batches(id) ON DELETE CASCADE;
```

- `plan_day_shifts` 行结构不变（仍是「某天的目标日期」），批次元数据（谁 / 从哪天起 / 几天）上提到 `plan_shift_batches`。删批次级联删该批所有天级行 → 撤销 = 删一行。
- 一个批次只属于一个计划（V2 语义），`GROUP BY batch_id` 安全；V1 单日顺延在 0038 里已各自成批。
- `src/db/types.ts` 手工增补 `PlanShiftBatchesTable`。
- 迁移测试 `tests/migrations/0070-plan-shift-batches.test.ts`：表 / CHECK / FK 级联（删批次连带删天级行；删 plan 连带删批次）/ 回填（pg-mem 里先种两批 V2 行再跑迁移，断言各回填一行且 `offset_days=1`、`anchor_date = min(shifted_to_date)-1`）。

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

- **coach**：取该计划 `plan_shift_batches` 中 `created_at` 最新一批（tie 按 `id`），**不看作者、不限当日窗口、不看打卡**（Q4 拍板）；无批次 → 409 `NO_ACTIVE_SHIFT`。删该批次行（级联删天级行）。204。提交后入队 `plan_shift_undone`（`aggregateId = 被删 batch_id`，payload `{ coach_name, student_id, plan_id }`）。
- **coached_student**：维持现行 V2 行为不改。

### 序列化（`GET /plans/:id`、`GET /students/:id/plans`）

- 每个 day 的 `shifted_to_date`：不变（学员端 iOS 080 开始消费它作推荐日期）。
- 计划级 `total_shift_days`：**口径改为** `max(effectiveDate − plannedDate)` 跨全部天、下限 0（不再是批次数）。存量数据下两者相等（每批整份 +1），老消费者无感。
- 计划级新增 `latest_shift`：`{ batch_id, actor_role, anchor_date, offset_days, created_at } | null`（`toPlanShiftSummary` 扩展；一次聚合查询，禁 N+1）。
- `latest_shift_created_at` 保留（= `latest_shift.created_at`），iOS 教练端徽标继续可读。

### 推送文案（`src/jobs/push-payloads.ts` 注册两种）

| kind | zh | en |
|---|---|---|
| `plan_shifted` | 标题「教练调整了你的计划日期」/ 正文「{coach_name} 把 {M月D日} 起的训练后移了 {N} 天」 | "Your plan dates changed" / "{coach_name} moved your training from {Mon D} onward by {N} day(s)" |
| `plan_shift_undone` | 「教练撤销了上次的日期调整」/「{coach_name} 恢复了原来的推荐日期」 | "Plan date change undone" / "{coach_name} restored the previous dates" |

`collapseId = plan_id`，`threadId = 'plan_updated'`（与 #273 同线程，iOS 同一路由处理），`custom: { kind, student_id, plan_id }`。CJK 规则沿现有 `cjkFree` 处理。

## 与其它域的关系（全部为预期效果，不加分支）

- **结算 / 连胜 / 漏课**（`activity-settlement.ts`、`training-streak.ts`）已用 `effectivePlanDays`：教练后移自动把「该练未练」的判定推后。这是本功能对教练侧的正向价值，不是副作用。
- **计划树写端点**：`POST /plans/:id/days/batch` 的 `delete_day_ids` 会级联删该天的 `plan_day_shifts` 行（现状）——教练在网格里搬天/删天会丢那天的后移，plan-web 沿用现有 `shiftedDayMoveConfirm` 提示。不在后端补救。
- **016 日历锁**：后移是覆盖层，不碰 `start_date`/`plan_weeks`，不受锁。
- **PR #107（顺延 `target_date` 锚点）**：推进制下锚点语义已失效，建议关闭（待 David 拍板，不在本 spec 内动）。

## 测试 seam

- **路由层（主 seam）** `tests/plans/plan-day-shifts.test.ts`（supertest + pg-mem，现有文件追加 describe）：教练 happy path（3 天、跳过已完成天、越过 end_date）；再叠加一批（第二批基于第一批的有效日期）；撤销最近一批后 GET 回到上一批日期；draft → 409；非本人 → 404；候选为空 → 409；body 校验 400；学员分支回归（无 body +1 行为不变，学员带 body 仍走旧路径）；序列化 `total_shift_days`/`latest_shift`。
- **迁移** `tests/migrations/0070-plan-shift-batches.test.ts`（见上）。
- **推送** `tests/jobs/push-payloads.test.ts`：两种 kind 的 zh/en 契约；`tests/plans/plan-day-shifts.test.ts` 中 `PUSH_ENABLED=true` 时 outbox 各落一行、`false` 时零行。

## Out of Scope

- 学员端任何写入口（Q2）；负偏移（提前）；单天任意改期；移动已完成天；改 `end_date`；同一 UTC 日次数限制。
- 学员分支（V2 +1）的收敛或下线（另起 spec，随 iOS main 线分诊）。
- 教练 iOS app 新 UI（现有「已顺延 N 天」徽标自动沿用新口径，文案改动归 iOS 080）。
- 后移写入 `plans.updated_at`（覆盖层不是树改动；plan-web 靠响应即时刷新）。
