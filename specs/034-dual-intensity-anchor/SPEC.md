# SPEC 034 v2 — 计划组强度体系全量扩展(六种强度形式 + 独立重量列)

- **Status: Draft v2**(v1「load+RPE 双锚」已被 2026-08-09 扩板取代,整体重写)
- **级别**: T2(additive 迁移 + 数据模型收编 + 三端跟进)
- **拍板记录**:
  - 2026-08-04(v1)David 拍板 B:双值落库。
  - 2026-08-09(v2)David 扩板,参照竞品 PowerSheets 强度体系:
    1. 强度列扩成**六种表现形式**:%1RM / RPE / RIR / 重量区间 / RPE 区间 / 固定重量;
    2. 强度与具体重量**分列**:强度=处方的表现形式(行级一个值);重量=具体 kg(**选填**,
       一格=各组同重,或「逐组标重」逐组各一框,即现状模式保留);
    3. 数据模型拍甲:**收编迁移 0033 的算法引擎强度列**,顺手完成 0033 注释里欠的
       「与 intensity_mode 的 reconciliation」,不另起第三套体系;
    4. % 的锚点问题先不展开:v1 按「1RM 的百分比」理解,不引入 TM 概念(pct_of_tm
       留给算法引擎,见 §3.3)。
- **端**: backend(本仓,W1);plan-web(W2,另卡);iOS 学员端(W3,另起 spec)

## 1. 背景与目标

plan-web 强度今天是「单列 + KG/RPE/自重 模式徽章」:整行一个模式,格子里的数字按模式
解释。力量举处方的真实形态远比这丰富:`72.5%`、`RPE 7-8`、`RIR 2`、`165-175kg`、
`170kg @9`(双锚)都是教练日常写法,今天全都表达不了。

本 spec 把计划组的强度模型升级为:**强度形式(六选一,行级)× 具体重量(选填,可逐组)**
的正交组合,任一维度填了即算该组强度完成;两维同填 = 双锚同存。

## 2. 产品口径(W2 UI 的落库语义,先钉死)

编辑器行结构:`# | 目标部位 | 动作 | 组数 | 次数 | 强度 | 重量 | 备注`。

- **强度列**(行级一个值,落库时复制到该行每组):类型六选一
  | 类型 | 值形态 | 例 |
  |---|---|---|
  | `pct` %1RM | 单值,20.0–110.0,0.5 步进 | 72.5% |
  | `rpe` | 单值,1.0–10.0,0.5 步进 | RPE 8 |
  | `rir` | 单值整数,0–9 | RIR 2 |
  | `weight_range` 重量区间 | 两值 kg,low < high | 165–175kg |
  | `rpe_range` RPE 区间 | 两值,1.0–10.0,0.5 步进,low < high | RPE 7–8 |
  | `fixed_weight` 固定重量 | **无独立值**,具体数字填重量列 | 「固定重量」+ 重量列 170 |
- **重量列**(选填):具体 kg。默认一格 = 该行各组同重;切「逐组标重」= 每组一框,
  逐组可不同(现状模式,原样保留)。
- **完成判定**:强度列或重量列任一有值即该组完成;两者同填 = 双锚(如 RPE7 + 170kg)。
- **组合约束**:`fixed_weight` 必须带重量列;`weight_range` 不得再带重量列(区间与
  定值矛盾,422);其余四种类型与重量列自由组合。
- 强度列行级、重量列可逐组;「逐组不同 RPE」v1 不做。RIR 不换算成 RPE 存储,原样落库。

## 3. 数据模型(甲:收编 0033)

### 3.1 现状盘点

- 0003:`intensity_mode TEXT NOT NULL CHECK IN ('weight','rpe')` + `target_value
  NUMERIC(6,2) NOT NULL`(CHECK 按模式限定范围)。**两字段均非空**——这是老客户端
  (iOS ≤1.0(18)、线上 plan-web)唯一认识的强度形态,不可破坏(CLAUDE.md 硬规则 8)。
- 0033(已应用,未接 API):`load_mode TEXT`(自由文本,注释明言「与 intensity_mode
  并存等 reconciliation」)、`rpe_low SMALLINT`、`rpe_high SMALLINT`、
  `rir_target SMALLINT`、`pct_of_tm NUMERIC` 等。本 spec 即那次 reconciliation。

### 3.2 迁移 `db/migrations/00XX-intensity-system.sql`

(**编号实装时现场取号,勿照字面建**;写作本 spec 时 staging 迁移目录 head = 0057。)

```sql
-- 1) 收编:load_mode 从自由文本收紧为六值枚举
ALTER TABLE plan_sets ADD CONSTRAINT plan_sets_load_mode_check CHECK (
  load_mode IS NULL OR
  load_mode IN ('pct', 'rpe', 'rir', 'weight_range', 'rpe_range', 'fixed_weight')
);

-- 2) 收编:RPE 区间列放宽为 0.5 步进可存(SMALLINT → NUMERIC 为安全放宽)
ALTER TABLE plan_sets
  ALTER COLUMN rpe_low  TYPE NUMERIC(3,1),
  ALTER COLUMN rpe_high TYPE NUMERIC(3,1);

-- 3) 新增:教练手写 %(锚 1RM;与算法引擎的 pct_of_tm 分工见 §3.3)
ALTER TABLE plan_sets ADD COLUMN target_pct NUMERIC(4,1);

-- 4) 新增:重量区间
ALTER TABLE plan_sets ADD COLUMN weight_low  NUMERIC(6,2),
                      ADD COLUMN weight_high NUMERIC(6,2);

-- 5) 新增:单值 RPE 锚(v1 双锚设计保留,归属改为 load_mode='rpe')
ALTER TABLE plan_sets ADD COLUMN target_rpe NUMERIC(3,1);

-- 6) 新增:具体重量(新体系真源;老 target_value 降级为投影,见 §4)
ALTER TABLE plan_sets ADD COLUMN target_weight NUMERIC(6,2);

-- 7) 值域约束(app 层为主,DB 层兜底)
ALTER TABLE plan_sets ADD CONSTRAINT plan_sets_intensity_values_check CHECK (
  (target_pct    IS NULL OR (target_pct BETWEEN 20.0 AND 110.0)) AND
  (target_rpe    IS NULL OR (target_rpe BETWEEN 1.0 AND 10.0)) AND
  (rir_target    IS NULL OR (rir_target BETWEEN 0 AND 9)) AND
  (rpe_low       IS NULL OR (rpe_low  BETWEEN 1.0 AND 10.0)) AND
  (rpe_high      IS NULL OR (rpe_high BETWEEN 1.0 AND 10.0)) AND
  (rpe_low  IS NULL OR rpe_high  IS NULL OR rpe_low  < rpe_high) AND
  (weight_low IS NULL OR weight_high IS NULL OR weight_low < weight_high) AND
  (target_weight IS NULL OR (target_weight > 0 AND target_weight < 1000)) AND
  (weight_low  IS NULL OR (weight_low  > 0 AND weight_low  < 1000)) AND
  (weight_high IS NULL OR (weight_high > 0 AND weight_high < 1000))
);
```

模式 × 字段矩阵(**单一真源:每模式只用自己那组值列**,其余必须 NULL,app 层强制):

| load_mode | 强度值列 | target_weight | 说明 |
|---|---|---|---|
| NULL | — | 必填 | 只填重量列(现状纯重量) |
| `pct` | target_pct | 可选 | 双填 = 双锚 |
| `rpe` | target_rpe | 可选 | 双填 = 「170kg @9」 |
| `rir` | rir_target | 可选 | 双填 = 双锚 |
| `rpe_range` | rpe_low + rpe_high | 可选 | 双填 = 双锚 |
| `weight_range` | weight_low + weight_high | **禁止** | 区间与定值矛盾 |
| `fixed_weight` | — | **必填** | 形式徽章,值在重量列 |

- 0.5 步进(pct / rpe / rpe_range)在 app 层校验,与 set_log 侧「RPE 0.5 步进收紧」同口径。
- 存量行新列全 NULL、`load_mode` NULL,语义即「纯重量/纯 RPE 旧形态」,无回填。
- 0033 其余列(`method_anchor`、`effort_method`、`fatigue_pct_target` 等)本波不动,
  仍归算法引擎。

### 3.3 `target_pct` 与 `pct_of_tm` 的分工

教练手写 % 的白话语义是「1RM 的百分比」;`pct_of_tm` 是算法引擎的 %TM 处方位
(锚 `plans.training_max`,带 TM 新鲜度校验,W2+ 才启用)。两者语义真不同,强行复用
会让算法的 TM 新鲜度拒绝逻辑误伤教练手写值,故分列。将来算法波若要归一,在算法侧
spec 里做。**本波不引入 TM 概念**(David 2026-08-09:% 锚点先不展开)。

## 4. 老客户端降级投影(兼容核心)

`intensity_mode` + `target_value` 均 NOT NULL 且 CHECK 只认两模式——老 iOS 的枚举
解码遇到未知模式会整响应解析失败(登录红线级风险),所以**这两个字段永远只出现
合法旧值**。新体系写入时,服务端同步计算投影(确定性,写入时落库,不动态算):

| 新形态 | 投影 intensity_mode / target_value |
|---|---|
| load_mode NULL(纯重量) | `weight` / target_weight(现状,双写同值) |
| 任意模式 + target_weight 有值 | `weight` / target_weight(强度细节丢失=可接受降级) |
| `fixed_weight` | `weight` / target_weight |
| `rpe`(无重量) | `rpe` / target_rpe |
| `rpe_range`(无重量) | `rpe` / rpe_low(取区间下限,信息基本正确) |
| `rir`(无重量) | `rpe` / (10 − rir_target)(标准换算,信息正确) |
| `weight_range` | `weight` / weight_low(取区间下限) |
| `pct`(无重量) | `rpe` / 分段映射表(见下) |

`pct` 无重量时的分段映射(粗投影,只求老端不崩且方向正确;新客户端不读它):
`<60%→5.0;60–70→6.0;70–80→7.0;80–87.5→8.0;87.5–92.5→9.0;>92.5→10.0`。

- 投影由服务端在 create/patch/batch 写路径统一计算,客户端传的
  `intensity_mode`/`target_value` 在带 `load_mode` 的请求里**忽略**(以新体系为准),
  不带 `load_mode` 的旧请求走现状逻辑,完全不变。
- patch 改动新体系任一字段 → 服务端读现值合并出最终态,重算投影,整组校验
  (防孤儿值:换模式必须清旧模式值列,app 层直接替调用方清,不 422 刁难)。

## 5. API

### 5.1 Schema(`src/routes/plans/schemas.ts`)

- `PlanSetBodySchema` 增加:`load_mode`(六值枚举,可空)、`target_pct`、`target_rpe`、
  `rir_target`、`rpe_low`、`rpe_high`、`weight_low`、`weight_high`、`target_weight`
  (数值字符串,同 `TargetValueSchema` 处理管线)。
- `validateSetBody` 按 §3.2 矩阵校验:模式与值列配套(缺值/串列 → 422)、值域与
  0.5 步进 → 422、`fixed_weight` 无重量 → 422、`weight_range` 带重量 → 422、
  完成判定(强度与重量至少其一)→ 422。
- `PatchPlanSetBodySchema` 沿用同一 superRefine,按 §4 合并语义校验最终态。
- Batch 端点(spec 009)`BatchExerciseSchema.sets` 复用 `CreatePlanSetBodySchema`,
  字段自动生效;补 batch 路径写入与回读测试。

### 5.2 序列化与读取

- `PlanSetResponse` 增加上述九个字段(`serialization.ts` + `src/db/types.ts` 手工
  增补,遵守 no-ORM 纪律);`intensity_mode`/`target_value` 照旧输出(投影值),
  老客户端零感知。
- 读侧 coalesce:`load_mode` 为 NULL 且 `intensity_mode='weight'` 的存量行,
  `target_weight` 输出 `target_value` 同值(新客户端统一读新字段,无需回填)。
- 学员端读取计划的所有出口(`GET /plans/...`、学员今日训练等凡带 sets 的响应)统一带出。

## 6. 兼容性

- 迁移 additive + 类型安全放宽(SMALLINT→NUMERIC),不动既有约束语义;
  `load_mode` CHECK 收紧时 0033 后该列从未被写入(API 未接线),无存量冲突。
- 老 iOS 与线上 plan-web 只见投影后的合法旧值,照常工作;新形态组在老端降级显示,
  内测期可接受,无需 env gate;backend 可独立部署。
- 下游口径:tonnage/容量统计沿用投影后 `intensity_mode='weight'` 的 `target_value`,
  双锚组自然计入;e1RM 走实测 set_logs,与处方无关;算法引擎读者对新列免疫。

## 7. 三端分工(本 spec 只实装 W1)

- **W1 backend(本仓)**:迁移 + 投影 + schema 校验 + 序列化 + 测试。合并后必须部署
  staging 并记账 `db/MIGRATIONS-APPLIED.md`。
- **W2 plan-web(另卡,依赖 W1 部署)**:强度列六选一类型选择器 + 重量列
  一格/逐组标重切换;完成判定与发布门禁(inputGuard)按 §2;自重动作保留行级切换。
- **W3 iOS(另起 spec,随后续班车)**:学员端计划展示六形态 +「Xkg @9」双锚 +
  打卡目标提示。

## 8. 验收标准

1. 迁移在干净库与含存量数据库上均可应用;存量行新列全 NULL,`rpe_low/high` 类型
   放宽后存量值(若有)无损。
2. vitest + supertest 覆盖:
   - 六种 load_mode × 有/无 target_weight 的合法组合写入 → 回读新字段 + 投影字段全对
     (含 rir→rpe 换算、pct 分段映射、区间取下限各投影分支);
   - 矩阵违规(模式缺配套值、串列残值、fixed_weight 无重量、weight_range 带重量、
     两维全空)→ 422(create、patch 合并态、batch 三路径);
   - 值域/步进违规(pct 19.9/110.5/72.3、rpe 0.4/10.5、rir −1/10、区间 low≥high)→ 422;
   - 不带 load_mode 的旧形态请求完全不受影响(回归)。
3. `GET` 计划树响应新字段齐全,老字段 shape 与取值不变(快照回归)。
4. lint/build/test 全绿;PR 开向 `staging`,合并后部署并记账。
