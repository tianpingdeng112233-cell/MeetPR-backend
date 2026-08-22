# 044 — 已发布计划的服务端「待推送草稿」(plan pending revision)

- **Status**: InProgress
- **触发**: plan-web spec 009(remote-draft-mirror)。David 2026-08-22 拍板 B:已发布计划的编辑内容自动暂存到服务端、学员不可见、点「更新计划」才应用。
- **事故背景**: 08-22 学员倪嘉骏「计划没了」——教练在 plan-web 写了 W7 但已发布计划不 autosave,未点「更新计划」即离开,内容只留在那台浏览器的 localStorage mirror;服务器 W7 为空,学员端游标耗尽显示「已全部完成」。本 spec 把 mirror 搬到服务端,跨浏览器/设备不丢。
- **迁移号**: **0068**(2026-08-22 现场核实:staging 头 0067;open PR 占号最高 0050;海外线同头 0067)。
- **不做**: 不改 autosave 语义(spec 003/web 004 拍板「已发布计划绝不自动推给学员」不动);不解释 content 内容(后端只当不透明 JSON);不做多版本历史;不做 student 侧任何可见性。

## 1. 数据模型(0068-plan-pending-revisions.sql)

```sql
CREATE TABLE plan_pending_revisions (
  plan_id      UUID PRIMARY KEY REFERENCES plans(id) ON DELETE CASCADE,
  coach_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,            -- 客户端 mirror schema 版本(plan-web DRAFT_MIRROR_VERSION)
  content_hash TEXT NOT NULL,               -- 客户端算的内容签名(fnv1a32:xxxxxxxx),后端不校验不计算
  content      JSONB NOT NULL,              -- 不透明:plan-web DraftMirrorContent 原样
  saved_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX plan_pending_revisions_coach_id_idx ON plan_pending_revisions (coach_id);
```

- 一个计划最多一条(PK = plan_id),写入即 upsert 覆盖(last-writer-wins;跨设备冲突由 web 端在读取时按 saved_at 让教练选)。
- `src/db/types.ts` 手工增补 `PlanPendingRevisionsTable`。
- 迁移测试 `tests/migrations/0068-plan-pending-revisions.test.ts`:表/PK/FK/级联删除(删 plan 连带删 revision)。
- 纯新增表,对既有客户端零影响(CLAUDE.md hard rule 8)。

## 2. 端点(挂在 `plansRouter`,全部 coach-only)

权限统一:`ensureUser` + `user.role === 'coach'` + `selectOwnedPlan(db, planId, user.id)`(计划 coach_id 必须是本人)。非 coach → 403 `{ error: 'FORBIDDEN' }`(沿用仓内 `requireRole`/既有错码习惯,以现有 plans 路由为准);计划不存在/非本人 → 404 `PLAN_NOT_FOUND`。

### `PUT /plans/:id/pending-revision`

- body(zod):`{ version: int ≥ 1, content_hash: string 1..64, content: object }`;序列化后 content 上限 **1 MiB**,超限 → 413 `{ error: 'PAYLOAD_TOO_LARGE' }`(用 zod refine 或 JSON.stringify 长度判断,不依赖 body-parser 全局上限——先确认 `express.json` 的 limit 允许 1 MiB,不够就给这条路由单独挂更大的 limit)。
- 允许的计划状态:`published` 与 `draft` 都允许(web 端只对 published 用;draft 允许是为了将来 autosave 失败兜底,不额外分支)。`completed`/`paused` → 409 `PLAN_NOT_EDITABLE`。
- upsert:`ON CONFLICT (plan_id) DO UPDATE SET coach_id, version, content_hash, content, saved_at = now()`。
- 响应 200 `{ plan_id, version, content_hash, saved_at }`(不回 content)。

### `GET /plans/:id/pending-revision`

- 200 `{ plan_id, version, content_hash, content, saved_at }`;无记录 → 404 `{ error: 'PENDING_REVISION_NOT_FOUND' }`。

### `DELETE /plans/:id/pending-revision`

- 幂等:有则删,无也 204。

### 列表附带字段(让 web 下拉/顶栏知道「有未推送改动」)

- `GET /students/:studentId/plans`(**仅 coach 角色分支**)每个 plan 增加 `pending_revision_saved_at: string | null`(LEFT JOIN plan_pending_revisions)。student 角色分支响应形状**不变**(学员永远看不到)。
- `GET /plans/:id` 的 coach 分支响应同样增加 `pending_revision_saved_at: string | null`;student 分支不加。
- 两处都是 additive,iOS 不受影响。

### 清理

- 计划删除:靠 FK 级联。
- 「更新计划」成功后由 web 端显式 `DELETE`(后端不猜 batch/天级写入是否等于「已应用」——因为 revision 可能只覆盖部分改动)。
- `POST /plans/:id/publish`(draft→published)不动 revision。

## 3. 测试(vitest + supertest,放 `tests/plans/plan-pending-revision.test.ts`)

1. coach PUT 后 GET 原样回 content/version/hash,saved_at 单调更新;二次 PUT 覆盖。
2. 另一教练 PUT/GET/DELETE → 404;学员 token → 403。
3. completed 计划 PUT → 409;draft 计划 PUT → 200。
4. content 超 1 MiB → 413。
5. DELETE 幂等 204 ×2;删计划后 revision 级联消失。
6. `GET /students/:id/plans` coach 分支带 `pending_revision_saved_at`(有/无各一例);student 分支响应键集合不含该字段。

## 4. 部署与台账

- 合并后必须部署 staging(`gh workflow run deploy-staging.yml -f migrations_applied=true` 前先由 David 在 DMS 跑 0068)并同步海外线(deploy-global);`db/MIGRATIONS-APPLIED.md` 由 Claude 在部署时登记,**Codex 不写台账**。
- 合并顺序:本 PR 先于 plan-web 009(web 端对 404/缺字段做了兼容,但先合后端可避免线上窗口期)。
