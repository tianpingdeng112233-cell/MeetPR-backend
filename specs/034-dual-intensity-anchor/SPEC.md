# SPEC 034 — 计划组双强度锚点（load + RPE 同存）

- **Status: Draft**
- **级别**: T2（additive 迁移 + 数据模型 + 三端跟进）
- **拍板日期**: 2026-08-04（David 拍板 B：双值落库；触发源 = plan-web 强度列拆两列需求）
- **端**: backend（本仓，W1）；plan-web（W2，另卡）；iOS 学员端（W3，另起 spec）

## 1. 背景与目标

教练在 plan-web 写强度今天是「单列 + KG/RPE/自重 模式徽章」：整行一个模式，
格子里的数字按模式解释。力量举处方常态却是双锚——「170kg @9」（重量 + RPE 封顶）
今天表达不了；同一行「第 1 组 kg、后 4 组 RPE」的 top single + back-off 写法也被
行级统一模式挡住（wire 本身是逐组的，只是 web 前端自我设限）。

David 拍板：强度拆成 load 列 + RPE 列，**任一列填了即算该组强度完成；两列同填 =
双锚同存落库**。本 spec 只覆盖 backend 数据模型与 API；编辑器 UI 归 W2。

## 2. 数据模型

迁移 `db/migrations/00XX-plan-set-dual-anchor.sql`（**编号实装时现场取号，
勿照字面建**；写作本 spec 时 staging 账本 head = 0056）：

```sql
ALTER TABLE plan_sets ADD COLUMN target_rpe NUMERIC(3,1);

ALTER TABLE plan_sets ADD CONSTRAINT plan_sets_target_rpe_check CHECK (
  target_rpe IS NULL OR
  (intensity_mode = 'weight' AND target_rpe BETWEEN 1.0 AND 10.0)
);
```

语义（`target_value`/`intensity_mode` 含义不变，纯 additive）：

| intensity_mode | target_value | target_rpe | 含义 |
|---|---|---|---|
| `weight` | kg | NULL | 纯重量（现状） |
| `weight` | kg | 有值 | **双锚：Xkg @RPE** |
| `rpe` | RPE | NULL（约束强制） | 纯 RPE（现状） |

- 只填 RPE 不引入新形态：仍是 `intensity_mode='rpe'` 单值。`target_rpe` 只在
  weight 模式下承载「附加 RPE 锚」，避免同一个 RPE 有两个可能的存放处（单一真源，
  防双写漂移）。
- 存量行 `target_rpe` 全 NULL，语义即「纯重量/纯 RPE」，无回填。

## 3. API

### 3.1 Schema（`src/routes/plans/schemas.ts`）

- `PlanSetBodySchema` 增加 `target_rpe: z.string().nullable().optional()`，
  经现有 `TargetValueSchema` 同款数值字符串处理。
- `validateSetBody` 增加校验：
  - `target_rpe` 非空时必须 `intensity_mode === 'weight'`，否则 422
    `target_rpe only allowed with intensity_mode "weight"`。
  - 数值范围 1.0–10.0，且 **0.5 步进**（与 set_log 侧「RPE 0.5 步进收紧」同口径；
    存量 `target_value` 的 RPE 模式不追加步进校验，维持现状不动）。
- `PatchPlanSetBodySchema.partial()` 沿用同一 superRefine。**Patch 组合语义**：
  patch 后的最终态若为 `intensity_mode='rpe'` 且 `target_rpe` 非空 → 422。
  实现上：把 mode 从 weight 改为 rpe 的 patch 必须显式带 `target_rpe: null`
  （或服务端读取现值合并后校验拒绝），不允许静默留下孤儿 RPE。
- Batch 端点（spec 009）`BatchExerciseSchema.sets` 复用 `CreatePlanSetBodySchema`，
  字段自动生效，无独立改动；但需补 batch 路径的写入与回读测试。

### 3.2 序列化与读取

- `PlanSetResponse` 增加 `target_rpe: string | null`（`serialization.ts` +
  `src/db/types.ts` 手工增补，遵守 no-ORM 纪律）。
- 学员端读取计划的所有出口（`GET /plans/...`、学员今日训练等凡带 sets 的响应）
  统一带出该字段。

## 4. 兼容性

- 纯 additive：老 iOS（TestFlight 1.0(17) 及以前）与线上 plan-web 忽略新字段，
  照常工作；双锚组在老客户端降级显示为纯重量，可接受（内测期，无需 env gate）。
- 不改任何既有字段含义、不动 CHECK 既有约束、无 breaking response 变更，
  符合 CLAUDE.md 硬规则 8，可独立部署。
- 下游口径不变：tonnage/容量统计按 `intensity_mode='weight'` 的 `target_value`
  计，双锚组自然计入；e1RM 走实测 set_logs，与计划处方无关；algo engine
  读者对未知列免疫（additive）。

## 5. 三端分工（本 spec 只实装 W1）

- **W1 backend（本仓）**：迁移 + schema 校验 + 序列化 + 测试。合并后必须部署
  staging 并记账 `db/MIGRATIONS-APPLIED.md`。
- **W2 plan-web（另卡，依赖 W1 部署）**：强度列拆 load/RPE 两列；逐组任一列填写
  即完成（inputGuard/发布门禁同步）；两列同填 → `weight` + `target_rpe`；只填
  RPE → `rpe` 模式；逐组混填放开；自重保留行级切换。v1 只收 RPE 值，不做 RIR
  输入换算。
- **W3 iOS（另起 spec，随后续班车）**：学员端计划展示 "170kg @9"；打卡界面
  目标提示带 RPE 封顶。

## 6. 验收标准

1. 迁移在干净库与含存量数据库上均可应用；存量行 `target_rpe IS NULL`。
2. vitest + supertest 覆盖：
   - create/patch/batch 写入 `target_rpe` 成功回读；
   - `intensity_mode='rpe'` + `target_rpe` 非空 → 422（create、patch 组合态、batch 三路径）；
   - 范围/步进违规（0.4、10.5、0.3 步进）→ 422；
   - 既有无 `target_rpe` 请求完全不受影响（回归）。
3. `GET` 计划树响应含 `target_rpe`，老字段 shape 不变（快照回归）。
4. lint/build/test 全绿；PR 开向 `staging`，合并后部署并记账。
