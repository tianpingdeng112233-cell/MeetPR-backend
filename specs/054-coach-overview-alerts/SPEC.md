# 054 — 教练总览「待处理」提醒汇总接口

- **状态**: Draft（2026-10-22 /grill 共识「确认」）
- **来源**: David 2026-10-22「网页端把学员申请做进总览 tab，删掉学员申请 tab」+「总览该有的提醒：计划快结束 / RPE 超 1 或未完成 / 留言」。逐题记录 `~/Projects/scratch/overview-inbox-grill-20261022.md`。
- **产品正典**: `meetpr-plan-web` 仓 `specs/019-overview-inbox/SPEC.md`。本 spec 只定 wire 契约与判定口径。
- **级别 / 节奏**: T2 / P1（新路由 + 1 个迁移）。分支 `feat/054-overview-alerts` → `staging`。合并后必须部署 staging（不许只合不部署）。

## 现状

- 网页总览只拿得到计划摘要（起止日期）、`exercise-stats` overview（近 4 周完成率）、会话未读数。拿不到「哪一组 RPE 超了」「哪天有组没完成」。
- 已有 `student_signals`（`missed_training` / `pr_congrats`）与每日结算任务，带推送，客户端目前没有调用 `GET /signals`。**本 spec 不往 `student_signals` 里加类型**，免得牵动推送与每日摘要；提醒在读时现算。
- 「推荐日期」已有正典计算（`src/domain/plan-calendar.ts` `effectivePlanDays`，含后移）。

## 变更

### 1. 迁移 0079：`coach_student_plan_views`

```
coach_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
seen_at    TIMESTAMPTZ NOT NULL
PRIMARY KEY (coach_id, student_id)
```

存量照护：纯新增表，不改任何现有行。没有行 = 教练从没打开过 = 最近 7 天的事全部算未看（见 §3 窗口），不需要回填。0076–0078 已被在途分支占用，开工时现场核实最大号再定。

### 2. `POST /coach/students/:studentId/plan-viewed`

教练打开该学员计划编排（网页）时调用。upsert `seen_at = now()`，204。只允许已绑定该学员的教练；否则沿用现有学员归属校验的错误码。幂等。

### 3. `GET /coach/overview-alerts`

只返回当前教练名下、绑定中的学员。

```json
{
  "generated_at": "2026-10-22T09:00:00Z",
  "plan_ending": [
    { "student_id": "…", "plan_id": "…", "plan_name": "W5–W8", "end_date": "2026-10-24", "days_left": 2 }
  ],
  "training": [
    {
      "student_id": "…",
      "latest_at": "2026-10-21T20:14:00Z",
      "items": [
        { "type": "rpe_over", "date": "2026-10-21", "plan_day_id": "…", "plan_exercise_id": "…",
          "exercise_id": "…", "set_index": 2, "target_rpe": "8.0", "actual_rpe": "9.5" },
        { "type": "incomplete", "date": "2026-10-20", "plan_day_id": "…", "plan_exercise_id": "…",
          "exercise_id": "…", "set_index": 4, "reason": "missing" },
        { "type": "behind", "recommended_date": "2026-10-19", "plan_day_id": "…", "week_number": 2 }
      ]
    }
  ]
}
```

判定口径（所有「今天」按学员时区的训练日，沿用 `utils/date` `trainingDay` 与现有时区工具）：

- **plan_ending（计划快结束）**：取该学员在本教练名下 `status='published'` 的计划里 `end_date` 最晚的一份。`days_left = end_date − 今天`，满足 `-14 ≤ days_left ≤ 3` 且不存在另一份 `start_date > 该 end_date` 的已发布计划时出现。草稿不算接上。**不受 `seen_at` 影响**——发布下一份才消失。
- **rpe_over（RPE 超标）**：计划内 `set_logs`，实际 RPE = `COALESCE(coach_rpe, rpe)`；目标 RPE = `load_mode='rpe'` 取 `target_rpe`，`load_mode='rpe_range'` 取 `rpe_high`；其余模式或目标为空的组不判。`实际 ≥ 目标 + 1` 即一条。
- **incomplete（未完成）**：学员已完成（`plan_day_completions` 有行）的训练日里，某处方组没有 `completed=true` 的记录（`reason:'missing'`），或该组记录 `failed=true`（`reason:'failed'`）。额外组、自加动作不判。
- **behind（落后）**：已发布计划里推荐日期（`effectivePlanDays`，含后移）早于今天、且未完成的训练日。只是轻提示，网页不计入红色计数。
- **窗口与已看**：rpe_over / incomplete 以训练日期、behind 以推荐日期为准，只取最近 7 天（今天往前 7 个训练日内）；并且只取发生在 `seen_at` 之后的——rpe_over / incomplete 比 `set_logs.logged_at` / 完成时间，behind 比推荐日期（`推荐日期 > seen_at 的训练日` 才出现）。
- `training` 里没有 items 的学员不出现；items 按日期倒序；学员按 `latest_at` 倒序。

性能：一次请求覆盖教练全部学员，禁止按学员 N+1 查询（教练 50 学员量级要能一次出）。

## 验收清单

1. 迁移 0079 可重复执行检查通过，down/up 与现有迁移测试风格一致；存量表零改动。
2. `plan-viewed`：绑定教练 204 且 `seen_at` 更新；非绑定教练、学员角色被拒；重复调用幂等。
3. plan_ending：剩 3 天出现、剩 4 天不出现；已结束 14 天内出现、15 天不出现；后面接了已发布计划消失；接的是草稿仍出现；`plan-viewed` 不影响它。
4. rpe_over：目标 8 实际 9 出现、8.5 不出现；`rpe_range` 7–8 实际 9 出现；`coach_rpe` 覆盖学员 rpe；百分比/固定重量模式不判。
5. incomplete：完成的训练日少记一组 → missing；有 failed → failed；未完成的训练日不判；额外组、自加动作不判。
6. behind：推荐日期昨天未练出现；被后移到明天的不出现；已完成的不出现。
7. 窗口：8 天前的事不出现；`plan-viewed` 之后只出现之后发生的。
8. 别的教练的学员、已解绑学员不出现。
9. 现有 `GET /signals`、结算任务、推送、`exercise-stats` 行为与测试不变；全量测试绿。

## 测试 seam

1. 纯函数判定（新 `src/domain/overview-alerts.ts`，单测 `tests/domain/overview-alerts.test.ts`）：清单 3–7 的口径都在这一层先红后绿，输入是计划/日志/完成/后移/seen 的普通对象。
2. 路由最高层（新 `tests/coach-overview-alerts.test.ts`，夹具复用现有 coach 路由测试 helper）：清单 2、8 与一条端到端正例（造计划+日志 → GET 出现 → POST plan-viewed → GET 消失）。
3. 迁移测试沿用 `tests/migrations/` 现有写法。

## Out of Scope

- 留言：网页直接用现有会话未读数与 `last_message`，后端不动。
- 学员申请：现有 bind-requests 接口不动。
- 不加推送、不进每日摘要、不改 `student_signals`。
- iOS / 安卓教练端不接本接口（本轮只做网页）。
