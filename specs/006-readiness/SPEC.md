# 006-readiness

**Status:** InProgress
**Date:** 2026-06-11

## 权威

本 spec 是**薄壳**:readiness check-in 的产品语义、数据模型、校验细节、授权矩阵的唯一权威是 iOS 仓 **spec 030 §C7**(`MeetPR/specs/030-jai-readiness-timer-platemath/SPEC.md`,"体量小,不另开 backend spec,本节即权威")。本文件只做 backend 仓内落点登记 + wire shape 摘录,冲突时以 030 §C7 为准。

## 落点

| 物        | 文件                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Migration | `db/migrations/0014-init-readiness-checkins.sql`(030 写作时预计 0008,落地时 0008-0013 已被 spec 005 占用,顺延为 0014)                |
| 类型      | `src/db/types.ts` — `READINESS_MUSCLE_GROUPS` / `MuscleFatigueEntry` / `ReadinessCheckinsTable`                                      |
| 路由      | `src/routes/readiness.ts` — `studentReadinessRouter`,挂 `/students`;**`/me/readiness` 先于 `/:id/readiness` 注册**(Express 按序匹配) |
| Handlers  | `src/handlers/readiness-submit.ts`(upsert)/ `src/handlers/readiness-fetch.ts`(查询 + 序列化)                                         |
| 测试      | `tests/readiness.test.ts`(zod 拒绝矩阵 / upsert 覆盖 / 授权矩阵)+ `tests/migrations/0014-readiness-checkins.test.ts`                 |

## Wire shape 摘录(权威在 030 §C7)

**`POST /students/me/readiness`** — student only(`coached_student` / `self_train_student`),upsert 语义(`ON CONFLICT (student_id, checkin_date) DO UPDATE`,`submitted_at` 保首提时间、`updated_at` 跟覆盖),覆盖后仍 `201`,响应为**完整 check-in 行**(与 GET 的 `checkin` 对象同构;iOS 按完整 `ReadinessCheckinDTO` 解码 POST 响应,2026-07-11 修订——此前只回 `{ id, submitted_at }` 导致客户端解码假失败):

```json
{
  "checkin_date": "2026-06-11",
  "sleep_quality": 4,
  "mood": 3,
  "stress": 2,
  "muscle_fatigue": [
    { "muscle_group": "quad", "severity": 3 },
    { "muscle_group": "core", "severity": 1 }
  ]
}
```

zod(服务端是真 gate):`checkin_date` 严格 `YYYY-MM-DD` 且为真实日历日;三量表 int 1-5;`muscle_fatigue` 数组 ≤ 8、`muscle_group` ∈ 8 值白名单 `quad/hamstring/glute/back/chest/shoulder/triceps/core`(逐字镜像 iOS `ReadinessCheckin.allowedMuscleGroups`,加值 = 两侧同步改 + spec 修订)、`severity` int 1-3、`muscle_group` 不重复;`.strict()` 拒 camelCase / 未知键。

**`GET /students/:id/readiness?date=YYYY-MM-DD`** — `200 { checkin: {...} | null }`;授权矩阵照抄 `GET /students/:id/sets`:student 仅 self,coach 需 `status='accepted'` 的 bind(`hasAcceptedBond`),其余 403 `AUTHORIZATION_FORBIDDEN`;`date` 必填,缺失/非法 → 400 `VALIDATION_ERROR`。

`checkin` 行:`id, student_id, checkin_date, sleep_quality, mood, stress, muscle_fatigue, submitted_at, updated_at`(全 snake_case,DATE-as-text)。

## 修订记录

| 日期       | 修订                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| 2026-06-11 | 初版:落点登记 + wire 摘录;migration 编号 0008 → 0014 顺延                                                         |
| 2026-07-11 | POST 响应从 `{ id, submitted_at }` 扩为完整 check-in 行(与 GET 同构):iOS 按完整 DTO 解码,旧响应致已发包提交假失败 |
