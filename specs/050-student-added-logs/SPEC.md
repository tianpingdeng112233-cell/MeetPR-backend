# 050 — 学员自加记录(额外组 + 自加动作)backend 侧

- **状态**: InProgress
- **来源**: David 2026-10-13 提出学员端两项新功能「训练日可自主切换并开始,不必严格按顺序」「自己可以加动作和组数」,同日 /grill 两轮(答复「1A 2B 3A 4A 5A」「7A 8A 9A」,Q6 按推荐 A),对共识复述回「确认」。
- **产品正典**: `meetpr-rn` 仓 `specs/092-flexible-day-self-added/SPEC.md`(安卓为标准,iOS 原生随后跟)。本 spec 只定 wire 契约与数据模型。
- **级别 / 节奏**: T2 / P1。分支 `feat/050-student-added-logs` → `staging`,迁移 `0074`(开工现场复核占号:staging 头 0072,open PR #289 占 0071、#294 占 0073)。

## 问题

1. 学员临时多做一组(主项补一组、退让组)或加练一个计划外动作,现在没有地方记;计划外记录(spec 010 的 adhoc 行)虽然能存,但不属于任何训练日,教练端也读不到。
2. 学员不按顺序练(本周先练 D4 再练 D2)——后端本来就不拦(记录与结算都没有顺序门),本 spec 只补回归测试把这一点钉住。

## 术语(已写入 `CONTEXT.md`)

- **额外组**:教练排的某个动作下,学员在处方组之外多做的组。是挂在该计划动作上的普通记录,组序号 ≥ 该动作的处方组数。
- **自加动作**:学员在某个训练日里自己从动作库加练的、计划里没有的动作。只属于那一次训练,不进计划树。
- 两者合称**学员自加记录**。

## 数据模型(迁移 `0074`)

`set_logs` 只加一列,其余不动:

| 变更 | 内容 | 动机 |
| --- | --- | --- |
| 新增列 | `plan_day_id UUID NULL REFERENCES plan_days(id) ON DELETE SET NULL` | 自加动作的行归属哪个训练日。只有自加动作行非空 |
| 新增约束 | `CHECK (plan_day_id IS NULL OR adhoc)` | 计划内行的训练日永远经 `plan_exercise_id` 推导,不允许两处真源 |
| 新增索引 | `(plan_day_id) WHERE plan_day_id IS NOT NULL` | 教练按训练日读取 |

- 额外组**不需要任何模型变更**:就是 `plan_exercise_id` 非空、`set_index` ≥ 处方组数的普通行(现行唯一约束 `(student_id, plan_exercise_id, set_index)` 与 `set_index` 无上限已经支持)。
- 自加动作行 = `adhoc = true` + `plan_exercise_id IS NULL` + `plan_day_id` 非空。现行 adhoc 唯一索引 `(student_id, exercise_id, logged_date, set_index) WHERE adhoc` **原样保留**,不新增第二个唯一索引(训练日被删时 `SET NULL` 不能因为撞键而失败)。
- **存量照护**:纯增量。存量行 `plan_day_id` 全部为 NULL,含义是「不属于任何训练日」——对存量 adhoc 行(全部来自自己练)与计划内行都为真,不需要回填。教练删除/重建训练日时自加动作行脱钩但保留(与 0031 对 `plan_exercise_id` 的做法一致),继续参与历史与 e1RM。
- 回滚段写在迁移文件尾注释:DROP 索引 / 约束 / 列(仅 staging 演练;回滚会丢掉训练日归属,不丢记录本身)。

## 接口

### 1. `POST /sets/log` adhoc 形态追加可选 `plan_day_id`

```json
{
  "exercise_id": "…",
  "plan_day_id": "…",
  "logged_date": "2026-10-13",
  "set_index": 0,
  "weight_kg": 60,
  "reps": 10,
  "completed": true
}
```

- 校验:`plan_day_id` 必须属于「`trainee_id` = 本人且 `status = 'published'`」的计划,否则 400 `SETS_PLAN_DAY_NOT_PUBLISHED`。不校验该日是否已结算、是否本周(与计划内记录一致,顺序与范围由客户端管)。
- 幂等键不变:`(student, exercise, logged_date, set_index)`。命中的既有行 `plan_day_id` 与请求不一致(含一方为空)→ 409 `SETS_ADHOC_DAY_CONFLICT`,**不写入**(同一天同一动作只能自加在一个训练日里,不静默搬家)。
- 不带 `plan_day_id` 的 adhoc 请求、coached 形态请求:行为与响应逐字节不变。
- PR 判定、e1RM、历史聚合:沿用 adhoc 行现有路径,不新增分支。

### 2. `DELETE /sets/:id`(新增)

学员删除自己的一条**学员自加记录**(记错了、加多了)。

- 角色:`coached_student` / `self_train_student`;只能删本人的行,查无或非本人 → 404 `SET_NOT_FOUND`。
- 可删判定(否则 409 `SET_NOT_STUDENT_ADDED`):自加动作行(`adhoc` 且 `plan_day_id` 非空),或额外组(`plan_exercise_id` 非空且 `set_index` ≥ 该计划动作当前的处方组数)。处方内的组、导入的 assumed 行、自己练的纯 adhoc 行不在本接口范围。
- 该行有视频附件(`attachments.set_log_id`)或被聊天的组卡片引用 → 409 `SET_HAS_ATTACHMENT`,不删(客户端提示先处理视频)。
- 该行触发过的 PR 等派生记录:与现有「取消这一组」(把行写回 `completed: false`)对同类派生记录的处理保持一致——实装前先查清现状并写进 JOURNAL;若现状是不清理,删除也不额外清理,但不得留下指向已删行的悬挂外键。
- 成功 204;重复删除 404。

### 3. `GET /sets` 教练读取追加 `scope`

- 教练调用新增可选 `scope=plan|all`,**缺省 `plan`,响应与现状逐字节一致**(已发布的 iOS 教练包把 `plan_exercise_id` 当非空解码,不能让它们收到 adhoc 行)。
- `scope=all` 在现有结果上并入该学员的自加动作行:`adhoc` 且 `plan_day_id` 所属计划满足与现有查询相同的条件(`coach_id` = 本人、`trainee_id` = 该学员、`status = 'published'`)。自己练的纯 adhoc 行(`plan_day_id` 为空)不给教练。
- 学员与教练两条读取路径的响应体都追加 `plan_day_id: string | null`(列值原样;计划内行为 null,训练日由 `plan_exercise_id` 推导)。

## 既有口径的修正

- **`sessionProgress` 只数处方内的组**:现行实现按「该计划动作下已提交行数 ≥ 处方组数」判完成,额外组会顶替没做的处方组(处方 3 组,做了第 1、2 组加 1 个额外组 → 被判完成)。改为只统计 `set_index` < 处方组数的行。这是唯一口径,活动台账等调用方一并受益,不得另起第二份。
- **顺序无关**:不改代码,补测试钉住——同一计划内先记录并结算靠后的训练日、再记录并结算靠前的训练日,两次都成功;撤销仍只允许最新一条完成记录;游标(最早未完成日)在整个过程中符合 spec 035 的定义。
- 其余读取处方与实际对照的接口(统计、追踪看板、摘要)遇到 `set_index` ≥ 处方组数的行不得报错或错位;逐个核对并在 JOURNAL 列出核对结论。

## 兼容性

- 老客户端不发新字段、不调新接口,行为不变。
- 老客户端会在计划内读取里看到额外组行(`set_index` 超出处方)——这类行今天就可能存在(接口从未设上限),不属于新增暴露面;验收时在 iOS 1.0(23) 教练 / 学员 demo 上各看一眼含额外组的训练日不崩。

## 验收清单

1. 迁移在空库与带存量的库上都能应用;存量行 `plan_day_id` 全 NULL;删除一个带自加动作行的训练日后,该行保留且 `plan_day_id` 变 NULL。
2. 带 `plan_day_id` 的 adhoc 写入:本人已发布计划的训练日 → 成功且读回带该 id;他人 / 草稿计划的训练日 → 400;同键不同训练日 → 409 且原行不变。
3. 不带 `plan_day_id` 的 adhoc 与 coached 写入:既有测试断言一条不改而通过。
4. 删除:额外组与自加动作行可删;处方内的组 409;他人的行 404;带视频的行 409 且行与附件都还在。
5. 教练 `GET /sets`:缺省与 `scope=plan` 的响应与改动前逐字节一致(只多 `plan_day_id` 字段);`scope=all` 多出自加动作行,且拿不到其他教练的学员、自己练的纯 adhoc 行。
6. 额外组不顶替处方组:处方 3 组、提交第 1、2 组加 1 个额外组 → `plannedComplete` 为 false。
7. 乱序结算与撤销的三步用例通过。
8. `pnpm`/`npm` 全量测试、类型检查、lint、format 全绿。

## 测试 seam

1. **路由层**(现有 `sets` 路由测试的 seam,最高层,主力):写入 / 删除 / 教练读取的全部验收项。
2. **`sessionProgress` 单元测试**(现有 seam):第 6 项。
3. **计划日完成路由测试**(现有 seam):第 7 项。
4. **迁移测试**(沿用现有迁移测试方式):第 1 项。

不新增 seam。

## Out of Scope

- 学员改 / 删教练处方内的组或动作;把自加动作写进计划树。
- 手打库外动作名。
- 自加动作的视频(附件链路、教练收片流程)。
- 给教练的任何通知 / 推送。
- 服务端限制「只能本周内换天」「已结算的天不能再加」——由客户端管。
- 教练网页与两端 app 的界面(各仓自己的 spec / 卡)。
- 部署:合并后按「backend 严禁只合不部署」由 Opus 走 staging 部署,prod 迁移照旧门禁。
