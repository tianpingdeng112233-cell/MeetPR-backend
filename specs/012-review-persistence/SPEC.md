# 012 — session reviews:训练回顾持久化(iOS spec 051 的后端半)

- **状态**: Draft
- **来源**: 走查 P0-3「学员认真写的反思,关掉页面就丢(代码注释自认 session-local)。收集但丢弃比不收集更伤信任」。学员自看为先;教练消费归教练 wave(读端点已备好即可)。
- **批准语境**: 自己练 Free 档 wave 泳道 B(David 2026-07-04 四拍板);走查建议「三问砍成一句话感受」由 iOS 051 裁决,后端按一条文本+可选评分建模,不锁题式。

## Migration `0032-init-session-reviews.sql`(取号合并当刻现场核实:staging 头 + open PR 占号)

```sql
CREATE TABLE session_reviews (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  review_date  DATE NOT NULL,            -- 客户端本地训练日(与 set_logs.logged_date 同口径)
  feeling      TEXT NOT NULL,            -- 一句话感受(iOS 051 决定收敛为单条)
  session_rpe  NUMERIC(3,1),             -- 可选整场 RPE(0-10,一位小数)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, review_date)       -- 日即会话:每天一条,重写覆盖
);
```

CHECK:`length(trim(feeling)) > 0`、`session_rpe BETWEEN 0 AND 10`。pg-mem 注意:trim/length 已在 helpers 注册;UNIQUE 普通约束无方言坑。

## 端点(`reviewsRouter`,requireAuth)

- `PUT /students/:id/reviews/:date`(本人;`requireRole('coached_student','self_train_student')`,`uuidEquals` 本人校验):body `{ feeling, session_rpe? }`,upsert by (student, date),200 返回行。空 feeling → 400 `REVIEWS_FEELING_REQUIRED`。
- `GET /students/:id/reviews?from&to`(本人,或该学员的已绑定教练——复用 sets 的教练可见性模式但按 bond 而非 plan join;教练端 UI 归教练 wave,端点先备好):200 `{ reviews: [...] }`,DATE-as-text。

## 测试

- migration 测试(pg-mem):列/约束/UNIQUE 覆盖写。
- 路由:本人 upsert 幂等(同日二写=覆盖)/空 feeling 400/他人 403/教练(有 bond)可读、无 bond 403/日期窗口。

## 验收

1. staging:PUT 后 GET 取回;同日重写覆盖不重复。
2. 兼容:纯新增面,老客户端零影响。
