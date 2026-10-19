# 051 — 动作历史按「组 / 组×次」筛选 + 组视频 id(教练网页历史栏)

- **状态**: InProgress
- **来源**: David 2026-10-19 /grill「教练网页端编写计划」(逐题记录 `~/Projects/scratch/plan-block-grill-20261019.md`),共识「确认」。历史栏要逐级收窄:选定动作看该动作近 5 次;填了组数看「该动作 × 该组数」近 5 次;再填次数看「该动作 × 组 × 次」近 5 次;有视频的组能在编辑器里直接播。
- **产品正典**: `meetpr-plan-web` 仓 `specs/011-block-editor/SPEC.md` §3。本 spec 只定 wire 契约。
- **级别 / 节奏**: T1 / P1(单 handler、纯读、无迁移)。分支 `feat/051-exercise-stats-filtered-history` → `staging`。

## 现状

`GET /coach/students/:studentId/exercise-stats?exercise_id=X`(`src/handlers/exercise-stats.ts` `fetchExerciseStatsDetail`):

- `recent_sessions`:按 `logged_date` 分组的最近 5 次,每组带 `has_video`(布尔,没有 id,前端播不了)。
- `by_set_count`:按「当天该动作记了几组」分桶,每桶最多 3 次,只给最好重量与总次数,没有逐组明细。
- 没有按次数筛选。日志经 `plan_exercises` 内连接取得(只含计划内记录)。

## 变更

### 1. 每组补 `video_id`

`recent_sessions[].sets[]` 增加 `video_id: string | null`:该组 `status='ready'`、`kind='set_video'` 的附件 id(多个取最新)。`has_video` 保留,值 = `video_id !== null`。前端用现有 `GET /uploads/:id/url` 播放。

### 2. 可选查询参数 `sets`、`reps` → 新字段 `filtered_sessions`

- `sets`:正整数 1–20;`reps`:正整数 1–50;`reps` 只在给了 `sets` 时生效。非法值 → 400(沿用本 handler 现有的参数校验风格)。
- 不传 `sets` 时**响应与今天逐字段一致**(不出现 `filtered_sessions`)。
- **记录单位 = 一次处方行**:同一 `plan_exercise_id` 在同一 `logged_date` 的所有记录。(按日期合并会把同一天的顶组行和退让组行混成一次,组次就对不上了。)
- 处方组数 = 该 `plan_exercise` 的 `plan_sets` 行数;处方次数 = 这些 `plan_sets.target_reps` 全部相同时的那个值,不全相同则为 `null`。
- 匹配:`sets` 等于处方组数;若给了 `reps`,还要处方次数等于 `reps`。
- 按 `logged_date` 倒序取最多 5 条:

```json
"filtered_sessions": [
  {
    "date": "2026-10-16",
    "plan_exercise_id": "…",
    "prescribed": { "sets": 4, "reps": 3 },
    "sets": [
      { "set_index": 0, "weight_kg": "210.00", "reps": 3, "rpe": "8.0",
        "completed": true, "failed": false, "assumed": false,
        "has_video": true, "video_id": "…" }
    ]
  }
]
```

- `sets[]` 的字段与 `recent_sessions[].sets[]` 完全相同(含额外组,即 `set_index` ≥ 处方组数的记录也列出,按 `set_index` 排序)。
- 没有匹配:`filtered_sessions: []`。

### 3. 不变的

`rep_prs`、`by_set_count`、`e1rm`、`one_rm_reference`、overview 接口、鉴权与教练-学员归属校验全部不动。无迁移。

## 兼容

- 旧前端不传 `sets`,只会多看到一个 `video_id` 字段,无影响。
- 新前端遇旧后端:看不到 `filtered_sessions` / `video_id` 时自行降级(见 plan-web spec 011 §3.4)。

## 验收清单

1. 不带 `sets`:除每组新增 `video_id` 外,响应与改动前一致(现有测试不改而通过)。
2. 有视频的组 `video_id` 为附件 id、`has_video=true`;非 ready 或别人的附件不算。
3. 同一天同一动作有「1×3 顶组行」和「3×3 退让行」两条处方:`sets=3&reps=3` 只返回退让行那一条,`sets=1` 只返回顶组行。
4. 处方各组次数不一(如 5/3/1):`sets=3` 能匹配,`sets=3&reps=3` 不匹配。
5. 超过 5 条匹配只回最近 5 条,倒序。
6. 学员多做的额外组出现在该条的 `sets[]` 里,不影响「处方组数」匹配。
7. `reps` 无 `sets` 时被忽略;`sets=0`、`sets=abc`、`reps=999` → 400。
8. `npm test` 全量、`tsc` 通过。

## 测试 seam

`tests/exercise-stats.test.ts`(现有,最高层的 HTTP 级测试)里先红后绿覆盖验收 1–7;不新增 seam。

## Out of Scope

- 自己练(无计划)记录、学员自加动作(`adhoc`)进入筛选——它们没有处方行。
- 按强度 / 重量筛选;分页;超过 5 条。
- 任何写接口、迁移、iOS / 安卓改动。
