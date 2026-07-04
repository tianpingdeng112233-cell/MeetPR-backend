# 010 — ad-hoc set logging(自己练 Free 档地基):`set_logs` 松绑 + `POST /sets/log` 双形态

- **状态**: Draft
- **来源**: 学员端「自己练」Free 档商业化 wave(设计权威:`~/Brain/wiki/projects/MeetPR/self-train-free-tier-wave.md`,David 2026-07-04 四拍板)。solo 学员(`self_train_student`)注册后无事可做:整条记录链路在数据模型层就要求"挂在已发布计划的某个动作上"(`set_logs.plan_exercise_id NOT NULL` + `canLogSet` 校验),"我今天深蹲了 5 组"这句话存不进去。iOS 侧对应 spec 045(solo 随手记核心链路,iOS repo)。
- **批准语境**: David 拍板 Free 档记录形态 = 「随手记 + 轻结构」(从动作库挑动作直接记,无"计划"概念);本 spec 只做 backend 地基,iOS UI 归 045。

> ⚠️ **顺手拆雷(数据留存)**:spec 009 的警示框已记录——`set_logs.plan_exercise_id` 现为 `ON DELETE CASCADE`(0005),教练删计划/reconcile 重建"变化的天"时,学员在旧 `plan_exercise` 行上的**全部训练记录被连坐删除**。这与 Free 档"数据永留存、永不锁数据"的产品承诺直接冲突。本迁移把该 FK 改为 **`ON DELETE SET NULL`**(先例:`feedback.plan_exercise_id` 自 0006 起即 SET NULL):记录脱离计划槽位但**永久保留**,靠新增的 `exercise_id` 直接列继续参与 e1RM/历史/成长聚合。
>
> 已知取舍:计划槽位重建后,旧记录不再挂回新槽位(计划完成度视图看不到它们,但历史/成长视图完整)。**重挂 heuristic(同学员+同动作+同日 → 新槽位)是 follow-up,不在本 spec**——现状(直接删光)比"保留但脱钩"更糟,先止血。

## 范围

一次 migration + `/sets/log` 路由双形态 + fetch 响应加列。**一个 PR,base `staging`**。不动:限流、角色系统、教练端消费(教练看 adhoc/孤儿行归教练 wave)、iOS(spec 045)。

### 1. Migration `0031-adhoc-set-logs.sql`

> 编号按 2026-07-04 现场核实:staging 头 0028,open PR #38 占 0029/0030(占号规则 = staging 头 + open PR,空号可容忍、撞号不可)。**合并当刻仅需复核没有新 PR 占走 0031**;#38 合并与否不影响本号。

`set_logs` 表变更:

| 变更     | 内容                                                                                      | 动机                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 新增列   | `exercise_id UUID NOT NULL REFERENCES exercises(id)`(回填自 `plan_exercises.exercise_id`) | 每行自带动作身份,聚合(e1RM/历史/教练分析 per-lift 归因)不再必须 join 计划链                                                          |
| 新增列   | `logged_date DATE NOT NULL`(历史行回填 `(logged_at + INTERVAL '8 hours')::date`)          | 客户端本地训练日(adhoc 行的会话锚 + 唯一键组成);回填用固定 +8:Asia/Shanghai 自 1991 无 DST,数学等价且 pg-mem 可跑;现网用户全部在国内 |
| 新增列   | `adhoc BOOLEAN NOT NULL DEFAULT FALSE`                                                    | 区分"生而随手记"(true)与"计划记录/计划孤儿"(false);孤儿不进 adhoc 唯一索引,天然避免撞键                                              |
| 改约束   | `plan_exercise_id` DROP NOT NULL;FK 改 `ON DELETE SET NULL`                               | 见警示框                                                                                                                             |
| 新增约束 | `CHECK (NOT adhoc OR plan_exercise_id IS NULL)`                                           | adhoc 行永不挂计划                                                                                                                   |
| 新增索引 | partial unique `(student_id, exercise_id, logged_date, set_index) WHERE adhoc`            | adhoc 幂等 upsert 的冲突目标                                                                                                         |
| 新增索引 | `(student_id, exercise_id, logged_at DESC)`                                               | 按动作直取历史(成长页/「重复上次」)                                                                                                  |

既有唯一约束 `(student_id, plan_exercise_id, set_index)` 不动(coached 行为不变;plan_exercise_id 为 NULL 的行天然豁免)。

**回滚段**(写在迁移文件尾注释):逆序 DROP 索引/约束/列 + FK 恢复 CASCADE;注意回滚会恢复数据丢失语义,仅供 staging 演练。

### 2. `POST /sets/log` 双形态 body(strict union,二选一)

角色门不变:`requireRole('coached_student', 'self_train_student')`——**两种角色都可以 adhoc 记录**(有教练学员练计划外附加动作是真实力量举行为;iOS 本 wave 只给 solo 露入口)。

coached 形态(向后兼容,老 iOS build 不带 `logged_date` 照常工作):

```json
{
  "plan_exercise_id": "50000000-0000-4000-8000-000000000001",
  "logged_date": "2026-07-04",
  "set_index": 1,
  "weight_kg": 100,
  "reps": 5,
  "rpe": 8,
  "completed": true,
  "failed": false
}
```

- `logged_date` 可选;缺省时服务端按 Asia/Shanghai 当日填。
- 校验链不变:`resolvePlanExercise`(原 `canLogSet` 改造,额外返回 `exercise_id` 供插入)→ 查无 → 400 `SETS_PLAN_EXERCISE_NOT_PUBLISHED`。
- upsert 冲突目标不变 `(student_id, plan_exercise_id, set_index)`;`doUpdateSet` 新增同步 `logged_date`。

adhoc 形态(新):

```json
{
  "exercise_id": "20000000-0000-4000-8000-000000000001",
  "logged_date": "2026-07-04",
  "set_index": 0,
  "weight_kg": 140,
  "reps": 5,
  "rpe": 8.5,
  "completed": true
}
```

- `exercise_id` + `logged_date` 必填;body 出现 `plan_exercise_id` → 400(strict union 拒绝)。
- `exercise_id` 不存在 → 400 `{ "error": "SETS_EXERCISE_NOT_FOUND" }`(新错误码)。
- 落库:`plan_exercise_id = NULL, adhoc = TRUE`;冲突目标 = partial unique 索引,`DO UPDATE` 同 coached(weight/reps/rpe/completed/failed/logged_at)。
- 幂等:同 `(student, exercise, logged_date, set_index)` 重复提交 = 更新既有行,不产生新行。

响应(两形态一致,201):`{ "id": "…", "logged_at": "…ISO…" }`(现状不变)。

### 3. `GET /students/:id/sets`:响应加列 + `scope` 参数

`SetLogResponse` 新增 `exercise_id`(string)、`logged_date`(YYYY-MM-DD string,DATE-as-text 规则)、`adhoc`(boolean);`plan_exercise_id` 类型放宽为 `string | null`。

**为什么必须有 `scope`(不能纯加列)**:已发布 iOS build 的 `SetLogDTO.planExerciseID` 是**非可选 UUID**——任何 `plan_exercise_id: null` 的行(adhoc 或计划删除后的孤儿)都会让老客户端整个 logs 数组解码失败、历史页变白。因此:

- **`scope=plan`(缺省)**:逐字节复刻 0031 前的可见集——仅计划挂接行、按 `logged_at` 开窗。老客户端不发 scope → 永远拿不到 null 行,零感知。
- **`scope=all`**(spec 045+ 新客户端):计划行 + adhoc + 孤儿行全量,**按 `logged_date` 开窗**(训练日语义)——离线队列晚补传的组落在"练的那天"而不是"上传那天"。排序 `logged_date DESC, logged_at DESC`。

own fetch 双 scope;`fetchCoachSetLogs` 查询语义不变(inner join 天然只见计划行;教练消费 adhoc/孤儿行归教练 wave)。

**coached 冲突时 `logged_date` 的更新规则**:仅当客户端 body 显式带 `logged_date` 才随冲突更新;老客户端(不带)编辑历史组时,服务端"今天"**不得**把历史组拖到当天。

## 兼容性矩阵

| 客户端                                      | 新 backend 行为                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 老 iOS build(coached,body 无 `logged_date`) | 服务端补日期,201 不变;冲突编辑不改历史行的 `logged_date`                                                      |
| 老 iOS build(读 sets,不带 scope)            | `scope=plan` 缺省 = 0031 前可见集逐字节复刻(null 行不出现,躲开非可选 UUID 解码炸弹);新增三字段被 Codable 忽略 |
| 新 iOS(spec 045,adhoc + `scope=all`)        | 全新路径;按训练日(`logged_date`)开窗                                                                          |
| plan-web reconcile 删重建天                 | 学员记录不再被连坐删除(SET NULL);计划完成度视图对旧槽位记录脱钩(已知取舍,见警示框)                            |

## 测试

- `tests/migrations/0031-adhoc-set-logs.test.ts`:列存在与 NOT NULL/回填正确性(coached 行 exercise_id = 槽位动作)/删 plan 后行存活且 plan_exercise_id NULL/adhoc 唯一性冲突/孤儿行不撞 adhoc 索引。pg-mem 不支持的语句以探针结论为准显式跳过并注释(prod 语义以 staging 演练兜底)。
- `tests/sets-log.test.ts` 新增:adhoc 幂等 upsert/coached 无 logged_date 兼容/删 plan 后行可读/adhoc 带 plan_exercise_id 拒 400/`SETS_EXERCISE_NOT_FOUND`/coached 冲突更新 logged_date。
- `tests/sets-fetch.test.ts` 新增:own fetch 三新列;coach fetch 回归(不见 adhoc 行)。
- 门禁:全量 vitest 相对基线零新增失败(基线自带 1 例上游顺序 flake,单跑绿,已另卡)+ `tsc --noEmit` + eslint。

## 验收

1. solo 学员(staging 账号)`POST /sets/log` adhoc 形态 201,重复提交同键更新不重复。
2. coached 学员老 body 回归 201;`GET /students/:id/sets` 含新列。
3. staging 演练:对含记录的测试计划执行"删除计划"→ `set_logs` 行保留、`plan_exercise_id` 全 NULL、成长/历史聚合仍取得到(按 exercise_id)。
4. 迁移在 staging 干净应用;`information_schema` 核对 FK 行为 = SET NULL、partial index 存在。
