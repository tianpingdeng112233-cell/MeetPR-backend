# 005-bind-eval-profile

**Status:** InProgress
**Date:** 2026-06-11

## 目标

落地 V0.1b 完成波(per [[v0_1b_completion_wave]] §2 backend spec 005)学员"陌生人 → 正式训练"旅程的全部 backend 增量:

1. **邀请码体系** — 3 类 code(Personal 永久 / 一次性 / 限时),教练生成 / 列表 / revoke
2. **绑定状态机** — `bind_requests` 表(0003.6 已建)的全部端点:学员发请求 / 查询 / 取消,教练接收队列 / accept / reject;过期全惰性判定(无 cron)
3. **评估期** — `evaluation_periods` 7 天硬框架 + **服务端禁发正式计划真 gate**(`plans.kind` 列 + publish 校验)
4. **评估总结** — `student_evaluations` 3 字段 + `student_evaluation_versions` 版本快照
5. **学员 onboarding 档案** — 7 步 29 字段存储 + 分步可重入 upsert + 1RM 锁定 + 教练改 1RM 专用端点

Refs(产品权威设计源,状态机照抄):

- [evaluation-workflow.md v1.1](~/Brain/wiki/projects/MeetPR/evaluation-workflow.md) — §2 邀请码 / §3 接收队列 / §4 评估期 / §5 评估总结,数据模型 SQL 草案 §2.3 / §3.6 / §4.5 / §5.6
- [student-onboarding.md v2.4](~/Brain/wiki/projects/MeetPR/student-onboarding.md) — 7 步 29 字段 + 各 Step 数据模型影响
- [v0_1b_completion_wave.md](~/Brain/wiki/projects/MeetPR/v0_1b_completion_wave.md) — wave 决议:惰性过期无 cron / 无 APNs / 服务端禁发正式计划是真 gate
- 上游 [003-student-actions](../003-student-actions/SPEC.md) — `bind_requests` / `student_profiles` 表 + wire shape 约定(全 snake_case + Decimal-as-string)
- 并行 [004-video-upload](../004-video-upload/SPEC.md) — 占用 migration 0007;attachments 表在该 spec 落地,本 spec 的 `onboarding_uploads.attachment_id` **暂不加 FK**

## 关键决策(实装拍板)

| #   | 决策                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **display_name 采集位置 = `POST /bind-requests` body**。注册(001-auth)不建 profile 行,E2E 已发现花名册 inner join 因此丢学员;绑定请求是 student_profiles 行的兜底 bootstrap 点(upsert:不存在则建,存在则更新 display_name)。onboarding 端点不碰 display_name。             |
| D2  | **bind_requests 加 2 列(ALTER,不重建表)**:`invite_code_id UUID REFERENCES invite_codes ON DELETE SET NULL` + `skip_reason TEXT` — 两列都是 wiki §3.6 权威数据模型字段,0003.6 V0.1 minimal 时砍掉,本 spec 补齐。                                                           |
| D3  | invite_codes.type / plans.kind / completion_type 用 **TEXT + CHECK**(与 0003 plans 风格一致;0003.6 的 PG enum 是孤例,不扩散)。                                                                                                                                            |
| D4  | code 字母表 32 字符 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`(去易混 `I O 0 1`;全大写存储,redeem 时 `upper()` 归一化输入)。10 位,crypto 随机,unique 冲突重试 3 次。                                                                                                              |
| D5  | single_use 防 race:redeem 走**原子 UPDATE guard** `SET used_count = used_count + 1 WHERE … AND (max_uses IS NULL OR used_count < max_uses) RETURNING`,不做先读后写。                                                                                                      |
| D6  | personal_permanent 每教练唯一活跃:事务内先 revoke 旧码再 insert 新码 + **partial unique index 兜底**(`(coach_id) WHERE type='personal_permanent' AND revoked_at IS NULL`)。                                                                                               |
| D7  | 过期/超期**全部惰性**:任何读/写 pending bind_request 的路径先把 `pending AND expired_at < now()` 翻成 `expired` 再继续。评估期 `overdue` 是读时计算字段(`completed_at IS NULL AND now() > expected_end_at`),**不落库不自动完成**。                                        |
| D8  | evaluation_periods 保留 wiki §4.5 的 4 值 completion_type DDL(V0.1b 只写 `coach_completed`),**去掉 overdue push 两列**(无 APNs,wave 决议)。partial unique `(student_id, coach_id) WHERE completed_at IS NULL` 保证一对一 active。                                         |
| D9  | **publish 真 gate 三重**:zod(创建时 adaptation→plan_weeks=1)+ DDL CHECK(`kind='regular' OR plan_weeks=1`)+ publish 事务内查 active evaluation_period(coach↔trainee 有未完成评估期且 plan 不是 1 周 adaptation → `403 EVALUATION_IN_PROGRESS`)。`kind` 创建后不可 PATCH。  |
| D10 | 评估总结一对 (student, coach) 一行(UNIQUE),每次保存写 version 快照行;`notify_student` 只落 `student_evaluation_versions.notified_student`(backend 只记录,推送语义 iOS 端处理)。`evaluation_period_id` 首存时绑定当时最新评估期(可为 NULL = 跳过评估期场景),后续保存不改。 |
| D11 | onboarding 标量约束 DDL CHECK + zod 双重;**数组内容 token 校验只在 zod**(PG 数组 containment CHECK pg-mem 不支持,且 zod 是 API 写入的真 gate);`muscle_groups_to_strengthen ≤ 3` DDL `array_length` CHECK + zod 双重。                                                     |
| D12 | `training_years SMALLINT 0–10`(0 = <1 年,10 = 10+,对应滑块);`sleep_hours SMALLINT 1–5` 存**档位**(1=≤5h, 2=6h, 3=7h, 4=8h, 5=9h+),与其余 3 个恢复滑块同构。                                                                                                               |
| D13 | 接收队列摘要返回 `birth_date` 而非年龄(客户端算,免时区漂移);"资料计数" = `onboarding_uploads` 行数(视频/计划细分等 spec 004 attachments 落地后 iOS 拼装,V0.1b 一个总数)。                                                                                                 |
| D14 | pending 防重:每学员同时最多 1 个 pending(`409 BIND_REQUEST_ALREADY_PENDING`);同对 (student, coach) 已 accepted 再发 → `409 BIND_ALREADY_BOUND`。跨教练第二 bond 数据层容忍(003 测试矩阵已有双 coach fixture,不破坏)。                                                     |
| D15 | `muscle_groups_to_strengthen` token 复用 exercises 的 `MUSCLE_GROUPS` 词表(竖脊肌 iOS 端映射 `back`);`injury_areas` 新词表 8 值;`training_days` 词表 `mon…sun`。                                                                                                          |
| D16 | `GET /students/:id/onboarding` 授权三态:self / accepted-bond coach / **live-pending coach**(接收队列"查看完整资料"场景,pending 且未过期即可看)。                                                                                                                          |
| D17 | Step 6 上传:`PUT /students/me/onboarding` 收 `upload_attachment_ids: UUID[]`,**全量替换**语义(事务内 delete + insert);`onboarding_uploads.attachment_id` 无 FK(attachments 表在并行 spec 004,集成 spec 收口时补 FK)。                                                     |
| D18 | reject 维持 silent:无 reason 字段,`rejection_silent` 默认 TRUE 不动(wiki §3.4)。                                                                                                                                                                                          |

## Scope

### Migrations(6 个新文件,0007 被并行 spec 004 占用)

| File                                | 内容                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `0008-init-invite-codes.sql`        | `invite_codes` 表(wiki §2.3)+ 唯一活跃 personal partial index                                    |
| `0009-extend-bind-requests.sql`     | `bind_requests` ALTER 加 `invite_code_id` FK + `skip_reason`(wiki §3.6 补齐)                     |
| `0010-add-plan-kind.sql`            | `plans.kind TEXT CHECK ('regular','adaptation') DEFAULT 'regular'` + adaptation→1 周 cross CHECK |
| `0011-init-evaluation-periods.sql`  | `evaluation_periods`(wiki §4.5 去 push 列)+ 一对一 active partial index                          |
| `0012-init-student-evaluations.sql` | `student_evaluations` + `student_evaluation_versions`(wiki §5.6)                                 |
| `0013-init-onboarding-profiles.sql` | `student_onboarding_profiles` 29 字段 + `onboarding_uploads` 关联表                              |

#### `0008-init-invite-codes.sql`

```sql
CREATE TABLE invite_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code        TEXT NOT NULL UNIQUE CHECK (length(code) = 10),
  type        TEXT NOT NULL CHECK (type IN ('personal_permanent', 'single_use', 'time_limited')),
  max_uses    INT CHECK (max_uses IS NULL OR max_uses >= 1),  -- 1 for single_use; NULL otherwise
  used_count  INT NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at  TIMESTAMPTZ,                                    -- set for time_limited only
  revoked_at  TIMESTAMPTZ,
  label       TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 100),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one active personal permanent code per coach (D6)
CREATE UNIQUE INDEX invite_codes_one_active_personal
  ON invite_codes (coach_id) WHERE type = 'personal_permanent' AND revoked_at IS NULL;

CREATE INDEX invite_codes_coach_created_idx ON invite_codes (coach_id, created_at DESC);
```

#### `0009-extend-bind-requests.sql`

```sql
ALTER TABLE bind_requests
  ADD COLUMN invite_code_id UUID REFERENCES invite_codes(id) ON DELETE SET NULL;
ALTER TABLE bind_requests
  ADD COLUMN skip_reason TEXT CHECK (skip_reason IS NULL OR length(skip_reason) BETWEEN 1 AND 500);
```

#### `0010-add-plan-kind.sql`

```sql
ALTER TABLE plans
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'regular' CHECK (kind IN ('regular', 'adaptation'));
-- Adaptation plans are always exactly 1 week (evaluation-workflow §4.2)
ALTER TABLE plans
  ADD CONSTRAINT plans_adaptation_one_week_check CHECK (kind = 'regular' OR plan_weeks = 1);
```

#### `0011-init-evaluation-periods.sql`

```sql
CREATE TABLE evaluation_periods (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coach_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bind_request_id  UUID NOT NULL REFERENCES bind_requests(id) ON DELETE CASCADE,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expected_end_at  TIMESTAMPTZ NOT NULL,            -- started_at + 7 days, set at insert
  completed_at     TIMESTAMPTZ,
  completion_type  TEXT CHECK (completion_type IS NULL OR completion_type IN ('coach_completed', 'auto_completed', 'overdue', 'cancelled')),
  CONSTRAINT evaluation_periods_completion_consistency
    CHECK ((completed_at IS NULL) = (completion_type IS NULL))
);

-- One active evaluation period per (student, coach) pair (D8)
CREATE UNIQUE INDEX evaluation_periods_one_active
  ON evaluation_periods (student_id, coach_id) WHERE completed_at IS NULL;

CREATE INDEX evaluation_periods_coach_idx   ON evaluation_periods (coach_id, started_at DESC);
CREATE INDEX evaluation_periods_student_idx ON evaluation_periods (student_id, started_at DESC);
```

V0.1b 只写 `completion_type = 'coach_completed'`;`auto_completed` / `overdue` / `cancelled` 是 wiki §4.5 预留值,DDL 保留避免后续 ALTER。

#### `0012-init-student-evaluations.sql`

```sql
CREATE TABLE student_evaluations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coach_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  evaluation_period_id  UUID REFERENCES evaluation_periods(id) ON DELETE SET NULL,  -- NULL = 跳过评估期
  overall_assessment    TEXT NOT NULL CHECK (length(trim(overall_assessment)) BETWEEN 1 AND 10000),
  training_plan         TEXT NOT NULL CHECK (length(trim(training_plan)) BETWEEN 1 AND 10000),
  words_to_student      TEXT CHECK (words_to_student IS NULL OR length(trim(words_to_student)) BETWEEN 1 AND 10000),
  first_saved_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (student_id, coach_id)
);

CREATE TABLE student_evaluation_versions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id       UUID NOT NULL REFERENCES student_evaluations(id) ON DELETE CASCADE,
  overall_assessment  TEXT NOT NULL,
  training_plan       TEXT NOT NULL,
  words_to_student    TEXT,
  notified_student    BOOLEAN NOT NULL DEFAULT FALSE,
  saved_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX student_evaluation_versions_eval_idx
  ON student_evaluation_versions (evaluation_id, saved_at DESC);
```

#### `0013-init-onboarding-profiles.sql`

29 字段 → 列映射(per student-onboarding v2.4 各 Step"数据模型影响"):

| Step       | 列                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| 1 基础信息 | `unit_preference` `gender` `birth_date` `height_cm` `weight_kg`                                              |
| 2 训练背景 | `training_years` `squat_stance` `deadlift_style` `bench_grip`(选填)                                          |
| 3 1RM      | `squat_1rm_kg` `bench_1rm_kg` `deadlift_1rm_kg`(完成后锁定,Type A)                                           |
| 4 训练环境 | `training_days TEXT[]` `gym_tier` `equipment_overrides TEXT[]`                                               |
| 5 恢复能力 | `daily_life_intensity` `life_stress` `recovery_speed` `sleep_hours`(全部 SMALLINT 1–5 档位)                  |
| 6 训练资料 | `onboarding_uploads` 关联表(计划/视频上传)+ `muscle_groups_to_strengthen TEXT[]`(≤3)                         |
| 7 补充信息 | `injury_notes` `injury_areas TEXT[]` `is_competing` `competition_date` `target_weight_class` `note_to_coach` |
| 元数据     | `completed_at`(`POST …/complete` 专设)+ `created_at` / `updated_at`                                          |

```sql
CREATE TABLE student_onboarding_profiles (
  user_id                      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  unit_preference              TEXT CHECK (unit_preference IS NULL OR unit_preference IN ('kg', 'lb')),
  gender                       TEXT CHECK (gender IS NULL OR gender IN ('male', 'female', 'other')),
  birth_date                   DATE,
  height_cm                    NUMERIC(5,1) CHECK (height_cm IS NULL OR (height_cm > 0 AND height_cm < 300)),
  weight_kg                    NUMERIC(5,2) CHECK (weight_kg IS NULL OR (weight_kg > 0 AND weight_kg < 500)),
  training_years               SMALLINT CHECK (training_years IS NULL OR training_years BETWEEN 0 AND 10),
  squat_stance                 TEXT CHECK (squat_stance IS NULL OR squat_stance IN ('high_bar', 'low_bar')),
  deadlift_style               TEXT CHECK (deadlift_style IS NULL OR deadlift_style IN ('conventional', 'sumo')),
  bench_grip                   TEXT CHECK (bench_grip IS NULL OR bench_grip IN ('narrow', 'standard', 'wide')),
  squat_1rm_kg                 NUMERIC(6,2) CHECK (squat_1rm_kg IS NULL OR (squat_1rm_kg > 0 AND squat_1rm_kg < 1000)),
  bench_1rm_kg                 NUMERIC(6,2) CHECK (bench_1rm_kg IS NULL OR (bench_1rm_kg > 0 AND bench_1rm_kg < 1000)),
  deadlift_1rm_kg              NUMERIC(6,2) CHECK (deadlift_1rm_kg IS NULL OR (deadlift_1rm_kg > 0 AND deadlift_1rm_kg < 1000)),
  training_days                TEXT[],   -- 'mon'..'sun'; 2-6 entries + token vocab enforced in zod (D11)
  gym_tier                     TEXT CHECK (gym_tier IS NULL OR gym_tier IN ('home_with_rack', 'commercial', 'professional')),
  equipment_overrides          TEXT[],   -- free-form equipment IDs, vocab owned by iOS
  daily_life_intensity         SMALLINT CHECK (daily_life_intensity IS NULL OR daily_life_intensity BETWEEN 1 AND 5),
  life_stress                  SMALLINT CHECK (life_stress IS NULL OR life_stress BETWEEN 1 AND 5),
  recovery_speed               SMALLINT CHECK (recovery_speed IS NULL OR recovery_speed BETWEEN 1 AND 5),
  sleep_hours                  SMALLINT CHECK (sleep_hours IS NULL OR sleep_hours BETWEEN 1 AND 5),
  muscle_groups_to_strengthen  TEXT[] CHECK (muscle_groups_to_strengthen IS NULL OR array_length(muscle_groups_to_strengthen, 1) <= 3),
  injury_notes                 TEXT CHECK (injury_notes IS NULL OR length(injury_notes) BETWEEN 1 AND 2000),
  injury_areas                 TEXT[],   -- 'shoulder','elbow','wrist','lower_back','hip','knee','ankle','other'
  is_competing                 BOOLEAN,
  competition_date             DATE,
  target_weight_class          TEXT CHECK (target_weight_class IS NULL OR length(target_weight_class) BETWEEN 1 AND 100),
  note_to_coach                TEXT CHECK (note_to_coach IS NULL OR length(note_to_coach) BETWEEN 1 AND 2000),
  completed_at                 TIMESTAMPTZ,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Step 6 uploads: attachment linkage. NO FK on attachment_id — the attachments
-- table is created by parallel spec 004; the integration spec adds the FK (D17).
CREATE TABLE onboarding_uploads (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attachment_id  UUID NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, attachment_id)
);
```

全列 nullable(除元数据)— 分步可重入 upsert 要求部分提交合法;"必填"语义由 `POST /students/me/onboarding/complete` 服务端校验兜底(见 §端点 E)。

### Wire shape 约定

延续 002/003:**HTTP 全 snake_case**(zod `.strict()` 拒 camelCase → 400 VALIDATION_ERROR);NUMERIC 列 **Decimal-as-string**(`"180.00"`);`DATE` 列 DATE-as-text(`"2026-07-25"`);TIMESTAMPTZ → ISO 8601 字符串。错误信封 `{ error: '<MACHINE_CODE>', ...details }`。

### 端点

全部走 `requireAuth`。角色标注:`coach` = `requireRole('coach')`;`student` = `requireRole('coached_student')`(绑定流程不对 self_train 开放);`any student` = `requireRole('coached_student', 'self_train_student')`。

#### A. 邀请码(挂载 `/coach`)

| Method + Path                    | Roles | Request                              | Success                                                               |
| -------------------------------- | ----- | ------------------------------------ | --------------------------------------------------------------------- |
| `POST /coach/invite-codes`       | coach | `{ type, label?, expires_in_days? }` | `201 InviteCode`                                                      |
| `GET /coach/invite-codes`        | coach | —                                    | `200 { invite_codes: InviteCode[] }`(全部含已 revoke,created_at DESC) |
| `DELETE /coach/invite-codes/:id` | coach | —                                    | `204`(幂等:重复 revoke no-op)                                         |

`POST` body 校验:

```ts
z.object({
  type: z.enum(['personal_permanent', 'single_use', 'time_limited']),
  label: z.string().trim().min(1).max(100).nullable().optional(),
  expires_in_days: z.number().int().min(1).max(365).optional(),
}).strict();
// superRefine: type='time_limited' ⇔ expires_in_days 必填;其余 type 带 expires_in_days → 400
```

语义:

- `personal_permanent`:事务内 `UPDATE invite_codes SET revoked_at = now() WHERE coach_id = $me AND type = 'personal_permanent' AND revoked_at IS NULL` → insert 新码(自动 revoke 旧码,D6)
- `single_use`:`max_uses = 1`
- `time_limited`:`expires_at = now + expires_in_days 天`(应用层计算后落库,语义等价 `now() + N * interval '1 day'`)
- code 生成见 D4;unique 冲突重试 3 次后 500

`InviteCode` wire shape:

```json
{
  "id": "uuid",
  "coach_id": "uuid",
  "code": "XK7MPQ2RVT",
  "type": "personal_permanent",
  "max_uses": null,
  "used_count": 23,
  "expires_at": null,
  "revoked_at": null,
  "label": null,
  "created_at": "2026-06-11T08:00:00.000Z"
}
```

`DELETE /coach/invite-codes/:id`:非本教练的码 → `404 INVITE_CODE_NOT_FOUND`(不泄露存在性)。

#### B. 绑定状态机(挂载 `/bind-requests` + `/coach`)

| Method + Path                          | Roles   | Request                             | Success                                                 |
| -------------------------------------- | ------- | ----------------------------------- | ------------------------------------------------------- |
| `POST /bind-requests`                  | student | `{ code, display_name }`            | `201 BindRequest`                                       |
| `GET /bind-requests/mine`              | student | —                                   | `200 { bind_request: BindRequest \| null }`             |
| `DELETE /bind-requests/:id`            | student | —                                   | `204`(own + pending → cancelled)                        |
| `GET /coach/bind-requests`             | coach   | —                                   | `200 { bind_requests: CoachBindRequestItem[] }`         |
| `POST /coach/bind-requests/:id/accept` | coach   | `{ skip_evaluation, skip_reason? }` | `200 { bind_request, evaluation_period: Eval \| null }` |
| `POST /coach/bind-requests/:id/reject` | coach   | `{}`(空 body)                       | `200 { bind_request }`                                  |

`POST /bind-requests` 事务步骤(顺序即权威——**全部 guard 在任何消费性写入之前**,already-bound 不烧 use 次数):

1. 惰性过期本学员 stale pending(D7)
2. 仍有 pending → `409 BIND_REQUEST_ALREADY_PENDING`
3. code `upper()` 归一化 → 轻量 SELECT 解析 coach_id;无行 → `400 INVITE_CODE_INVALID`
4. 同对 (student, coach) 已 accepted → `409 BIND_ALREADY_BOUND`
5. 原子 redeem UPDATE guard(D5;校验 `revoked_at IS NULL` + `expires_at IS NULL OR expires_at > now()` + uses guard,一条 UPDATE 完成)→ 无行返回 `400 INVITE_CODE_INVALID`(不区分失效原因,防枚举)
6. **upsert `student_profiles`**(D1):`INSERT … ON CONFLICT (user_id) DO UPDATE SET display_name, updated_at = now()`
7. insert `bind_requests`:`status='pending'`,`expired_at = now() + interval '7 days'`(NOT NULL),`invite_code_id` 记账

`display_name`:`z.string().trim().min(1).max(100)`。

`BindRequest` wire shape(学员侧):

```json
{
  "id": "uuid",
  "student_id": "uuid",
  "coach_id": "uuid",
  "coach_display_name": "David(内测教练)",
  "invite_code_id": "uuid",
  "status": "pending",
  "submitted_at": "2026-06-11T08:00:00.000Z",
  "responded_at": null,
  "expired_at": "2026-06-18T08:00:00.000Z",
  "skip_evaluation": false,
  "skip_reason": null
}
```

`coach_display_name` 来自 `coach_profiles` left join(无行 → null)— 学员"等待教练 X 接收"页用。

`GET /bind-requests/mine`:先惰性过期,返回该学员 `submitted_at DESC` 最新一条(含历史 accepted/rejected/expired/cancelled);从未发过 → `200 { bind_request: null }`。

`DELETE /bind-requests/:id`:非本人/不存在 → `404 BIND_REQUEST_NOT_FOUND`;惰性过期后非 pending → `409 BIND_REQUEST_NOT_PENDING`;成功 → `status='cancelled'`(`responded_at` 保持 null,cancel 不是教练响应)。

`GET /coach/bind-requests`(接收队列):先惰性过期本教练名下 stale pending,返回 pending 队列(`submitted_at ASC`,先来先审),每项含 wiki §3.2 摘要 9 项(onboarding 未完成的字段返 null):

```json
{
  "bind_requests": [
    {
      "id": "uuid",
      "student_id": "uuid",
      "display_name": "张三",
      "submitted_at": "2026-06-11T08:00:00.000Z",
      "expired_at": "2026-06-18T08:00:00.000Z",
      "onboarding": {
        "completed": true,
        "gender": "male",
        "birth_date": "2001-03-12",
        "weight_kg": "83.00",
        "training_years": 3,
        "squat_1rm_kg": "180.00",
        "bench_1rm_kg": "120.00",
        "deadlift_1rm_kg": "220.00",
        "muscle_groups_to_strengthen": ["quad", "hamstring", "shoulder"],
        "gym_tier": "commercial",
        "is_competing": true,
        "competition_date": "2026-07-25",
        "note_to_coach": "想突破 200kg 深蹲",
        "upload_count": 4
      }
    }
  ]
}
```

(9 项映射:①姓名=display_name+性别+生日+体重 ②训练年限 ③三大项 1RM ④想增强肌群 ⑤gym_tier ⑥备赛/比赛日期 ⑦备注 ⑧upload_count ⑨已等待时长=客户端由 submitted_at 算。onboarding 行不存在 → `"onboarding": { "completed": false, …全 null, "upload_count": 0 }`。)

`POST /coach/bind-requests/:id/accept` body:

```ts
z.object({
  skip_evaluation: z.boolean(),
  skip_reason: z.string().trim().min(1).max(500).nullable().optional(),
}).strict();
// superRefine: skip_reason 仅当 skip_evaluation=true 时允许携带
```

事务:select 本教练该行 → 不存在/非本教练 `404 BIND_REQUEST_NOT_FOUND`;pending 但已过 expired_at → 翻 expired + `409 BIND_REQUEST_EXPIRED`;非 pending → `409 BIND_REQUEST_NOT_PENDING`;否则 `status='accepted', responded_at=now(), skip_evaluation, skip_reason`;`skip_evaluation=false` → insert `evaluation_periods` (`started_at=now()`, `expected_end_at=now() + interval '7 days'`)。partial unique 冲突(同对已有 accepted / 已有 active 评估期)→ `409 BIND_ALREADY_BOUND`。

`POST /coach/bind-requests/:id/reject`:同 select/状态校验;`status='rejected', responded_at=now()`。silent(D18)。

#### C. 评估期(挂载 `/coach` + `/students`)

| Method + Path                          | Roles       | Request | Success                           |
| -------------------------------------- | ----------- | ------- | --------------------------------- |
| `GET /coach/students/:id/evaluation`   | coach       | —       | `200 EvaluationPeriod`            |
| `GET /students/me/evaluation`          | any student | —       | `200 EvaluationPeriod`            |
| `POST /coach/evaluations/:id/complete` | coach       | —       | `200 EvaluationPeriod`(completed) |

`EvaluationPeriod` wire shape:

```json
{
  "id": "uuid",
  "student_id": "uuid",
  "coach_id": "uuid",
  "bind_request_id": "uuid",
  "started_at": "2026-06-11T08:00:00.000Z",
  "expected_end_at": "2026-06-18T08:00:00.000Z",
  "completed_at": null,
  "completion_type": null,
  "in_progress": true,
  "overdue": false
}
```

`in_progress = completed_at IS NULL`;`overdue = in_progress && now() > expected_end_at`(读时计算,**到期不自动完成**,D7)。剩余时间由 iOS 用 `expected_end_at` 算。

- coach 视角:该 (coach=me, student=:id) 对**最新**一条(`started_at DESC`,含已完成);无 → `404 EVALUATION_NOT_FOUND`
- student 视角:本学员最新一条(跨教练取最新);无 → `404 EVALUATION_NOT_FOUND`
- `complete`:`UPDATE … SET completed_at=now(), completion_type='coach_completed' WHERE id AND coach_id=me AND completed_at IS NULL`;行不存在/非本教练 → `404 EVALUATION_NOT_FOUND`;已完成 → `409 EVALUATION_ALREADY_COMPLETED`

**publish 真 gate(改 `POST /plans/:id/publish`)**:publish 事务内,状态/完整性校验通过后:

```sql
SELECT 1 FROM evaluation_periods
 WHERE coach_id = $me AND student_id = $plan.trainee_id AND completed_at IS NULL LIMIT 1;
```

有行且 NOT (`plan.kind='adaptation' AND plan_weeks=1`) → `403 { "error": "EVALUATION_IN_PROGRESS" }`。评估期内只放行 1 周 adaptation;评估完成后 regular 恢复。

**plans API 增量**:`POST /plans` body 加 `kind: z.enum(['regular','adaptation']).optional()`(缺省 `'regular'`);zod superRefine `kind='adaptation' → plan_weeks=1`;`PATCH /plans/:id` **不可改 kind**(D9);`toPlan` 响应加 `kind` 字段。

#### D. 评估总结(挂载 `/coach` + `/students`)

| Method + Path                                | Roles                      | Request                                                                    | Success                 |
| -------------------------------------------- | -------------------------- | -------------------------------------------------------------------------- | ----------------------- |
| `PUT /coach/students/:id/evaluation-summary` | coach(accepted bond)       | `{ overall_assessment, training_plan, words_to_student?, notify_student }` | `200 EvaluationSummary` |
| `GET /students/:id/evaluation-summary`       | student(self)/ bound coach | —                                                                          | `200 EvaluationSummary` |

`PUT` body:

```ts
z.object({
  overall_assessment: z.string().trim().min(1).max(10000),
  training_plan: z.string().trim().min(1).max(10000),
  words_to_student: z.string().trim().min(1).max(10000).nullable().optional(),
  notify_student: z.boolean(),
}).strict();
```

语义(事务):无 accepted bond → `403 AUTHORIZATION_FORBIDDEN`;upsert `student_evaluations`(ON CONFLICT `(student_id, coach_id)`:更新 3 字段 + `last_updated_at=now()`,`first_saved_at` / `evaluation_period_id` 不动);首插时 `evaluation_period_id` = 该对最新评估期 id(无 → NULL,跳过评估期场景,D10);insert version 快照行(`notified_student = body.notify_student`)。

`EvaluationSummary` wire shape:

```json
{
  "id": "uuid",
  "student_id": "uuid",
  "coach_id": "uuid",
  "evaluation_period_id": "uuid",
  "overall_assessment": "…",
  "training_plan": "…",
  "words_to_student": null,
  "first_saved_at": "2026-06-18T08:00:00.000Z",
  "last_updated_at": "2026-06-18T08:00:00.000Z",
  "is_active": true
}
```

`GET /students/:id/evaluation-summary` 授权:self(任一学员角色)→ 返回本人最新(`last_updated_at DESC`,多教练场景取最新 active);coach → 只返回**自己写的**那行(多 coach 泄露防护,003 §Risks 8 同源);其他 → `403 AUTHORIZATION_FORBIDDEN`。无行 → `404 EVALUATION_SUMMARY_NOT_FOUND`。

#### E. 学员 onboarding 档案(挂载 `/students` + `/coach`)

| Method + Path                           | Roles                                        | Request                                                         | Success                                                           |
| --------------------------------------- | -------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| `PUT /students/me/onboarding`           | any student                                  | 部分字段(分步可重入)                                            | `200 OnboardingProfile`                                           |
| `POST /students/me/onboarding/complete` | any student                                  | —                                                               | `200 OnboardingProfile`                                           |
| `GET /students/:id/onboarding`          | self / bound coach / live-pending coach(D16) | —                                                               | `200 OnboardingProfile`                                           |
| `PUT /coach/students/:id/one-rm`        | coach(accepted bond)                         | `{ squat_1rm_kg?, bench_1rm_kg?, deadlift_1rm_kg? }`(至少 1 个) | `200 { squat_1rm_kg, bench_1rm_kg, deadlift_1rm_kg, updated_at }` |

`PUT /students/me/onboarding`:

- body = 29 字段全 optional 的 `.strict()` schema(词表/范围校验见 §migrations 列注 + D11/D12/D15);产品选填字段(`bench_grip` `equipment_overrides` `muscle_groups_to_strengthen` `injury_notes` `injury_areas` `competition_date` `target_weight_class` `note_to_coach` `label` 类)额外 `.nullable()` 支持清空
- 空 body(`{}`)→ 合法 no-op upsert(建行)
- **1RM 锁(真 gate)**:行已 `completed_at IS NOT NULL` 且 body 含 `squat_1rm_kg` / `bench_1rm_kg` / `deadlift_1rm_kg` 任一 key → `403 ONE_RM_LOCKED`(其余字段正常可改;Type B/C/D 分级推送是 iOS 侧语义,backend V0.1b 不区分)
- `upload_attachment_ids: UUID[]`(≤20,去重)→ 全量替换 `onboarding_uploads`(D17)
- upsert:`INSERT … ON CONFLICT (user_id) DO UPDATE SET <仅提交字段> , updated_at = now()`

`POST /students/me/onboarding/complete`:

- 服务端必填校验(wiki 7 步必填项):`unit_preference` `gender` `birth_date` `height_cm` `weight_kg` `training_years` `squat_stance` `deadlift_style` `squat_1rm_kg` `bench_1rm_kg` `deadlift_1rm_kg` `training_days` `gym_tier` `daily_life_intensity` `life_stress` `recovery_speed` `sleep_hours` `is_competing` + (`is_competing=true` → `competition_date`)
- 缺项 → `422 { "error": "ONBOARDING_INCOMPLETE", "missing_fields": [...] }`;行不存在 → 同 422(全缺)
- 已完成 → 幂等返回 200(`completed_at` 不刷新)

`OnboardingProfile` wire shape:29 列全量(snake_case;NUMERIC 字符串;DATE 字符串;数组原样)+ `completed_at` + `created_at` + `updated_at` + `upload_attachment_ids: string[]`。行不存在时 `GET` → `404 ONBOARDING_NOT_FOUND`。

`GET /students/:id/onboarding` 授权(D16):`req.user.id === :id`(任一学员角色)/ coach 且 (accepted bond OR (pending bind_request AND `expired_at > now()`))→ 放行;否则 `403 AUTHORIZATION_FORBIDDEN`。

`PUT /coach/students/:id/one-rm`:无 accepted bond → `403 AUTHORIZATION_FORBIDDEN`;upsert 行(行不存在则建,只含提交的 1RM 字段)— 教练是 1RM 的唯一权威修改方(锁定后),不受 `completed_at` 限制。

### 错误码增量

| Code                           | HTTP | 含义                                                   |
| ------------------------------ | ---- | ------------------------------------------------------ |
| `INVITE_CODE_INVALID`          | 400  | code 不存在/已 revoke/已过期/次数用尽(统一,防枚举)     |
| `INVITE_CODE_NOT_FOUND`        | 404  | revoke 目标不存在或非本教练                            |
| `BIND_REQUEST_ALREADY_PENDING` | 409  | 学员已有 pending 请求                                  |
| `BIND_ALREADY_BOUND`           | 409  | 同对 (student, coach) 已是 accepted bond               |
| `BIND_REQUEST_NOT_FOUND`       | 404  | 请求不存在或不属于调用方                               |
| `BIND_REQUEST_NOT_PENDING`     | 409  | accept/reject/cancel 目标已非 pending                  |
| `BIND_REQUEST_EXPIRED`         | 409  | 目标 pending 但已过 expired_at(本次请求顺手翻 expired) |
| `EVALUATION_NOT_FOUND`         | 404  | 无评估期记录 / complete 目标不存在或非本教练           |
| `EVALUATION_ALREADY_COMPLETED` | 409  | complete 目标已完成                                    |
| `EVALUATION_IN_PROGRESS`       | 403  | publish 真 gate:评估期内禁发非 1 周 adaptation 计划    |
| `EVALUATION_SUMMARY_NOT_FOUND` | 404  | 无评估总结                                             |
| `ONBOARDING_NOT_FOUND`         | 404  | onboarding 档案行不存在                                |
| `ONBOARDING_INCOMPLETE`        | 422  | complete 必填缺项(带 `missing_fields`)                 |
| `ONE_RM_LOCKED`                | 403  | onboarding 完成后学员改 1RM                            |

`VALIDATION_ERROR`(400)/ `AUTHORIZATION_FORBIDDEN`(403)/ `AUTH_INVALID_TOKEN`(401)沿用 001/002。

### File layout

```
db/migrations/
  0008-init-invite-codes.sql … 0013-init-onboarding-profiles.sql   # NEW ×6
src/
  db/
    types.ts            # 扩展:PlansTable.kind + 6 新表 interface + 词表 const
    bonds.ts            # NEW:hasAcceptedBond / hasOnboardingReadAccess(planOwnership.ts 同款模式)
  handlers/
    invite-codes.ts     # NEW
    bind-requests.ts    # NEW(学员侧 + 惰性过期 helper)
    coach-bind-requests.ts  # NEW(队列/accept/reject)
    evaluations.ts      # NEW(评估期查询/complete)
    evaluation-summary.ts   # NEW
    onboarding.ts       # NEW(upsert/complete/fetch/one-rm)
  routes/
    invite-codes.ts     # NEW: coachInviteCodesRouter
    bind-requests.ts    # NEW: studentBindRequestsRouter + coachBindRequestsRouter
    evaluations.ts      # NEW: coachEvaluationsRouter + studentEvaluationsRouter
    onboarding.ts       # NEW: studentOnboardingRouter + coachOneRmRouter
    plans/index.ts      # MODIFIED: publish 真 gate
    plans/schemas.ts    # MODIFIED: kind 字段
    plans/serialization.ts # MODIFIED: kind 字段
    index.ts            # MODIFIED: 挂载新 router
tests/
  helpers/bindEval.ts   # NEW:本 spec 专用 fixture(独立于 studentActions,学员无预置 bond)
  helpers/migrations.ts # MODIFIED:注册 array_length(pg-mem 无内建)
  helpers/studentActions.ts # MODIFIED:schema 加 plans.kind 等新列(向后兼容)
  invite-codes.test.ts / bind-requests.test.ts / coach-bind-requests.test.ts /
  evaluations.test.ts / evaluation-summary.test.ts / onboarding.test.ts   # NEW ×6
  migrations/0008…0013 ×6  # NEW
```

### 测试矩阵

| 域              | 必测路径                                                                                                                                                                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 邀请码          | personal 生成自动 revoke 旧码;single_use 用尽后 redeem 拒;time_limited 过期拒;revoked 拒;列表含 used_count;revoke 幂等;非 coach 403;code 字母表无易混字符                                                                                                                           |
| 绑定状态机      | pending→accepted(skip=false 建评估期 / skip=true 不建+skip_reason);pending→rejected;pending→cancelled;惰性 expired(mine / 队列 / accept 三路径);重复 pending 409;同对重复 accept 409;display_name upsert 兜底(无 profile 行学员发请求后 `/coach/students` 花名册可见);used_count +1 |
| 接收队列        | 摘要 9 项字段;onboarding 未完成全 null + completed=false;upload_count;非本教练请求 404                                                                                                                                                                                              |
| publish 真 gate | 评估期内 regular 4 周 → 403 EVALUATION_IN_PROGRESS;评估期内 adaptation 1 周 → 200;complete 评估期后 regular → 200;无评估期 regular → 200;adaptation+plan_weeks=4 创建被 zod 拒                                                                                                      |
| 评估期          | coach/student 双视角读;overdue 读时计算(过期未完成仍 in_progress + overdue=true);complete 幂等冲突 409;非本教练 404                                                                                                                                                                 |
| 评估总结        | 首存(first_saved_at + version1 + notified);二存(first_saved_at 不变 + version2);学员 self 读;bound coach 读自己那行;陌生 coach 403;无 bond PUT 403                                                                                                                                  |
| onboarding      | 分步可重入(两次 PUT 合并);空 body 建行;complete 缺项 422 列 missing_fields;complete 幂等;1RM 锁(完成后 PUT 1RM 403 / 其他字段仍可改);coach one-rm 端点改锁定值;授权矩阵(self ✓ / bound coach ✓ / live-pending coach ✓ / 陌生 coach 403 / 其他学员 403);uploads 全量替换             |
| migrations      | 0008 唯一活跃 personal partial index;0009 列存在 + SET NULL;0010 adaptation→1 周 CHECK;0011 active 唯一 + completion 一致性 CHECK;0012 (student,coach) 唯一 + version cascade;0013 muscle_groups ≤3 CHECK + uploads 复合 PK + cascade                                               |
| DTO             | 新端点拒 camelCase 输入;响应 snake_case;NUMERIC 字符串往返                                                                                                                                                                                                                          |

### 不做什么(防漂移)

- APNs / cron(全惰性;48h 再推是推送概念,V0.1b 无推送 → 不存在)
- 评估总结 markdown(纯文本)
- batch 接收 / spam 防护(office hours 决议移除)
- "教练已查看 x/y" view tracking(V0.1b 显示资料计数)
- 自练角色绑定路径(self_train 不发 bind request)
- `onboarding_uploads.attachment_id` FK(等 spec 004 attachments,集成 spec 收口)
- 学员端 Type B/C/D 修改分级推送(iOS 侧语义)
- e1RM 历史 / PR 推送(iOS spec 028 已落,backend 无增量)

### 实装注记:pg-mem 三个已知偏差(测试层 workaround)

单测跑在 pg-mem(per repo 既有测试基建),实装中发现 3 个 pg-mem 与真 PG 的行为差异,处理方式如下(真 PG 行为已在本地 PG 17 容器逐条 smoke 验证):

1. **partial index 污染普通查询**:pg-mem 会用 partial unique index 服务普通 `WHERE coach_id = ?` 查询,导致 predicate 外的行"消失"。→ 端点测试 fixture(`tests/helpers/bindEval.ts`)**省略**三个 partial unique index;约束本身由 migration 测试(0008/0011 跑真 SQL 文件)覆盖。
2. **事务 rollback 无效**:pg-mem 经 pg adapter 的 kysely 事务 ROLLBACK 是 no-op。→ `POST /bind-requests` 实装为 **guards-before-mutation** 顺序(本身也是更优语义:already-bound 不烧 use 次数);其余依赖 rollback 的路径(accept 撞 unique)在真 PG 下正确。
3. **CHECK 中 NULL 判违例**:pg-mem 把 `CHECK (col IN (...))` 的 NULL 当违例(真 PG NULL 通过)。→ 0011/0013 所有 enum CHECK 显式加 `col IS NULL OR` 前缀(真 PG 语义不变,更显式)。

另:`array_length` 在 pg-mem 无内建,测试 helper 注册了实现;NUMERIC/DATE 列 pg-mem 返回 number/Date(真 pg 返回 string),serializer 统一走 `decimal()` / `dateOnly()` 归一化(沿用 003 的 `toFixed` 先例)。

## 修订记录

| 日期       | 修订                      |
| ---------- | ------------------------- |
| 2026-06-11 | 初稿 + 实装(同 PR,Claude) |
