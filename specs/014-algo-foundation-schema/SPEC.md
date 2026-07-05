# SPEC 014 — 算法计划引擎数据地基

- **状态**: Draft
- **来源**: 算法计划引擎蓝图 W0 wave(数据模型地基)。Brain wiki: [[W0-spec-draft]]。

---

## 背景

算法计划引擎需要存储 JTS Powerlifting 2.0 与 multi-system 周期化所需的全部数据——块类型、中周期相位、训练最大值(TM)、RPE/RIR 处方参数、动作变式与疲劳分级、学员能力模型、容量边界、波浪模板网格等。现有 schema(plans/plan_sets/set_logs/exercises/readiness_checkins 五张表)只有「计划名称+日程+组数重量次数」骨架,缺所有引擎字段。

W0 范围 = 纯 additive 数据地基:第一批全 nullable 老表加列(42 列)+ 第二批新独立表(4 张)+ 唯一真 gate(TM 计算 + 6 周时效)。不实现任何引擎逻辑(生成/调整全在 W1+),只保证「建表→写→读→展示」链路通。iOS 端只读标签(block_type/mesocycle_phase/training_max)与 plan-web 只读标签由 iOS spec 052 覆盖,本 SPEC 聚焦 backend 数据层。

---

## 改动

### 2.1 新枚举(5 个 + 1 处加值)

| 枚举 | 值集 | 挂载位置 | 语义注记 |
|---|---|---|---|
| `method_anchor` | {linear_load, tm_pct, e1rm_rpe, double_progression} | athlete_lift_state / plan_sets | 负荷锚点(per-lift 语义,「下一组重量怎么算」的语言) |
| `dev_stage` | {novice, intermediate, advanced} | athlete_lift_state | per-lift 训练水平;multi-system 别名 beginner 映射到 novice |
| `block_type` | {hypertrophy, strength, peaking, active_rest} | plans | 训练块类型(JTS SPST 四块分类) |
| `mesocycle_phase` | {accumulation, intensification, realization, deload} | plans / wave_templates | 中周期相位(JTS 2.0 四相位) |
| `e1rm_confidence` | {normal, low} | set_logs | e1RM 置信度分级(对齐 spec 050 既有实现命名) |
| (加值)`deadlift_style` | 现有 {conventional, sumo} + **both** | student_onboarding_profiles / athlete_lift_state | 枚举只加值不改删;both = 两种硬拉姿态兼修 |

### 2.2 第一批 · 老表 nullable 加列(42 列,零依赖)

**撞名处理六项现场事实**:
1. 真实表名是 **`plans`**(不是 training_plans)
2. `set_logs.rpe` 已存在,不建 `actual_rpe`
3. `readiness_checkins` 表已存在(migration 0014),只加 motivation/energy 两列
4. `exercises.equipment`(9 值枚举)与新 `required_equipment`(23-token 词表)并存,不合并
5. `exercise_tier`{variation, supplementary, accessory} vs 现有 `exercise_type`{main_lift, main_lift_variation, accessory} 两列并存,列注释写清区别,禁顺手合并
6. `deadlift_style` 加值 `both`(枚举只加不改删)

#### `plans` 表(+4 列)

| 列 | 类型 | nullable | 出处 | 注记 |
|---|---|---|---|---|
| `block_type` | ENUM block_type | 是 | [[04-data-model-increments]] §3.2 | 训练块类型 |
| `mesocycle_phase` | ENUM mesocycle_phase | 是 | §3.2 | 中周期相位 |
| `training_max` | NUMERIC | 是 | §3.2 | TM = 0.9×1RM,处方锚点(真 gate,见 §3) |
| `tm_set_at` | TIMESTAMP | 是 | §3.2 | TM 设定时刻(真 gate 时效字段,6 周过期) |

#### `plan_sets` 表(+16 列)

全 nullable,出处 [[04-data-model-increments]] §3.3。列注释注明:
- `rep_standard`:本波 bracket 10/8/5/3,不是全部 5(jts-rp-primary:282)
- `load_mode`:现有 `intensity_mode`{weight, rpe} 的扩展,两列并存,合并与否留 W2 定
- `intra_set_rest`:cluster 组内短歇,与现有 `rest_seconds`(组间休息)不同

| 列 | 类型 | 出处 |
|---|---|---|
| `method_anchor` | ENUM method_anchor | §3.3 |
| `effort_method` | ENUM{max, dynamic, repetition} | §3.3 |
| `rpe_low` | SMALLINT | §3.3 |
| `rpe_high` | SMALLINT | §3.3 |
| `fatigue_pct_target` | NUMERIC | §3.3 |
| `accommodating_tension` | BOOLEAN | §3.3 |
| `linear_increment` | NUMERIC | §3.3 |
| `amrap_cap` | SMALLINT | §3.3 |
| `backoff_pct` | NUMERIC | §3.3 |
| `rir_target` | SMALLINT | §3.3 |
| `rep_standard` | SMALLINT | §3.3 |
| `set_scheme_hint` | JSON | §3.3 |
| `volume_is_cap` | BOOLEAN | §3.3 |
| `pct_of_tm` | NUMERIC | §3.3 |
| `intra_set_rest` | SMALLINT | §3.3 |
| `load_mode` | TEXT | §3.3 |

#### `set_logs` 表(+4 列)

全 nullable,出处 §3.4。**不建** `actual_rpe`(现有 `rpe` 即是)。`e1rm_confidence` W0 只建列不实现分级门写入逻辑(生成点设防属 W1+,spec 050 现有实现继续在 iOS 侧运作)。

| 列 | 类型 | 出处 |
|---|---|---|
| `actual_rir` | SMALLINT | §3.4 |
| `accommodating_tension` | BOOLEAN | §3.4 |
| `e1rm_confidence` | ENUM e1rm_confidence | §3.4 |
| `mean_velocity` | NUMERIC | §3.4 |

#### `exercises` 表(+16 列)

全 nullable,出处 §3.5。`required_equipment` 是 TEXT[] 23-token 词表,与现有 `equipment`(9 值枚举数组)不同词表,两列并存不合并。`exercise_tier`(JTS 三级辅助角色) vs 现有 `exercise_type`(动作身份)语义相邻但不同,两列并存,列注释写清。W0 只建列不做数据回填(回填是 C-1 支线)。

| 列 | 类型 | 出处 | 注记 |
|---|---|---|---|
| `base_exercise_id` | BIGINT FK | §3.5 | 自引用外键,指向本表 id |
| `stance` | TEXT | §3.5 | |
| `grip` | TEXT | §3.5 | |
| `bar_position` | TEXT | §3.5 | |
| `pause` | BOOLEAN | §3.5 | |
| `tempo` | TEXT | §3.5 | |
| `sticking_point_target` | TEXT | §3.5 | 卡点桶(列级值集) |
| `variation_key` | TEXT | §3.5 | 复合变式键 |
| `pause_duration` | NUMERIC | §3.5 | |
| `deficit_height` | NUMERIC | §3.5 | |
| `block_height` | NUMERIC | §3.5 | |
| `rom_modifier` | TEXT | §3.5 | |
| `exercise_tier` | TEXT | §3.5 | JTS 三级{variation, supplementary, accessory},与现有 exercise_type 并存 |
| `fatigue_tier` | TEXT | §3.5 | |
| `overload_modality` | TEXT | §3.5 | |
| `required_equipment` | TEXT[] | §3.5 | 23-token gym-tier 词表,与现有 equipment(9 值)并存不合并 |

#### `readiness_checkins` 表(+2 列)

表已存在(migration 0014),只加两列。出处 §3.6。字段映射:sleep → 现有 `sleep_quality`、soreness → 现有 `muscle_fatigue`(per-muscle JSONB,标量 soreness 不另建,W3 消费时再定合成口径)。

| 列 | 类型 | nullable | 出处 |
|---|---|---|---|
| `motivation` | SMALLINT | 是 | §3.6 |
| `energy` | SMALLINT | 是 | §3.6 |

### 2.3 第二批 · 新独立表(4 张,依赖第一批枚举)

字段定义逐字段引用 [[04-data-model-increments]] §3.1 / §3.6,此处列结构决策。

#### `athlete_lift_state` 表

主键:(student_id, lift_family) 组合唯一。出处 §3.1。W0 无写入方(判定算法在 W1),允许教练/后台手工置值供只读标签联调。

| 列 | 类型 | nullable | 默认 |
|---|---|---|---|
| student_id | BIGINT FK | 否 | |
| lift_family | ENUM{squat, bench, deadlift} | 否 | |
| dev_stage | ENUM dev_stage | 是 | |
| method_anchor | ENUM method_anchor | 是 | |
| seed_perf | JSON | 是 | |
| sticking_point_target | TEXT | 是 | |
| deadlift_stance | ENUM deadlift_style | 是 | both |

#### `wave_templates` 表

主键:(wave_name, phase) 组合唯一(静态种子表)。出处 §4.3。W0 建骨架表,列注释带网格常量(10s→10/20、8s→8/18、5s→5/15、3s→3/13),**种子数据灌入留 W2**。

| 列 | 类型 | nullable | 注记 |
|---|---|---|---|
| wave_name | TEXT{10s, 8s, 5s, 3s} | 否 | |
| phase | ENUM mesocycle_phase | 否 | |
| set_count | SMALLINT | 否 | |
| reps | SMALLINT | 否 | |
| pct_of_tm | NUMERIC | 否 | |
| amrap_cap | SMALLINT | 是 | 仅 realization 顶组 |
| rep_standard | SMALLINT | 是 | 仅 realization 顶组,bracket 值{10,8,5,3} |

#### `athlete_capacity_profiles` 表

主键:(student_id, lift_family) 组合唯一。出处 §3.6。W0 无写入方(容量层 W2/W4)。

| 列 | 类型 | nullable |
|---|---|---|
| student_id | BIGINT FK | 否 |
| lift_family | ENUM{squat, bench, deadlift} | 否 |
| mev | SMALLINT | 是 |
| mav | SMALLINT | 是 |
| mrv | SMALLINT | 是 |
| phase_scale | JSON | 是 |

#### `variation_logs` 表

主键:(student_id, variation_key) 组合唯一。出处 §3.5。W0 无写入方(冷却校验 W5)。

| 列 | 类型 | nullable |
|---|---|---|
| student_id | BIGINT FK | 否 |
| variation_key | TEXT | 否 |
| last_used_week | DATE | 是 |
| best_e1rm | NUMERIC | 是 |

### 2.4 服务端真 gate:training_max 计算 + 6 周时效

「真 gate / 服务端权威」= 该数值必须由服务端计算与校验,客户端只展示结果,不 trust client。对齐 spec 028 e1RM 锁定模式。

| 规则 | 口径 | 出处 |
|---|---|---|
| TM 计算 | `TM = ceil(0.9 × 近期真 1RM, 2.5kg)`(向上取整到 2.5kg) | [[04-data-model-increments]] §4.2(JM2.0 p.15-16 / jts-rp-primary:432) |
| TM 时效 | `tm_set_at` 起 **6 周**;超期视为过期,任何 %TM 处方计算(W2+)必须拒用并要求复测 | §4.2(JM2.0 p.16) |
| 存储纪律 | TM 与「锁定 1RM」分开存(TM 是处方锚,1RM 是能力记录) | §4.2 |
| 信任边界 | 计算在 backend;iOS/plan-web 传入的只有 1RM 原料,**不接受客户端传 TM 值**;响应里的 training_max 只读 | CHARTER §3 真 gate 清单 |

W0 交付 = 该纯函数(输入 1RM → 输出 TM)+ 写入 `plans.training_max/tm_set_at` 的服务端路径 + 时效判定函数(供 W2 消费,W0 先以单元测试锁口径)。

### 2.5 API 面(最小暴露)

- 现有 plan 详情响应(coach 端 + student 端 + plan-web)附带四个新字段 `block_type/mesocycle_phase/training_max/tm_set_at`(NULL 时字段可省略或为 null,响应 schema 向后兼容)。
- **TM 写入口**:唯一允许的写路径是「服务端从 1RM 输入计算」;**不开放 client 直写 training_max 的 API**。
- 其余新列/新表 W0 **不开放**写 API(无引擎消费方);读路径按需最小暴露(只读标签所需即可)。

---

## 非目标

- **不含** `adjustment_events` 表与全部 21 个 reason_code(随 W1+ 引擎走,依赖真 gate 引擎实装)。
- **不实现任何引擎逻辑**:计划生成、四回路调整、WM 重置、Fatigue%、L4 升段(全在 W1-W4)。
- **wave_templates 种子数据灌入留 W2**(W0 只建骨架表,表空着是预期)。
- **iOS 镜像字段与三只读标签不在本 SPEC**(由 iOS spec 052 覆盖)。
- **plan-web 只读标签不在本 SPEC**(由 iOS spec 052 一并覆盖)。
- **不改 onboarding 问卷**。
- **Free 档不读引擎字段**(纯记录路径零改动)。

---

## 测试

1. **老数据 NULL 回归**:存量 plan/plan_sets/set_logs/exercises 行读出新列全为 NULL,现有 API 响应结构不破坏(新增字段可空),iOS 老版本 App 对新响应可正常解码(新字段对老 client 不可见/被忽略)。测试证据:回归测试套件输出 + 一条人工构造老数据读取验证。

2. **TM 计算单测**:锁定公式 `ceil(0.9×, 2.5)` + 6 周时效边界(tm_set_at + 42 天 vs 当前时刻)。测试证据:单元测试输出覆盖边界 case(1RM=100kg → TM=90kg、1RM=102.5kg → TM=92.5kg、超期/未超期判定)。

3. **伪造 TM 负向测试**:构造「客户端伪造 TM」请求被拒/被忽略。测试证据:integration test 输出显示伪造 TM 请求返回 400/被服务端重算覆盖。

4. **Free 账号全链路一致**:Free 档(纯记录)代码路径不读任何引擎字段(dev_stage/method_anchor/training_max/…);solo 随手记(spec 045 链路)不受影响。测试证据:Free 账号全链路走查(随手记→历史→成长曲线)逐屏截图对比 W0 前后一致,或自动化测试输出显示 Free 路径零调用新列。

---

## 迁移排序

**migration 取号纪律**:SPEC 不写死 migration 号,实施时现场核实 staging 头 + open PR 占号,取下一个空号(预计 ≥0033)。历史教训:analytics 0019/0020、catalog 0023-0028、selftrain in-flight 0032 均发生过号争用。

| 批次 | 内容 | 依赖 |
|---|---|---|
| 第一批(可并行,建议合成 1-2 个迁移文件) | `plans` +4 列;`plan_sets` +16 列;`set_logs` +4 列;`exercises` +16 列;`readiness_checkins` +2 列;`deadlift_style` 枚举加值 both | 零依赖(全 nullable 加列) |
| 第二批 | `wave_templates` / `athlete_lift_state` / `athlete_capacity_profiles` / `variation_logs` 建表 | 依赖第一批定义的 `dev_stage`/`method_anchor`/`mesocycle_phase` 枚举值集 |

同步动作:每个迁移落地后按仓规手工增补 `src/db/types.ts` 的 Database 接口(No-ORM 纪律,接口手写对齐迁移)。
