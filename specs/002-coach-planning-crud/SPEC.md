# 002-coach-planning-crud

**Status:** InProgress
**Date:** 2026-04-28

## Goal

Land coach-side training-plan editing on the backend: REST endpoints for creating and editing the four-level plan tree (`plans` → `plan_days` → `plan_exercises` → `plan_sets`), the exercise catalog (`exercises`) those plans reference, plus a publish step that flips a draft plan to `published` and fires a (stubbed) student-notification hook. Ships migrations `0002-init-exercises.sql` and `0003-init-plans.sql`. Real-time sync, progression rules, week templates, and Aliyun deployment are explicitly deferred.

The wire shape of every entity must round-trip 1:1 with the iOS Codable types in [`apps/MeetPR/specs/004-core-models-training-plan/SPEC.md`](~/Projects/apps/MeetPR/specs/004-core-models-training-plan/SPEC.md). `Decimal` columns are emitted as JSON strings (`"180.5"`), not numbers — this matches the iOS `MeetPRCodec` Decimal-as-string convention and is how `pg` serializes `NUMERIC` by default; do not coerce.

Refs: [data-model.md v1.1 §1.4 (Exercise) + §1.8 (TrainingPlan / PlanDay / PlanExercise / PlanSet)](~/Brain/wiki/projects/MeetPR/data-model.md) · [ADR 003 v4](~/Brain/wiki/projects/MeetPR/decisions/003-dual-end-native-architecture.md) (single role per user, V1) · [ADR 004](~/Brain/wiki/projects/MeetPR/decisions/004-backend-selection.md) (no ORM, hand-managed SQL, REST + JSON, ≤30s polling SLA — no WebSocket V1) · upstream [001-auth](../001-auth/SPEC.md) (JWT `requireAuth` middleware reused as-is).

## Scope

### Endpoints

All endpoints sit under `/plans`, `/exercises`, or `/students/:studentId/plans`, all require a Bearer access JWT, and all share the error envelope from [CLAUDE.md](../../CLAUDE.md) (`{ "error": "<MACHINE_CODE>", ... }`). Codes are catalogued in [§ Error envelope](#error-envelope) below.

#### Plans (top-level)

| Method + Path                    | Roles                                                                                                          | Request body                                                                                                                                                                                                                                                      | Success                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `POST /plans`                    | coach                                                                                                          | `{ trainee_id, name, start_date, end_date, plan_weeks, source, source_template_id? }`                                                                                                                                                                             | `201 Plan` (no children)              |
| `GET /plans/:id`                 | coach (owner) · student (owner trainee, only if `status='published'`)                                          | —                                                                                                                                                                                                                                                                 | `200 PlanWithChildren`                |
| `PATCH /plans/:id`               | coach (owner)                                                                                                  | any subset of `{ name, start_date, end_date, plan_weeks, status, source_template_id }`. `status` may only transition `published → paused`, `paused → published`, or `published → completed`. `draft → published` happens via `POST /plans/:id/publish`, not here. | `200 Plan`                            |
| `POST /plans/:id/publish`        | coach (owner)                                                                                                  | —                                                                                                                                                                                                                                                                 | `200 Plan`                            |
| `GET /students/:studentId/plans` | coach (must be each plan's coach) · student (only when `studentId === req.user.id`, only `status='published'`) | query: `?status=draft\|published\|completed\|paused` (optional, repeat to OR; default = no filter for coach, forced `published` for student)                                                                                                                      | `200 { plans: Plan[] }` (no children) |

#### Plan structure (nested under `/plans`)

All eight routes below are coach-only. Path-level ownership: the coach must own the root plan reached via the parent chain (`set → exercise → day → plan`).

| Method + Path                            | Request body                                                                                         | Success            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------ |
| `POST /plans/:id/days`                   | `{ day_of_week, week_number, sort_order }`                                                           | `201 PlanDay`      |
| `PATCH /plans/days/:dayId`               | any subset of `{ day_of_week, week_number, sort_order }`                                             | `200 PlanDay`      |
| `DELETE /plans/days/:dayId`              | —                                                                                                    | `204` (cascades)   |
| `POST /plans/days/:dayId/exercises`      | `{ exercise_id, is_main_lift, sort_order, notes? }`                                                  | `201 PlanExercise` |
| `PATCH /plans/exercises/:exerciseId`     | any subset of `{ exercise_id, is_main_lift, sort_order, notes }`                                     | `200 PlanExercise` |
| `DELETE /plans/exercises/:exerciseId`    | —                                                                                                    | `204` (cascades)   |
| `POST /plans/exercises/:exerciseId/sets` | `{ set_number, target_reps, target_reps_max?, intensity_mode, target_value, set_type }`              | `201 PlanSet`      |
| `PATCH /plans/sets/:setId`               | any subset of `{ set_number, target_reps, target_reps_max, intensity_mode, target_value, set_type }` | `200 PlanSet`      |
| `DELETE /plans/sets/:setId`              | —                                                                                                    | `204`              |

> `target_reps_max` accepts `null` in PATCH bodies (explicitly clears a range back to a precise rep target). Omitting the key leaves it untouched. Same convention for `notes`, `source_template_id`.

#### Exercise catalog

| Method + Path     | Roles      | Request / query                                                                                                                                                                             | Success                         |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `GET /exercises`  | any auth'd | query (all optional, csv = OR within facet, AND across facets): `?muscle_group=quad,glute&equipment=barbell&movement_pattern=push&exercise_type=main_lift,accessory&main_lift_family=squat` | `200 { exercises: Exercise[] }` |
| `POST /exercises` | coach      | `{ name, exercise_type, main_lift_family?, is_competition_lift, muscle_groups, equipment, movement_pattern }`                                                                               | `201 Exercise`                  |

Visibility rule for both routes:

- **Coach**: `created_by_coach_id IS NULL` (system-seeded) **OR** `created_by_coach_id = req.user.id` (own customs). A coach never sees another coach's customs, even via direct ID lookup (deferred — V1 has no per-exercise GET).
- **Student** (`GET /exercises` only — `POST` is coach-only): `created_by_coach_id IS NULL` (system-seeded) **OR** the exercise is referenced in a `plan_exercises` row whose ancestor `plans.trainee_id = req.user.id` AND `plans.status = 'published'` (i.e. the student's coach put a custom exercise into their published plan). Implementation:

  ```sql
  WHERE created_by_coach_id IS NULL
     OR id IN (
       SELECT pe.exercise_id
         FROM plan_exercises pe
         JOIN plan_days pd ON pe.plan_day_id = pd.id
         JOIN plans p      ON pd.plan_id     = p.id
        WHERE p.trainee_id = $userId
          AND p.status     = 'published'
     )
  ```

  Without this, students would receive `exercise_id` UUIDs in their published plans that they cannot resolve via `GET /exercises` (P2 #3 review finding 2026-04-28).

### Authorization

Two new middleware helpers, both in `src/middleware/auth.ts`:

```ts
export function requireRole(...allowed: AccessTokenPayload['role'][]): RequestHandler;
//  -> 403 AUTHORIZATION_FORBIDDEN if req.user.role is not in `allowed`. Assumes requireAuth already ran.
```

Usage in routers:

```ts
router.post('/', requireAuth, requireRole('coach'), createPlanHandler);
router.post('/:id/publish', requireAuth, requireRole('coach'), publishPlanHandler);
```

`req.user` is populated by the existing `requireAuth` from spec 001 — no changes to it.

**Ownership checks** are SQL-level, not middleware-level — the existence vs forbidden distinction is intentionally collapsed into 404 for coach paths to avoid leaking plan IDs across coaches:

| Path                                       | Owner SQL predicate                                                                                                                                     | If no row matches                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /plans/:id` (coach)                   | `id = $1 AND coach_id = $userId`                                                                                                                        | `404 PLAN_NOT_FOUND`                                                                                              |
| `GET /plans/:id` (student)                 | `id = $1 AND trainee_id = $userId AND status = 'published'`                                                                                             | `404 PLAN_NOT_FOUND`                                                                                              |
| `PATCH /plans/:id` (coach)                 | `id = $1 AND coach_id = $userId` (`SELECT ... FOR UPDATE` then UPDATE)                                                                                  | `404 PLAN_NOT_FOUND`                                                                                              |
| `POST /plans/:id/publish` (coach)          | `id = $1 AND coach_id = $userId` (single `SELECT id, coach_id, status FROM plans WHERE id = $1 FOR UPDATE`, then branch in app code per § Publish flow) | `404 PLAN_NOT_FOUND` if no row / coach_id mismatch; `409 PLAN_NOT_DRAFT` if owner matches but `status <> 'draft'` |
| `POST /plans/:id/days` (coach)             | `EXISTS (SELECT 1 FROM plans WHERE id = $1 AND coach_id = $userId)`                                                                                     | `404 PLAN_NOT_FOUND`                                                                                              |
| `PATCH /plans/days/:dayId` (coach)         | join `plan_days` → `plans`; require `plans.coach_id = $userId`                                                                                          | `404 PLAN_DAY_NOT_FOUND`                                                                                          |
| `DELETE /plans/days/:dayId` (coach)        | same as PATCH                                                                                                                                           | `404 PLAN_DAY_NOT_FOUND`                                                                                          |
| `POST /plans/days/:dayId/exercises`        | join `plan_days` → `plans`; require `plans.coach_id = $userId`                                                                                          | `404 PLAN_DAY_NOT_FOUND`                                                                                          |
| `PATCH /plans/exercises/:exerciseId`       | join `plan_exercises` → `plan_days` → `plans`                                                                                                           | `404 PLAN_EXERCISE_NOT_FOUND`                                                                                     |
| `DELETE /plans/exercises/:exerciseId`      | same                                                                                                                                                    | `404 PLAN_EXERCISE_NOT_FOUND`                                                                                     |
| `POST /plans/exercises/:exerciseId/sets`   | same                                                                                                                                                    | `404 PLAN_EXERCISE_NOT_FOUND`                                                                                     |
| `PATCH /plans/sets/:setId`                 | join `plan_sets` → `plan_exercises` → `plan_days` → `plans`                                                                                             | `404 PLAN_SET_NOT_FOUND`                                                                                          |
| `DELETE /plans/sets/:setId`                | same                                                                                                                                                    | `404 PLAN_SET_NOT_FOUND`                                                                                          |
| `GET /students/:studentId/plans` (coach)   | `coach_id = $userId AND trainee_id = $studentId`                                                                                                        | empty `{ plans: [] }`                                                                                             |
| `GET /students/:studentId/plans` (student) | `trainee_id = $userId AND $studentId = $userId AND status = 'published'`; if `$studentId !== $userId` short-circuit `403`                               | `403 AUTHORIZATION_FORBIDDEN` (other student's data)                                                              |

The ownership-chain helpers go in `src/db/planOwnership.ts` — three small functions returning the resolved `plan_id` (or `null`) so handlers can decide between 404 and 403:

```ts
export async function planIdForDay(db, dayId, coachId): Promise<string | null>;
export async function planIdForExercise(db, exerciseId, coachId): Promise<string | null>;
export async function planIdForSet(db, setId, coachId): Promise<string | null>;
```

Each is a single Kysely query with two-or-three-table inner joins; mark them `for: 'no key update'` inside the mutation transactions to serialize concurrent writers on the same plan.

### Validation (zod)

Schemas live in `src/routes/plans/schemas.ts` and `src/routes/exercises/schemas.ts`. Failures map uniformly to `400 VALIDATION_ERROR { issues: [{ path, message }] }` — no leaked zod codes / received values, same as spec 001.

Shared field rules:

| Field                     | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` (path / FK)          | `z.string().uuid()`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `name`                    | `z.string().trim().min(1).max(120)`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `start_date` / `end_date` | `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)` (ISO-8601 calendar date; pg DATE column round-trips as `'YYYY-MM-DD'` per [src/db/pool.ts](../../src/db/pool.ts) OID-1082 parser). **Cross-field on `POST /plans` and `PATCH /plans/:id`**: if both `start_date` and `end_date` are present in the request body, require `end_date >= start_date`. Failure → `400 VALIDATION_ERROR` (envelope-uniform with the other cross-field issues, not a DB CHECK violation). |
| `plan_weeks`              | `z.union([z.literal(1), z.literal(4)])`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `source`                  | `z.enum(['coach', 'template'])` (V1 — `algorithm` is V2 schema-only and rejected at the API)                                                                                                                                                                                                                                                                                                                                                                  |
| `source_template_id`      | `z.string().uuid().nullable().optional()` (must be `null` unless `source === 'template'`; cross-field check)                                                                                                                                                                                                                                                                                                                                                  |
| `status` (PATCH only)     | `z.enum(['published', 'paused', 'completed'])` — `draft` is not settable from PATCH                                                                                                                                                                                                                                                                                                                                                                           |
| `day_of_week`             | `z.number().int().min(1).max(7)` (ISO-8601: 1 = Monday)                                                                                                                                                                                                                                                                                                                                                                                                       |
| `week_number`             | `z.number().int().min(1).max(4)`                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `sort_order`              | `z.number().int().min(0)`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `set_number`              | `z.number().int().min(1)`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `target_reps`             | `z.number().int().min(1).max(50)`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `target_reps_max`         | `z.number().int().min(1).max(50).nullable().optional()`; cross-field check `target_reps_max === null \|\| target_reps_max >= target_reps`                                                                                                                                                                                                                                                                                                                     |
| `intensity_mode`          | `z.enum(['weight', 'rpe'])`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `target_value`            | accept either string or number; coerce to a `string` matching `^\d+(\.\d{1,2})?$` (max 2 decimal places — `NUMERIC(6,2)` would silently truncate `"180.555"` to `"180.56"` causing round-trip mismatch; reject extra precision up-front); cross-field check: `intensity_mode === 'rpe'` ⇒ value ∈ `[1.0, 10.0]`; `intensity_mode === 'weight'` ⇒ value `> 0` and `< 1000` (kg); persisted as `NUMERIC(6,2)`                                                   |
| `set_type`                | `z.enum(['warmup', 'working', 'failed', 'amrap', 'backoff'])`                                                                                                                                                                                                                                                                                                                                                                                                 |
| `is_main_lift`            | `z.boolean()`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `notes`                   | `z.string().max(500).nullable().optional()`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `exercise_id`             | `z.string().uuid()` — must reference a row visible to the caller (system-seeded or own custom). On miss → `400 EXERCISE_NOT_FOUND_OR_HIDDEN` (re-using `400` keeps the failure inside the body-validation envelope; caller can't disambiguate from a coach's other-coach custom)                                                                                                                                                                              |
| `exercise_type`           | `z.enum(['main_lift', 'main_lift_variation', 'accessory'])`                                                                                                                                                                                                                                                                                                                                                                                                   |
| `main_lift_family`        | `z.enum(['squat', 'bench', 'deadlift']).nullable().optional()`; cross-field: `accessory` ⇒ must be `null`; `main_lift` / `main_lift_variation` ⇒ must be set                                                                                                                                                                                                                                                                                                  |
| `is_competition_lift`     | `z.boolean()`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `muscle_groups`           | `z.array(z.enum([...9 values...])).min(1).max(9)`                                                                                                                                                                                                                                                                                                                                                                                                             |
| `equipment`               | `z.array(z.enum(['barbell', 'dumbbell', 'machine', 'bodyweight'])).min(1).max(4)`                                                                                                                                                                                                                                                                                                                                                                             |
| `movement_pattern`        | `z.array(z.enum(['push', 'pull'])).max(2)` (may be empty for accessories with no clear pattern)                                                                                                                                                                                                                                                                                                                                                               |

**Trainee-existence check (POST /plans body):** the handler verifies `trainee_id` references a `users` row with `role IN ('coached_student', 'self_train_student')` after schema parse. On miss → `400 TRAINEE_NOT_FOUND`. **Bind-relationship enforcement** (coach → trainee must have an `accepted` BindRequest) is **not** in this spec — `bind_requests` table doesn't exist yet. Add to FOLLOWUPS (see [§ Follow-ups](#follow-ups)). Until then iOS-side UX prevents picking unbound trainees.

### Token requirements

All routes use the existing `requireAuth` from spec 001. No new claims, no new secrets. `req.user` is `{ id, role }`. Refresh-token rotation is unrelated to plan editing — the access token is the only thing checked here.

### Migration `db/migrations/0002-init-exercises.sql`

```sql
-- Migration 0002: exercise catalog (system-seeded + coach customs).
-- Spec: specs/002-coach-planning-crud/SPEC.md
-- Source: data-model.md v1.1 §1.4
-- ADR: 004 (no ORM, hand-managed SQL).

BEGIN;

CREATE TABLE exercises (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     TEXT         NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  exercise_type            TEXT         NOT NULL,
  main_lift_family         TEXT,
  is_competition_lift      BOOLEAN      NOT NULL DEFAULT FALSE,
  muscle_groups            TEXT[]       NOT NULL,
  equipment                TEXT[]       NOT NULL,
  movement_pattern         TEXT[]       NOT NULL DEFAULT '{}',
  created_by_coach_id      UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT exercises_exercise_type_check
    CHECK (exercise_type IN ('main_lift', 'main_lift_variation', 'accessory')),
  CONSTRAINT exercises_main_lift_family_check
    CHECK (main_lift_family IS NULL OR main_lift_family IN ('squat', 'bench', 'deadlift')),
  CONSTRAINT exercises_main_lift_family_consistency CHECK (
    (exercise_type = 'accessory' AND main_lift_family IS NULL) OR
    (exercise_type IN ('main_lift', 'main_lift_variation') AND main_lift_family IS NOT NULL)
  ),
  CONSTRAINT exercises_muscle_groups_valid CHECK (
    muscle_groups <@ ARRAY[
      'chest','shoulder','back','biceps','triceps','core','quad','hamstring','glute'
    ]::TEXT[]
    AND cardinality(muscle_groups) >= 1
  ),
  CONSTRAINT exercises_equipment_valid CHECK (
    equipment <@ ARRAY['barbell','dumbbell','machine','bodyweight']::TEXT[]
    AND cardinality(equipment) >= 1
  ),
  CONSTRAINT exercises_movement_pattern_valid CHECK (
    movement_pattern <@ ARRAY['push','pull']::TEXT[]
  )
);

-- Filter performance: GIN on each facet array. The `&&` (overlaps) operator used by
-- GET /exercises uses these.
CREATE INDEX exercises_muscle_groups_gin    ON exercises USING GIN (muscle_groups);
CREATE INDEX exercises_equipment_gin        ON exercises USING GIN (equipment);
CREATE INDEX exercises_movement_pattern_gin ON exercises USING GIN (movement_pattern);

-- Visibility filter: `WHERE created_by_coach_id IS NULL OR created_by_coach_id = $userId`
-- benefits from a partial index on coach customs.
CREATE INDEX exercises_created_by_coach_id_idx
  ON exercises (created_by_coach_id)
  WHERE created_by_coach_id IS NOT NULL;

-- ===========================================================================
-- Initial seed: 7 main / variations + 8 accessories. zh-CN names.
-- All system-seeded (created_by_coach_id IS NULL). Stable UUIDs are NOT used
-- — `gen_random_uuid()` runs per row; the iOS catalog is fetched, not bundled.
-- ===========================================================================

INSERT INTO exercises (name, exercise_type, main_lift_family, is_competition_lift, muscle_groups, equipment, movement_pattern) VALUES
  -- Squat family
  ('竞技深蹲',     'main_lift',           'squat',    TRUE,  ARRAY['quad','glute','core']::TEXT[], ARRAY['barbell']::TEXT[],     ARRAY[]::TEXT[]),
  ('高杠深蹲',     'main_lift_variation', 'squat',    FALSE, ARRAY['quad','glute','core']::TEXT[], ARRAY['barbell']::TEXT[],     ARRAY[]::TEXT[]),
  ('哈克深蹲',     'main_lift_variation', 'squat',    FALSE, ARRAY['quad','glute']::TEXT[],         ARRAY['machine']::TEXT[],     ARRAY[]::TEXT[]),
  -- Bench family
  ('竞技卧推',     'main_lift',           'bench',    TRUE,  ARRAY['chest','triceps','shoulder']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['push']::TEXT[]),
  ('窄距卧推',     'main_lift_variation', 'bench',    FALSE, ARRAY['triceps','chest']::TEXT[],      ARRAY['barbell']::TEXT[],     ARRAY['push']::TEXT[]),
  -- Deadlift family
  ('传统硬拉',     'main_lift',           'deadlift', TRUE,  ARRAY['hamstring','glute','back','core']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['pull']::TEXT[]),
  ('相扑硬拉',     'main_lift_variation', 'deadlift', FALSE, ARRAY['hamstring','glute','quad','back','core']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['pull']::TEXT[]),
  -- Accessories
  ('引体向上',     'accessory',           NULL,       FALSE, ARRAY['back','biceps']::TEXT[],        ARRAY['bodyweight']::TEXT[],  ARRAY['pull']::TEXT[]),
  ('杠铃划船',     'accessory',           NULL,       FALSE, ARRAY['back','biceps']::TEXT[],        ARRAY['barbell']::TEXT[],     ARRAY['pull']::TEXT[]),
  ('哑铃肩推',     'accessory',           NULL,       FALSE, ARRAY['shoulder','triceps']::TEXT[],   ARRAY['dumbbell']::TEXT[],    ARRAY['push']::TEXT[]),
  ('臂屈伸',       'accessory',           NULL,       FALSE, ARRAY['triceps','chest']::TEXT[],      ARRAY['bodyweight']::TEXT[],  ARRAY['push']::TEXT[]),
  ('哑铃弯举',     'accessory',           NULL,       FALSE, ARRAY['biceps']::TEXT[],               ARRAY['dumbbell']::TEXT[],    ARRAY['pull']::TEXT[]),
  ('罗马尼亚硬拉', 'accessory',           NULL,       FALSE, ARRAY['hamstring','glute','back']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['pull']::TEXT[]),
  ('腿举',         'accessory',           NULL,       FALSE, ARRAY['quad','glute']::TEXT[],         ARRAY['machine']::TEXT[],     ARRAY[]::TEXT[]),
  ('卷腹',         'accessory',           NULL,       FALSE, ARRAY['core']::TEXT[],                 ARRAY['bodyweight']::TEXT[],  ARRAY[]::TEXT[]);

COMMIT;
```

**Notes:**

- `created_by_coach_id REFERENCES users(id) ON DELETE SET NULL` — if a coach is later deleted, their customs become orphaned-system rows. V1 has no coach-deletion flow; the rule is just defensive.
- The two `cardinality(...) >= 1` checks enforce non-empty `muscle_groups` and `equipment` at the DB level, mirroring the iOS-side `count >= 1` documentation in [iOS spec 004 § Exercise constraint](~/Projects/apps/MeetPR/specs/004-core-models-training-plan/SPEC.md). `movement_pattern` may be empty (e.g. squats / abs). **Note:** must use `cardinality()` not `array_length(x, 1)` — the latter returns `NULL` for empty arrays, and `NULL >= 1` is `NULL` which a CHECK treats as pass (P1 review finding 2026-04-28).
- Seed list is the **minimum viable catalog** for V1 internal dogfood. Coaches will create their own customs; expanding the system seed is a content-ops follow-up.

### Migration `db/migrations/0003-init-plans.sql`

```sql
-- Migration 0003: training plan tree (plans → plan_days → plan_exercises → plan_sets).
-- Spec: specs/002-coach-planning-crud/SPEC.md
-- Source: data-model.md v1.1 §1.8
-- ADR: 004 (no ORM, hand-managed SQL). All cascades hand-modeled — no triggers.

BEGIN;

CREATE TABLE plans (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id            UUID         REFERENCES users(id) ON DELETE RESTRICT,
  trainee_id          UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name                TEXT         NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  start_date          DATE         NOT NULL,
  end_date            DATE         NOT NULL,
  plan_weeks          SMALLINT     NOT NULL,
  source              TEXT         NOT NULL,
  source_template_id  UUID,        -- FK to week_templates deferred (data-model §1.11)
  status              TEXT         NOT NULL DEFAULT 'draft',
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT plans_plan_weeks_check  CHECK (plan_weeks IN (1, 4)),
  CONSTRAINT plans_source_check      CHECK (source IN ('coach', 'template', 'algorithm')),
  CONSTRAINT plans_status_check      CHECK (status IN ('draft', 'published', 'completed', 'paused')),
  CONSTRAINT plans_dates_order_check CHECK (end_date >= start_date),
  CONSTRAINT plans_template_consistency CHECK (
    (source = 'template' AND source_template_id IS NOT NULL) OR
    (source <> 'template' AND source_template_id IS NULL)
  )
);

CREATE INDEX plans_coach_id_idx        ON plans (coach_id) WHERE coach_id IS NOT NULL;
CREATE INDEX plans_trainee_id_idx      ON plans (trainee_id);
CREATE INDEX plans_coach_trainee_idx   ON plans (coach_id, trainee_id);

CREATE TABLE plan_days (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id       UUID         NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  day_of_week   SMALLINT     NOT NULL,
  week_number   SMALLINT     NOT NULL,
  sort_order    INT          NOT NULL DEFAULT 0,

  CONSTRAINT plan_days_day_of_week_check CHECK (day_of_week BETWEEN 1 AND 7),
  CONSTRAINT plan_days_week_number_check CHECK (week_number BETWEEN 1 AND 4),
  CONSTRAINT plan_days_sort_order_check  CHECK (sort_order >= 0)
);

CREATE INDEX plan_days_plan_id_idx ON plan_days (plan_id, week_number, day_of_week, sort_order);

CREATE TABLE plan_exercises (
  id           UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_day_id  UUID  NOT NULL REFERENCES plan_days(id)  ON DELETE CASCADE,
  exercise_id  UUID  NOT NULL REFERENCES exercises(id)  ON DELETE RESTRICT,
  is_main_lift BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order   INT   NOT NULL DEFAULT 0,
  notes        TEXT,

  CONSTRAINT plan_exercises_sort_order_check CHECK (sort_order >= 0)
);

CREATE INDEX plan_exercises_plan_day_id_idx ON plan_exercises (plan_day_id, sort_order);
CREATE INDEX plan_exercises_exercise_id_idx ON plan_exercises (exercise_id);

CREATE TABLE plan_sets (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_exercise_id   UUID          NOT NULL REFERENCES plan_exercises(id) ON DELETE CASCADE,
  set_number         SMALLINT      NOT NULL,
  target_reps        SMALLINT      NOT NULL,
  target_reps_max    SMALLINT,
  intensity_mode     TEXT          NOT NULL,
  target_value       NUMERIC(6, 2) NOT NULL,
  set_type           TEXT          NOT NULL,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT plan_sets_set_number_check     CHECK (set_number >= 1),
  CONSTRAINT plan_sets_target_reps_check    CHECK (target_reps BETWEEN 1 AND 50),
  CONSTRAINT plan_sets_target_reps_max_check CHECK (
    target_reps_max IS NULL OR (target_reps_max BETWEEN target_reps AND 50)
  ),
  CONSTRAINT plan_sets_intensity_mode_check CHECK (intensity_mode IN ('weight', 'rpe')),
  CONSTRAINT plan_sets_set_type_check       CHECK (set_type IN ('warmup', 'working', 'failed', 'amrap', 'backoff')),
  CONSTRAINT plan_sets_target_value_check   CHECK (
    (intensity_mode = 'rpe'    AND target_value BETWEEN 1.0 AND 10.0) OR
    (intensity_mode = 'weight' AND target_value > 0 AND target_value < 1000)
  )
);

CREATE INDEX plan_sets_plan_exercise_id_idx ON plan_sets (plan_exercise_id, set_number);

COMMIT;
```

**Notes:**

- `coach_id` is nullable in the table (data-model.md §1.8 — self-train students with no coach store `NULL`), but **this spec rejects `NULL coach_id` at the API level** for `POST /plans` (the only writer). Self-train plan creation is a separate spec when the self-train flow lands.
- `ON DELETE CASCADE` on `plan_days` / `plan_exercises` / `plan_sets` lets a `DELETE /plans/days/:dayId` (or higher) clean the subtree in one statement. `plans → users` is `RESTRICT`: deleting a user with live plans is forbidden.
- `start_date` and `end_date` are `DATE`. The pg type parser registered globally in [src/db/pool.ts](../../src/db/pool.ts) (OID 1082) returns them as strings; do not unregister it. JSON output will be `"2026-05-04"`.
- `target_value` is `NUMERIC(6, 2)`. `pg` defaults to returning `NUMERIC` as a string — this is the Decimal-as-string contract iOS depends on. **Do not register a custom type parser for OID 1700.**
- `source = 'algorithm'` is allowed by the CHECK (data-model schema-level future-proofing) but rejected by the API zod enum. iOS spec 004 enum has `algorithm` as case for the same reason.

### Kysely augmentation in `src/db/types.ts`

Add five interfaces and five `Database` table entries. Use `Generated<T>` for defaulted columns. `string | null` for nullable. Note `string` for `target_value` (pg returns `NUMERIC` as string — keep it that way; do not coerce to `number` in queries).

```ts
import type { Generated } from 'kysely';

interface ExercisesTable {
  id: Generated<string>;
  name: string;
  exercise_type: 'main_lift' | 'main_lift_variation' | 'accessory';
  main_lift_family: 'squat' | 'bench' | 'deadlift' | null;
  is_competition_lift: Generated<boolean>;
  muscle_groups: string[];
  equipment: string[];
  movement_pattern: Generated<string[]>;
  created_by_coach_id: string | null;
  created_at: Generated<string>; // ISO-8601 from TIMESTAMPTZ
}

interface PlansTable {
  id: Generated<string>;
  coach_id: string | null;
  trainee_id: string;
  name: string;
  start_date: string; // 'YYYY-MM-DD' via OID-1082 parser
  end_date: string;
  plan_weeks: number;
  source: 'coach' | 'template' | 'algorithm';
  source_template_id: string | null;
  status: Generated<'draft' | 'published' | 'completed' | 'paused'>;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

interface PlanDaysTable {
  id: Generated<string>;
  plan_id: string;
  day_of_week: number;
  week_number: number;
  sort_order: Generated<number>;
}

interface PlanExercisesTable {
  id: Generated<string>;
  plan_day_id: string;
  exercise_id: string;
  is_main_lift: Generated<boolean>;
  sort_order: Generated<number>;
  notes: string | null;
}

interface PlanSetsTable {
  id: Generated<string>;
  plan_exercise_id: string;
  set_number: number;
  target_reps: number;
  target_reps_max: number | null;
  intensity_mode: 'weight' | 'rpe';
  target_value: string; // NUMERIC(6,2) — pg returns string
  set_type: 'warmup' | 'working' | 'failed' | 'amrap' | 'backoff';
  created_at: Generated<string>;
}

export interface Database {
  users: UsersTable; // from spec 001
  exercises: ExercisesTable;
  plans: PlansTable;
  plan_days: PlanDaysTable;
  plan_exercises: PlanExercisesTable;
  plan_sets: PlanSetsTable;
}
```

### Wire shapes

The route layer hand-builds response objects. **Do not blindly spread DB rows** — that is fine here because column names are already snake_case, but be explicit so accidental column additions don't leak. Field order below matches the iOS Codable expectations; Express will JSON-serialize keys verbatim.

#### `Plan` (no children — used by `POST /plans`, `PATCH /plans/:id`, `POST /plans/:id/publish`, both `GET /students/:studentId/plans` rows)

```jsonc
{
  "id": "<uuid>",
  "coach_id": "<uuid|null>",
  "trainee_id": "<uuid>",
  "name": "Squat / Bench Block 1",
  "start_date": "2026-05-04",
  "end_date": "2026-06-01",
  "plan_weeks": 4,
  "source": "coach",
  "source_template_id": null,
  "status": "draft",
  "created_at": "2026-04-28T10:00:00.000Z",
  "updated_at": "2026-04-28T10:00:00.000Z",
}
```

#### `PlanWithChildren` (used by `GET /plans/:id`)

Same as `Plan` plus a `days` array, ordered `(week_number ASC, day_of_week ASC, sort_order ASC)`. Each `PlanDay` carries an `exercises` array ordered by `sort_order`. Each `PlanExercise` carries a `sets` array ordered by `set_number`. `days`, `exercises`, and `sets` are always arrays — never `null`, never absent — defaulting to `[]`.

```jsonc
{
  "id": "<uuid>",
  "coach_id": "<uuid>",
  "trainee_id": "<uuid>",
  "name": "...",
  "start_date": "2026-05-04",
  "end_date": "2026-06-01",
  "plan_weeks": 4,
  "source": "coach",
  "source_template_id": null,
  "status": "draft",
  "created_at": "...",
  "updated_at": "...",
  "days": [
    {
      "id": "<uuid>",
      "plan_id": "<uuid>",
      "day_of_week": 1,
      "week_number": 1,
      "sort_order": 0,
      "exercises": [
        {
          "id": "<uuid>",
          "plan_day_id": "<uuid>",
          "exercise_id": "<uuid>",
          "is_main_lift": true,
          "sort_order": 0,
          "notes": null,
          "sets": [
            {
              "id": "<uuid>",
              "plan_exercise_id": "<uuid>",
              "set_number": 1,
              "target_reps": 5,
              "target_reps_max": null,
              "intensity_mode": "weight",
              "target_value": "180.50",
              "set_type": "working",
              "created_at": "...",
            },
          ],
        },
      ],
    },
  ],
}
```

**Implementation hint (not mandated):** a single Kysely / pg query using nested `jsonb_agg` is fine, e.g.

```sql
SELECT
  p.*,
  COALESCE(jsonb_agg(/* days with nested exercises/sets */ ORDER BY ...) FILTER (WHERE d.id IS NOT NULL), '[]'::jsonb) AS days
FROM plans p
LEFT JOIN LATERAL (
  SELECT pd.*, jsonb_agg(/* exercises */) AS exercises
  FROM plan_days pd
  LEFT JOIN LATERAL (...) e ON ...
  WHERE pd.plan_id = p.id
  GROUP BY pd.id
) d ON TRUE
WHERE p.id = $1 AND p.coach_id = $2
GROUP BY p.id;
```

A 4-query in-transaction implementation is also acceptable. The on-the-wire shape is what the test asserts; the SQL strategy is the implementer's call.

#### `Exercise` (`GET /exercises`, `POST /exercises`)

```jsonc
{
  "id": "<uuid>",
  "name": "竞技深蹲",
  "exercise_type": "main_lift",
  "main_lift_family": "squat",
  "is_competition_lift": true,
  "muscle_groups": ["quad", "glute", "core"],
  "equipment": ["barbell"],
  "movement_pattern": [],
  "created_by_coach_id": null,
  "created_at": "...",
}
```

### Publish flow (`POST /plans/:id/publish`)

```
1. requireAuth + requireRole('coach').
2. BEGIN;
3. SELECT id, coach_id, status FROM plans WHERE id = $planId FOR UPDATE.
   - No row OR coach_id !== req.user.id → ROLLBACK; 404 PLAN_NOT_FOUND.
   - status !== 'draft'                  → ROLLBACK; 409 PLAN_NOT_DRAFT.
4. Verify the tree is non-empty. A single SQL is enough:
     SELECT
       (SELECT COUNT(*) FROM plan_days       WHERE plan_id = $planId)                AS day_count,
       (SELECT COUNT(*) FROM plan_exercises pe
          JOIN plan_days pd ON pe.plan_day_id = pd.id
          WHERE pd.plan_id = $planId)                                                AS exercise_count,
       (SELECT COUNT(*) FROM plan_sets ps
          JOIN plan_exercises pe ON ps.plan_exercise_id = pe.id
          JOIN plan_days pd ON pe.plan_day_id = pd.id
          WHERE pd.plan_id = $planId)                                                AS set_count,
       -- Each plan_day must have ≥1 exercise; each plan_exercise must have ≥1 set.
       (SELECT COUNT(*) FROM plan_days pd
          WHERE pd.plan_id = $planId
            AND NOT EXISTS (SELECT 1 FROM plan_exercises pe WHERE pe.plan_day_id = pd.id)) AS empty_day_count,
       (SELECT COUNT(*) FROM plan_exercises pe
          JOIN plan_days pd ON pe.plan_day_id = pd.id
          WHERE pd.plan_id = $planId
            AND NOT EXISTS (SELECT 1 FROM plan_sets ps WHERE ps.plan_exercise_id = pe.id)) AS empty_exercise_count;
   If day_count = 0 OR empty_day_count > 0 OR empty_exercise_count > 0
     → ROLLBACK; 422 PLAN_PUBLISH_INCOMPLETE { day_count, exercise_count, set_count, empty_day_count, empty_exercise_count }.
5. UPDATE plans SET status = 'published', updated_at = now() WHERE id = $planId RETURNING *;
6. COMMIT.
7. Fire the student-notification stub (see § Stub seams below). Errors from the stub are swallowed and logged — they do not roll back the publish.
8. Return 200 with the updated Plan (no children).
```

### Exercise filter logic (`GET /exercises`)

Visible-set predicate:

```sql
-- Coach:
WHERE created_by_coach_id IS NULL
   OR created_by_coach_id = $userId

-- Student:
WHERE created_by_coach_id IS NULL
   OR id IN (
     SELECT pe.exercise_id
       FROM plan_exercises pe
       JOIN plan_days pd ON pe.plan_day_id = pd.id
       JOIN plans p      ON pd.plan_id     = p.id
      WHERE p.trainee_id = $userId
        AND p.status     = 'published'
   )
```

Each query string facet adds an `AND ... && ARRAY[...]::TEXT[]` clause for arrays, or `AND ... = ANY(ARRAY[...])` for scalars:

| Query param                         | Predicate                                              |
| ----------------------------------- | ------------------------------------------------------ |
| `muscle_group=quad,glute`           | `muscle_groups && ARRAY['quad', 'glute']::TEXT[]`      |
| `equipment=barbell`                 | `equipment && ARRAY['barbell']::TEXT[]`                |
| `movement_pattern=push`             | `movement_pattern && ARRAY['push']::TEXT[]`            |
| `exercise_type=main_lift,accessory` | `exercise_type = ANY(ARRAY['main_lift', 'accessory'])` |
| `main_lift_family=squat`            | `main_lift_family = ANY(ARRAY['squat'])`               |

Unknown values inside a csv → `400 VALIDATION_ERROR`. Result ordering: `(exercise_type ASC, main_lift_family NULLS LAST, name ASC COLLATE "zh_CN.UTF-8")` — best-effort; if the locale isn't installed in the test container, fall back to default lexicographic. No pagination V1 (catalog ≤ ~100 rows).

### Error envelope

Codes added by this spec — same shape as spec 001 (`{ "error": "<MACHINE_CODE>", ... }`):

| Code                           | HTTP | Triggered by                                                                                                                                                          |
| ------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`             | 400  | zod parse fail; cross-field validations (e.g. `target_reps_max < target_reps`, `source='template'` without `source_template_id`, `accessory` with `main_lift_family`) |
| `EXERCISE_NOT_FOUND_OR_HIDDEN` | 400  | `exercise_id` referenced in a `POST /plans/days/:dayId/exercises` or `PATCH /plans/exercises/:exerciseId` body resolves to no visible row                             |
| `TRAINEE_NOT_FOUND`            | 400  | `POST /plans` body's `trainee_id` doesn't reference a `users` row with role ∈ {coached_student, self_train_student}                                                   |
| `AUTHORIZATION_FORBIDDEN`      | 403  | `requireRole` mismatch; student requesting another student's `/students/:studentId/plans`                                                                             |
| `PLAN_NOT_FOUND`               | 404  | plan id not found OR not owned (coach) OR not published & owned-as-trainee (student)                                                                                  |
| `PLAN_DAY_NOT_FOUND`           | 404  | day id resolves nothing under a plan owned by the calling coach                                                                                                       |
| `PLAN_EXERCISE_NOT_FOUND`      | 404  | plan_exercise id resolves nothing under a plan owned by the calling coach                                                                                             |
| `PLAN_SET_NOT_FOUND`           | 404  | plan_set id resolves nothing under a plan owned by the calling coach                                                                                                  |
| `PLAN_NOT_DRAFT`               | 409  | publish requested on a plan whose status is not `draft`                                                                                                               |
| `PLAN_PUBLISH_INCOMPLETE`      | 422  | publish requested on a plan with zero days, or a day with zero exercises, or an exercise with zero sets. Body includes counts (see flow above).                       |
| `RATE_LIMITED`                 | 429  | global limiter (existing — unchanged)                                                                                                                                 |

**Same-status disambiguation policy:** for the four 404 codes, the rule is "row resolved to plan but plan not owned by caller → 404, no leak". A coach cannot probe another coach's plan tree by ID enumeration.

### Logging

Inherit pino redact paths from spec 001 — `req.headers.authorization`, `req.headers.cookie`, `*.password`, `*.token`, `*.refreshToken`, `*.accessToken`. **No new redact paths needed** — plan field values (set weights, RPE) are not secrets. Do log:

- `logger.info({ planId, coachId, traineeId, planWeeks, source }, 'plan_created')`
- `logger.info({ planId, dayCount, exerciseCount, setCount }, 'plan_published')`
- `logger.warn({ planId, reason, empty_day_count, empty_exercise_count }, 'plan_publish_rejected')` (422 case)
- `logger.info({ planId, action: 'day' | 'exercise' | 'set', op: 'create' | 'update' | 'delete', resourceId }, 'plan_tree_mutated')`
- Never log the full request body (defends against an accidental future field that leaks PII).

### Stub seams

- **`src/services/notifications.ts`** — exports `async function notifyPlanPublished(planId: string, traineeId: string): Promise<void>`. V1 implementation: emits `logger.info({ planId, traineeId }, 'plan_published_notification_stub')` and resolves. The future Aliyun-MNS / APNs-bridge spec replaces the body. Errors are caught at the call site and logged as `warn` — they don't fail the publish HTTP response.
- **No /plans/:id/notify or pull-style endpoint** — student plan-discovery in V1 is iOS-side polling against `GET /students/:studentId/plans` and `GET /plans/:id` (≤ 30s SLA per ADR 004 §3). The push hook above is forward-only signalling for the eventual real-time spec.
- **No `POST /plans/:id/duplicate`, no `POST /plans/from-template`** — template materialization is a separate spec gated on the `week_templates` migration (data-model §1.11).

## Out of scope

- `progression_rule_groups`, `progression_rule_assignments`, `exercise_week_overrides` (data-model §1.9). Coach-planning Step 6 of [coach-planning.md v4.4](~/Brain/wiki/projects/MeetPR/coach-planning.md) — separate spec.
- `week_templates`, `template_days`, `template_exercises`, `template_sets`, `template_progression_rules` (data-model §1.11). Spec 002 lets `source = 'template'` and `source_template_id` flow through, but does not validate that `source_template_id` exists (`source_template_id` is just stored). Validation lands when the template migration does.
- Real-time push / WebSocket. ADR 004 §3 freezes V1 at "≤30s polling SLA via APNs + iOS pull". The `notifyPlanPublished` stub is the only forward-looking seam.
- Macro-aggregation endpoints ([ADR-006](~/Brain/wiki/projects/MeetPR/decisions/006-macro-aggregation-api.md)) — web-companion concern, V1.x.
- `bind_requests` / `invite_codes` migration. Coach ↔ trainee binding enforcement is **not** checked at the API boundary in this spec; the iOS UX is the gate. New FOLLOWUPS entry below.
- `e1rm_history`, `videos`, `coach_feedback`, `evaluation_periods`, `student_evaluations` (data-model §1.7, §1.10, §1.12, §1.13) — all separate specs.
- Self-train student plan creation (where `coach_id IS NULL`). The `plans.coach_id` column is nullable to keep the option open; this spec's `POST /plans` requires the caller to be a coach.
- Aliyun deployment (SAE / RDS hardening / OSS bucket policies / KMS) — covered by ADR 004 §6 follow-ups in [FOLLOWUPS.md](../../FOLLOWUPS.md).
- Multi-device refresh tracking (already in spec 001 follow-ups).
- Apple Sign-In and Aliyun SMS OTP integration (already in spec 001 follow-ups).
- E2E tests. Test plan below is unit + integration smoke.
- Per-coach rate limits, audit logging beyond the structured-log lines above.
- `GET /exercises/:id` (single-exercise lookup). Catalog is small; iOS bulk-fetches.
- DB connection-pool tuning, integration-test docker-compose harness — already in [FOLLOWUPS.md](../../FOLLOWUPS.md).

## Verification

End-to-end smoke (assumes a local PG 17 with migrations 0001 through 0003 applied — the docker-compose harness FOLLOWUP from spec 001 may land alongside this spec):

```bash
psql "$DATABASE_URL" -f db/migrations/0002-init-exercises.sql
psql "$DATABASE_URL" -f db/migrations/0003-init-plans.sql
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build

# Bearer obtained from POST /auth/login (spec 001).
TOKEN="<coach-access-jwt>"

# 1. Create a draft plan
curl -fsS -X POST localhost:3000/plans \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"trainee_id":"<trainee-uuid>","name":"Block 1","start_date":"2026-05-04","end_date":"2026-06-01","plan_weeks":4,"source":"coach"}'

# 2. Add a day, exercise, two sets
DAY_ID=$(curl -fsS -X POST localhost:3000/plans/<plan-id>/days -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"day_of_week":1,"week_number":1,"sort_order":0}' | jq -r .id)
EX_ID=$(curl -fsS -X POST localhost:3000/plans/days/$DAY_ID/exercises -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"exercise_id":"<squat-uuid>","is_main_lift":true,"sort_order":0}' | jq -r .id)
curl -fsS -X POST localhost:3000/plans/exercises/$EX_ID/sets -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"set_number":1,"target_reps":5,"intensity_mode":"weight","target_value":"180.5","set_type":"working"}'

# 3. Publish
curl -fsS -X POST localhost:3000/plans/<plan-id>/publish -H "authorization: Bearer $TOKEN"

# 4. Read back nested
curl -fsS localhost:3000/plans/<plan-id> -H "authorization: Bearer $TOKEN" | jq .
```

### Acceptance checklist

- [ ] Migrations `0002-init-exercises.sql` and `0003-init-plans.sql` apply cleanly in order on a fresh PG 17 database that already has `0001-init-users.sql`. `gen_random_uuid()` is built-in (per spec 001) — no `CREATE EXTENSION` needed.
- [ ] All five new table interfaces added to [src/db/types.ts](../../src/db/types.ts); `Database` lists `users`, `exercises`, `plans`, `plan_days`, `plan_exercises`, `plan_sets`. `target_value` typed as `string` (NUMERIC-as-string contract).
- [ ] `requireRole(...allowed)` middleware exported from [src/middleware/auth.ts](../../src/middleware/auth.ts); `requireAuth` itself unchanged.
- [ ] All 16 routes under `/plans`, `/exercises`, `/students/:studentId/plans` mount under [src/routes/index.ts](../../src/routes/index.ts) (replacing the bootstrap stubs in `src/routes/coach.ts` and `src/routes/student.ts` for the plan-related paths; old stubs that stay 501 — like `POST /coach/students` — are untouched).
- [ ] Exercise seed inserts the 15 rows listed in the migration. `SELECT COUNT(*) FROM exercises WHERE created_by_coach_id IS NULL` = 15.
- [ ] `Plan` and `PlanWithChildren` JSON shapes match § Wire shapes byte-for-byte (key order tolerant; presence + types strict). `target_value` always emitted as a JSON string. `start_date` / `end_date` always emitted as `'YYYY-MM-DD'`. Empty children → `[]`, never absent / `null`.
- [ ] All 11 new error codes are emitted with the documented HTTP statuses and envelope shape. `PLAN_NOT_FOUND` is returned uniformly for "plan absent" and "plan not owned by caller".
- [ ] `POST /plans/:id/publish` is transactional; a 422 leaves the plan with `status='draft'` (verifiable by re-reading after the failed call).
- [ ] `notifyPlanPublished` stub in `src/services/notifications.ts` emits one log line per successful publish; thrown errors from the stub do not change the HTTP 200.
- [ ] pino redact paths unchanged from spec 001. Manual log inspection during a `POST /plans` and a `POST /plans/:id/publish` shows no plaintext password, no JWT, no full-body dump.
- [ ] `GET /exercises?muscle_group=quad,glute&equipment=barbell` returns only rows whose `muscle_groups` overlap `{quad, glute}` AND `equipment` overlaps `{barbell}`.
- [ ] All gates green: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build`.
- [ ] No `git commit --no-verify` was used.
- [ ] [FOLLOWUPS.md](../../FOLLOWUPS.md) updated — see § Follow-ups below.

### Test plan (vitest + supertest)

Layout matches spec 001: pure logic and zod schemas in `tests/unit/`, HTTP round-trips in `tests/smoke/`, both using `createApp` and a real Kysely instance (docker-compose Postgres if it lands; `pg-mem` fallback). All tests share a single coach + single trainee fixture set up in a per-suite `beforeAll`.

#### Happy paths (one per route, 16 total)

For each route, set up the minimal predecessor state (e.g. `POST /plans/:id/days` requires a plan), call the route, assert status + envelope + persistent state. The 16:

1. `POST /plans` → 201 `Plan`. Row exists with `status='draft'`, `coach_id = caller`.
2. `GET /plans/:id` (coach owner, draft) → 200 `PlanWithChildren` with empty `days: []`.
3. `PATCH /plans/:id` (rename) → 200; row's `name` updated; `updated_at` advanced.
4. `POST /plans/:id/publish` (with one day, one exercise, one set) → 200; row's `status='published'`.
5. `GET /students/:studentId/plans` (coach) → 200 `{ plans: [Plan, ...] }` ordered `created_at DESC`.
6. `POST /plans/:id/days` → 201 `PlanDay`.
7. `PATCH /plans/days/:dayId` → 200 with new `day_of_week`.
8. `DELETE /plans/days/:dayId` → 204; row gone; child exercises + sets cascaded gone.
9. `POST /plans/days/:dayId/exercises` → 201 `PlanExercise`.
10. `PATCH /plans/exercises/:exerciseId` (set `notes`) → 200.
11. `DELETE /plans/exercises/:exerciseId` → 204; child sets cascaded gone.
12. `POST /plans/exercises/:exerciseId/sets` → 201 `PlanSet`. JSON `target_value` is a string `"180.50"`.
13. `PATCH /plans/sets/:setId` (toggle `intensity_mode='rpe'`, `target_value="7.5"`) → 200.
14. `DELETE /plans/sets/:setId` → 204.
15. `GET /exercises` (no filter) → 200; 15 system rows.
16. `POST /exercises` (coach custom) → 201 `Exercise` with `created_by_coach_id = caller`.

#### Edge cases (≥ 22)

Authorization (5):

1. Any coach-only mutation called by a `coached_student` JWT → 403 `AUTHORIZATION_FORBIDDEN`.
2. `GET /plans/:id` for a draft plan, called by the trainee → 404 `PLAN_NOT_FOUND` (status filter strips drafts).
3. `GET /plans/:id` called by another coach → 404 `PLAN_NOT_FOUND` (no row leak).
4. `GET /students/:studentId/plans` called by another student → 403 `AUTHORIZATION_FORBIDDEN`.
5. `PATCH /plans/days/:dayId` called by another coach → 404 `PLAN_DAY_NOT_FOUND` (ownership chain rejected).

Validation (10):

6. `POST /plans` with `plan_weeks=2` → 400 `VALIDATION_ERROR { issues: [{ path: ["plan_weeks"], ... }] }`.
7. `POST /plans` with `source='template'` and no `source_template_id` → 400 cross-field issue.
8. `POST /plans` with `end_date < start_date` → 400 cross-field issue.
9. `POST /plans` with a `trainee_id` that's a coach → 400 `TRAINEE_NOT_FOUND`.
10. `POST /plans/exercises/:exerciseId/sets` with `intensity_mode='rpe'` and `target_value="11.0"` → 400 cross-field issue.
11. `POST /plans/exercises/:exerciseId/sets` with `target_reps=8`, `target_reps_max=5` → 400 cross-field issue.
12. `POST /plans/days/:dayId/exercises` with an `exercise_id` belonging to another coach's custom → 400 `EXERCISE_NOT_FOUND_OR_HIDDEN`.
13. `POST /exercises` with `exercise_type='accessory'` and `main_lift_family='squat'` → 400 cross-field issue.
14. `POST /exercises` with `muscle_groups=[]` → 400 `VALIDATION_ERROR`.
15. `PATCH /plans/:id` with `status='draft'` → 400 `VALIDATION_ERROR` (`draft` not in PATCH-allowed enum).

State / ownership (4):

16. `POST /plans/:id/publish` on an already-published plan → 409 `PLAN_NOT_DRAFT`.
17. `POST /plans/:id/publish` on a plan with zero days → 422 `PLAN_PUBLISH_INCOMPLETE { day_count: 0, ... }`.
18. `POST /plans/:id/publish` on a plan whose only day has zero exercises → 422 `PLAN_PUBLISH_INCOMPLETE { empty_day_count: 1, ... }`.
19. `POST /plans/:id/publish` on a plan whose only exercise has zero sets → 422 `PLAN_PUBLISH_INCOMPLETE { empty_exercise_count: 1, ... }`.

Cascade / shape (3):

20. `DELETE /plans/days/:dayId` removes child exercises and sets in the same statement (assert via direct SQL `SELECT COUNT(*)` after the call).
21. `GET /plans/:id` after publishing a 1-day / 1-exercise / 2-set plan returns `days` ordered correctly, with `target_value` as JSON strings, and **no extra columns leaked** (e.g. `password_hash` from a join error).
22. `GET /exercises?equipment=garbage` → 400 `VALIDATION_ERROR` (unknown enum value).

#### Logging assertion (smoke)

Drive a `POST /plans` and a `POST /plans/:id/publish`, capture pino lines, assert that:

- the captured lines include `'plan_created'` and `'plan_published_notification_stub'`,
- no captured line contains the literal Bearer token from `req.headers.authorization`,
- no captured line contains the JSON body of the requests verbatim.

## Follow-ups

Replace [FOLLOWUPS.md](../../FOLLOWUPS.md) entry "First migration: define users, coach_profiles, student_profiles tables" — already partially crossed by spec 001. Append:

- [ ] `bind_requests` / `invite_codes` / `coach_profiles` / `student_profiles` migration. Spec 002 stops short of binding enforcement — coach can currently create a plan for any student-role user. Add a coach-↔-trainee bind check in `POST /plans` once `bind_requests` exists.
- [ ] `week_templates` + materialization spec. Spec 002 stores `source_template_id` opaquely; add a referential check + `POST /plans/from-template` once template tables exist.
- [ ] `progression_rule_groups`, `exercise_week_overrides` migration + endpoints (data-model §1.9; planning Step 6).
- [ ] Self-train student plan creation (`coach_id IS NULL` POST path).
- [ ] Real-time plan-published push: replace `notifyPlanPublished` stub with Aliyun-MNS / APNs bridge once the V1.5 WebSocket spec lands.
- [ ] `GET /exercises/:id` if iOS ever needs single-exercise lookup outside the bulk catalog (currently not needed).
- [ ] Coach-deletion flow. `plans.coach_id` is `RESTRICT` and `exercises.created_by_coach_id` is `SET NULL` — pick a policy when account-deletion lands.

## Changelog

- 2026-04-29 review fixes: replaced empty-array checks with `cardinality(...) >= 1`; documented and enforced `end_date >= start_date`; broadened student exercise visibility to coach customs referenced by their own published plans; corrected seed-count and publish-authz wording; added DB name length checks; tightened `target_value` precision to max two decimal places.
