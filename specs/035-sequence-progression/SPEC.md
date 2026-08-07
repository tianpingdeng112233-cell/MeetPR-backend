# spec 035 — 训练日推进制(sequence progression)backend 侧

- **状态**:InProgress(David 2026-08-07 拍板换制,五项拍板见 §拍板记录;同日拍板「边实装边终审」授权开工,spec PR #196 终审进行中,终审改动按 diff 返修实装)
- **对应 iOS spec**:`071-sequence-progression`(同一 wave;本 spec 定义 wire 契约,071 消费)
- **取代**:`026-catch-up-shift`(spec PR #104 已作废关闭)——推进制下「漏课」概念不存在,补练 patch 链整体取消。

## 问题(为什么做)

学员训练日受现实干扰(加班/伤病/出差)频繁提前或延后,日期锚定制(训练日 = start_date +
位置序数投影出的具体日历日)导致一串 patch 链:顺延 V1 → 整体顺延 V2(0037/0038)→
补练/事后顺延(026,未实装)。每个 patch 都在对抗同一个根因:**「某天该练什么」不该由
日历决定**。David 2026-08-07 拍板换制:学员按 W1D1 → W1D2 → … 顺序推进,完成一天,
下一次训练即下一天;教练排期降级为「推荐日期」纯展示;顺延功能失去存在意义,下线。

## 语义(一句话)

学员的「下一次训练」= 当前计划内按 `(week_number, day_of_week, sort_order, id)` 升序
排列的**第一个未完成训练日**(游标日)。周只是分组标签,不绑日历周;日历上时间过去多久
都不产生「过期/漏课」,游标停在哪就从哪继续——「补上」是默认行为本身。

## 术语与排序正典

- **游标日**:第一个无完成记录的 plan_day。排序键 = `(week_number, day_of_week, sort_order, id)`
  四元组(`plan_days` 无槽位唯一约束,历史数据可能同槽多行,`id` tiebreak 保确定性;
  `lockPlanShiftContext` 已用前三键排序,本 spec 把 `id` 补进正典)。
- **推荐日期**:`start_date + (week_number-1)*7 + (day_of_week-1)` 的位置式投影
  (现行 `plan-calendar.ts` 的 `plannedDate()`),**不叠加 shift 覆盖层**(拍板 2:忠实
  教练原排期,落后不重算)。W1 起它只是展示信息,不参与任何调度/判定。
- **完成**(拍板 1):auto(处方组全部记录)或 manual(学员显式结束)——见 §完成判定。

## 数据模型(一份迁移;号以开工现场核实为准,评审基线 0057)

```sql
CREATE TABLE plan_day_completions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_day_id  UUID NOT NULL REFERENCES plan_days (id) ON DELETE CASCADE,
  student_id   UUID NOT NULL REFERENCES users (id),
  source       TEXT NOT NULL CHECK (source IN ('auto', 'manual', 'backfill')),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT plan_day_completions_day_uidx UNIQUE (plan_day_id)
);
CREATE INDEX plan_day_completions_student_idx ON plan_day_completions (student_id, completed_at DESC);

ALTER TABLE plans ADD COLUMN published_at TIMESTAMPTZ;
UPDATE plans SET published_at = updated_at WHERE status IN ('published', 'completed');
```

- `ON DELETE CASCADE`:教练重编排删/重建某天时完成记录随之消失——语义正确(天没了,
  完成态无所附丽)。有 log 的天受现行不可变门保护,不会被静默重建;0 log 的 manual
  完成天(等效跳过)可能被教练编辑清掉,接受(见 §边界)。
- `published_at` 回填 `updated_at` 是一次性近似(存量 published 计划数量少,内测可接受);
  此后仅在 `draft→published` 与 `paused→published` 转移时写 `now()`(重发布刷新——
  paused 恢复视为「重新拍板生效」,与拍板 5 的「教练最新意志」语义一致)。

## 完成判定(拍板 1 = A)

### auto(主路径)

`POST /sets` 写入成功后,同事务内判定该 set 所属 plan_day 是否**满员**:该日全部
`plan_exercises` 的全部处方组(`plan_sets` 行)都存在对应 `set_logs`(按现行
`(plan_exercise_id, set_index)` 归属;`failed` 行算已记录,`adhoc` 行不参与)。满员则
upsert completion(`source='auto'`,`ON CONFLICT (plan_day_id) DO NOTHING`)。

**口径唯一**:满员判定必须复用/提取 `activity-ledger` 的 `sessionProgress` 完成度口径
(处方数 vs 实记数),严禁新写第二份——`exercise-stats.ts` 私自复制 `plannedDate()` 又
不认 shift 的口径分叉事故是本条的反例教材。

### manual(兜底,含「跳过」)

`POST /plans/days/:dayId/complete`(coached student 本人)→ completion(`source='manual'`)。
- 门:计划 `status='published'` 且 `trainee_id` = 本人(`NOT_PLAN_STUDENT`/`PLAN_NOT_ACTIVE`);
  已完成 → 200 幂等返回现有记录(多设备竞态不报错)。
- 0 组也允许(状态差做了热身就走 / 主动跳过这天)——推进制下「跳过」就是 manual complete,
  不造第二个概念。

### 撤销

`DELETE /plans/days/:dayId/complete`:
- 仅允许撤销**该学员当前计划内 completed_at 最新的一条**(`NOT_LATEST_COMPLETION`),
  且其 `completed_at` 落在当前上海 gym-day 内(`shanghaiTrainingDay()`,`UNDO_WINDOW_PASSED`)
  ——窗口口径与撤销哲学沿 054 顺延撤销的先例,但**统一用沪 gym-day,不再用 UTC**
  (054 的 UTC 口径是已知裂缝,新域不继承)。
- auto 完成同样可撤:学员想给最后一组补记视频/加组,撤销后该日重回游标日、恢复可写,
  记满后会再次 auto 完成——幂等闭环。
- 404/幂等:无完成记录 → `NO_COMPLETION_TO_UNDO`。

### backfill

`POST /plans/:id/imported-history`(教练导入历史)在现行逻辑上追加:对每个产生了
assumed log 的 plan_day 写 completion(`source='backfill'`, `completed_at` = 该日推荐日期
的 UTC 午夜)。否则导入完历史后游标指向已练过的旧天。assumed log **不触发** auto 路径
(auto 只在 `POST /sets` 事务内),backfill 是唯一入口,不会双写(UNIQUE 兜底)。

## 序列化与「当前计划」

- `PlanDayResponse` 追加 `completed_at: string | null`、`completion_source: string | null`
  (`getPlanWithChildren` 一次 join 带出,N+1 禁止)。
- `toPlan` 追加 `published_at: string | null`(计划树与 `GET /students/:studentId/plans`
  列表都带)。列表**现行排序(`created_at desc`)不变**——老客户端在依赖,挑「当前计划」
  的新规则由 iOS 071 按 `published_at` 自行执行(拍板 5:published 计划中 `published_at`
  最大者,tie 依 `created_at`、`id`)。
- **不新增** today/next-day 端点:游标规则一行可述、数据都在一次响应里,由客户端按
  §术语与排序正典 派生。正典规则的唯一权威 = 本 spec 此节,双端实现必须引用注释指回。

## 顺延域:冻结,不删(硬规矩 #8)

`plan_day_shifts` 表、`POST/DELETE /plans/:id/shift`、`shifted_to_date`/`total_shift_days`
序列化**全部原样保留**——已发布的 iOS 包(≤1.0(18))仍在调用。新客户端(071+)忽略这些
字段。退场条件:071 成为正典包且老包退出内测后,单独开波删除(含 drop 表迁移 + plan-web
清渲染)——届时才允许动。本 spec 的 diff **对顺延域零改动**。

## 边界 / 不做(W1 范围刀口)

- **streak / missed_training 结算信号 / exercise-stats 出勤率 / daily-digest**:W1 不动。
  推进制下它们的「应练日」语义已降级,接受一波的失真;W2 统一重定义为「距上次训练 N 天
  + 卡在 W几D几」(David 已拍口径,阈值沿现行 2 天)。
- **plan-web**:W1 零改动(网格照常按推荐日期渲染;顺延渲染随 W2 删)。
- **不做**服务端「只许记游标日」强制:`POST /sets` 沿现行 trust-client(仅 ownership 校验)。
  auto 完成对任意满员日生效,与游标无关(顺序由客户端 UI 保证,服务端不武断拒绝)。
- **不做**同日多节硬门:学员当天完成一天后继续下一天,服务端不拦(现实中双节课存在)。
- **教练编辑碰撞**:教练 delete+recreate 未练的天会连带清掉 0-log manual 完成(见 §数据模型),
  游标可能回退——罕见且语义可辩护(教练重排了课,学员按新课走),不做补偿机制。

## 验收 / 回归矩阵

- auto:满员触发(含 failed 组)/ 缺一组不触发 / adhoc 满堂不触发 / 撤销后补记再触发。
- manual:幂等(重复 POST 200)/ 0 组完成 / 非本人 403 / 非 published 409。
- undo:当天可撤、跨 gym-day `UNDO_WINDOW_PASSED`、非最新 `NOT_LATEST_COMPLETION`、
  沪 gym-day 边界(北京 03:59 vs 04:00)。
- backfill:导入历史后游标落在首个未导入日;重复导入不双写。
- `published_at`:publish/re-publish 转移写入;draft 不写;迁移回填存量。
- **老客户端回归**(硬规矩 #8):现行顺延测试套件全绿不动;计划树/列表响应仅增字段,
  shape 兼容;老 iOS 顺延流程照常可用。

## 拍板记录(David 2026-08-07)

1. 完成判定 = **A**:处方组全记自动完成 + 显式「结束今天训练」manual 兜底,完成态落库。
2. 推荐日期 = **A**:忠实显示教练原排期,落后不重算(不叠 shift、不动态顺推)。
3. 旧补练波 **作废**:iOS #275 / backend #104 已关闭,不实装。
4. 教练分诊口径改「距上次训练 N 天 + 卡在 W几D几」——W2 实施。
5. 换计划边界 = **A**:新计划发布即翻篇,学员游标永远跟最新 `published_at` 的计划走;
   旧计划残留原样存档。

### spec 内决策(随 PR 终审一并确认)

1. 撤销完成窗口 = 当天(沪 gym-day),与顺延撤销先例对齐但统一沪口径;
2. manual 完成 0 组也允许(= 跳过,不造第二概念);
3. `published_at` 存量回填用 `updated_at` 近似;paused→published 重发布刷新该字段。
