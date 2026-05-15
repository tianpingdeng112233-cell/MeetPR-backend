# 003-student-actions

**Status:** Draft
**Date:** 2026-05-15

## Goal

Land the backend endpoints + migrations required by iOS V0.1 wave specs **026 / 029** so coach / student two-way flow can run on real Aliyun RDS:

1. **`GET /coach/students`** — currently a `501 notImplemented` stub in `src/routes/coach.ts`; iOS spec 029 `StudentRosterView` first-screen depends on it.
2. **`POST /sets/log`** + **`GET /students/:id/sets`** — student records each set after ✓ (per iOS spec 024 `TodayWorkoutViewModel.toggleComplete`); coach reviews under iOS spec 029 `StudentExecutionView`.
3. **`POST /coach/feedback`** + **`GET /students/:id/feedback`** + **`PATCH /feedback/:id/read`** — coach writes free-text feedback (iOS spec 029 `FeedbackComposerView`); student sees inbox + red dot (iOS spec 024 `FeedbackInboxView`).
4. **Missing-tables migrations**: `coach_profiles` / `student_profiles` / `bind_requests` — iOS data-model has these but `002-coach-planning-crud` did not create them; required by `GET /coach/students` query + seed migration.
5. **Internal-user seed migration** — David (coach) + xty (student) + `bind_requests` row `status='accepted'` — per iOS spec 025 candidate-2 subset B decision (skip real registration + invite-code for 2-person internal testing).

Refs:

- iOS [spec 026 backend wiring](../../../MeetPR/specs/026-backend-wiring-deploy/SPEC.md) §2.2 / §2.3 / §2.4 / §2.5 — backend contract source of truth
- iOS [spec 029 coach review](../../../MeetPR/specs/029-coach-student-detail-feedback/SPEC.md) §Backend dependencies — hard prerequisite endpoint list
- iOS [spec 024 student P0](../../../MeetPR/specs/024-student-p0-views/SPEC.md) — `StudentSetLog` / `CoachFeedback` wire shape
- [data-model.md v1.1 §1.5 (BindRequest) / §1.6 (InviteCode) / §1.7 (Profiles)](~/Brain/wiki/projects/MeetPR/data-model.md)
- Upstream [001-auth](../001-auth/SPEC.md) + [002-coach-planning-crud](../002-coach-planning-crud/SPEC.md) — JWT `requireAuth` + `requireRole` middleware reused as-is, plans / plan_days / plan_exercises tables FK targets.
- [ADR 004](~/Brain/wiki/projects/MeetPR/decisions/004-backend-selection.md) — Aliyun RDS PG 17, no ORM, hand-managed SQL

## Scope

### Migrations (5 new files in `db/migrations/`)

| File                             | Tables                                | Notes                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0003.5-init-profile-tables.sql` | `coach_profiles` + `student_profiles` | V0.1 minimal: `user_id PK FK→users(id) ON DELETE CASCADE`, `display_name TEXT NOT NULL`, `created_at` + `updated_at`. V0.2+ adds evaluation / preferences fields. PK is `user_id` (not `id`) — 1:1 with users.                                                                                        |
| `0003.6-init-bind-requests.sql`  | `bind_requests`                       | V0.1 minimal columns per [data-model §1.5](~/Brain/wiki/projects/MeetPR/data-model.md): `id UUID PK`, `student_id` FK, `coach_id` FK, `status` enum, `submitted_at`, `responded_at`, `expired_at`, `skip_evaluation BOOLEAN`, `rejection_silent BOOLEAN`. V0.2 evaluation_period FK added separately. |
| `0004-seed-internal-users.sql`   | seed rows                             | David coach + xty student + `bind_requests` row `status='accepted'`. bcrypt hash **placeholder only** — real hashes via deploy `psql UPDATE` step (see §Deploy / secrets).                                                                                                                            |
| `0005-init-set-logs.sql`         | `set_logs`                            | Student set log capture. UNIQUE `(student_id, plan_exercise_id, set_index)` for upsert semantics.                                                                                                                                                                                                     |
| `0006-init-feedback.sql`         | `feedback`                            | Coach → student free-text feedback + read tracking. Partial index on unread for inbox count perf.                                                                                                                                                                                                     |

Migrations run in lexicographic order, so `0003.5` and `0003.6` sit between `0003-init-plans.sql` and `0004-seed-internal-users.sql`. `0004` references rows from `0003.5` / `0003.6` and is non-idempotent until placeholder hashes get UPDATE'd in deploy step.

### Endpoints

All endpoints sit under their respective resource roots, all require Bearer access JWT via `requireAuth`, all share the error envelope `{ error: '<MACHINE_CODE>', ... }`.

#### Coach roster (replaces 002 stub)

| Method + Path         | Roles | Request | Success                                   |
| --------------------- | ----- | ------- | ----------------------------------------- |
| `GET /coach/students` | coach | —       | `200 { students: CoachStudentSummary[] }` |

`CoachStudentSummary` wire shape (must round-trip with iOS `CoreModels.CoachStudentSummary`):

```json
{
  "students": [
    {
      "id": "uuid",
      "displayName": "xty",
      "profile": { "userId": "uuid", "displayName": "xty", "createdAt": "..." },
      "status": "active"
    }
  ]
}
```

Implementation query:

```sql
SELECT
  u.id,
  sp.display_name,
  sp.user_id AS profile_user_id,
  sp.created_at AS profile_created_at,
  'active' AS status
FROM bind_requests br
JOIN users u            ON br.student_id = u.id
JOIN student_profiles sp ON u.id           = sp.user_id
WHERE br.coach_id = $1   -- req.user.id
  AND br.status   = 'accepted'
ORDER BY u.created_at DESC;
```

V0.1 returns only `status='accepted'` students. V0.2+ adds `'evaluating'` / `'pending'` statuses (gated by evaluation-workflow spec).

#### Student set log

| Method + Path                                          | Roles                                                 | Request                                                         | Success                  |
| ------------------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------- | ------------------------ |
| `POST /sets/log`                                       | student                                               | `{ planExerciseId, setIndex, weightKg, reps, rpe?, completed }` | `201 { id, loggedAt }`   |
| `GET /students/:id/sets?from=YYYY-MM-DD&to=YYYY-MM-DD` | student(self) / coach(owner of plan where trainee=id) | —                                                               | `200 { logs: SetLog[] }` |

`POST /sets/log` semantics — **upsert** via UNIQUE constraint:

```sql
INSERT INTO set_logs (student_id, plan_exercise_id, set_index, weight_kg, reps, rpe, completed)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (student_id, plan_exercise_id, set_index)
DO UPDATE SET
  weight_kg = EXCLUDED.weight_kg,
  reps      = EXCLUDED.reps,
  rpe       = EXCLUDED.rpe,
  completed = EXCLUDED.completed,
  logged_at = now()
RETURNING id, logged_at;
```

Authorization (`POST`):

- `req.user.role === 'coached_student' || 'self_train_student'` else `403 AUTHORIZATION_FORBIDDEN`
- `student_id` is `req.user.id` (not in request body) — student can only log own sets
- Verify `plan_exercise_id` exists + reaches a published plan whose `trainee_id = req.user.id`:

```sql
SELECT 1
  FROM plan_exercises pe
  JOIN plan_days pd ON pe.plan_day_id = pd.id
  JOIN plans p      ON pd.plan_id     = p.id
 WHERE pe.id          = $planExerciseId
   AND p.trainee_id   = $userId
   AND p.status       = 'published'
 LIMIT 1;
```

No row → `400 SETS_PLAN_EXERCISE_NOT_PUBLISHED` (do not reveal whether `plan_exercise_id` exists for other trainees).

Authorization (`GET /students/:id/sets`):

- If `req.user.id === params.id` (student self) → allow regardless of role
- Else require `req.user.role === 'coach'` AND coach owns ≥1 published plan for `params.id`:

```sql
SELECT 1 FROM plans
 WHERE coach_id   = $coachId
   AND trainee_id = $studentId
   AND status     = 'published'
 LIMIT 1;
```

No row → `403 AUTHORIZATION_FORBIDDEN`.

`SetLog` wire shape:

```json
{
  "id": "uuid",
  "studentId": "uuid",
  "planExerciseId": "uuid",
  "setIndex": 1,
  "weightKg": "100.00",
  "reps": 5,
  "rpe": "8.0",
  "completed": true,
  "loggedAt": "2026-05-15T14:00:00.000Z"
}
```

`weightKg` and `rpe` as JSON strings per existing `Decimal-as-string` convention (per 002 SPEC §wire format), aligning with iOS `MeetPRCodec.decimalStringDecoder`.

#### Coach feedback + student inbox

| Method + Path                | Roles                        | Request                                          | Success                                                  |
| ---------------------------- | ---------------------------- | ------------------------------------------------ | -------------------------------------------------------- |
| `POST /coach/feedback`       | coach                        | `{ studentId, dayDate?, planExerciseId?, text }` | `201 Feedback`                                           |
| `GET /students/:id/feedback` | student(self) / coach(owner) | —                                                | `200 { items: Feedback[] }` (ordered by `postedAt DESC`) |
| `PATCH /feedback/:id/read`   | student (self)               | —                                                | `204`                                                    |

`POST /coach/feedback` authorization: coach must own ≥1 published plan for `studentId` (same query as `GET /students/:id/sets`). Otherwise `403`.

`text` validation:

- `z.string().min(1).max(2000)` — DB also CHECK constraint
- Trim whitespace before insert (no leading/trailing space stored)

`dayDate` (optional) — `YYYY-MM-DD` if provided; rejected if format mismatch.
`planExerciseId` (optional) — if provided, validate exists + reaches student's published plan (same query as sets log).

`PATCH /feedback/:id/read`:

- Only `req.user.role === 'student' && req.user.id === feedback.student_id` can mark read
- Idempotent: re-mark = no-op (return 204; do not overwrite `read_at` to a new timestamp)
- `UPDATE feedback SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND student_id = $2`

`Feedback` wire shape:

```json
{
  "id": "uuid",
  "coachId": "uuid",
  "studentId": "uuid",
  "dayDate": "2026-05-15",
  "planExerciseId": "uuid",
  "text": "...",
  "postedAt": "2026-05-15T14:00:00.000Z",
  "readAt": "2026-05-15T15:30:00.000Z"
}
```

`dayDate` / `planExerciseId` / `readAt` are nullable.

### Migrations — full SQL

#### `0003.5-init-profile-tables.sql`

```sql
CREATE TABLE coach_profiles (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE student_profiles (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

V0.1 minimal — V0.2+ evaluation-workflow adds: `coach_profiles.bio` / `student_profiles.height_cm` / `student_profiles.weight_kg` / etc. Out of scope.

#### `0003.6-init-bind-requests.sql`

```sql
CREATE TYPE bind_request_status AS ENUM (
  'pending',    -- student sent invite request, coach not responded
  'accepted',   -- coach accepted; this is the active coach-student bond
  'rejected',   -- coach silent reject
  'expired',    -- 7-day auto-expire (V0.2+ enforces; V0.1 only the seed accepted status used)
  'cancelled'   -- student withdrew
);

CREATE TABLE bind_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coach_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            bind_request_status NOT NULL DEFAULT 'pending',
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at      TIMESTAMPTZ,
  expired_at        TIMESTAMPTZ NOT NULL,  -- submitted_at + 7 days at insert time
  skip_evaluation   BOOLEAN NOT NULL DEFAULT FALSE,
  rejection_silent  BOOLEAN NOT NULL DEFAULT TRUE,

  -- V0.1 invariant: at most one accepted bond per (student, coach) pair
  -- (multiple historical pending/rejected/expired/cancelled rows allowed)
  CONSTRAINT bind_requests_unique_accepted UNIQUE NULLS NOT DISTINCT (student_id, coach_id, status)
    -- relies on partial-index-like behavior via DEFERRABLE... actually pg lacks "WHERE status='accepted'" on UNIQUE constraint
    -- See partial index alternative below
);

-- Replace constraint with partial unique index (correct pg syntax):
ALTER TABLE bind_requests DROP CONSTRAINT bind_requests_unique_accepted;
CREATE UNIQUE INDEX bind_requests_unique_accepted
  ON bind_requests (student_id, coach_id) WHERE status = 'accepted';

CREATE INDEX bind_requests_coach_status_idx ON bind_requests (coach_id, status);
CREATE INDEX bind_requests_student_status_idx ON bind_requests (student_id, status);
```

> **Note**: `CONSTRAINT ... UNIQUE ... WHERE` is not PG syntax; the `ALTER TABLE DROP CONSTRAINT` + `CREATE UNIQUE INDEX` pattern is the standard partial-unique workaround. Implementer can omit the dropped CONSTRAINT line and write the partial index directly — kept the verbose form here to document the intent.

V0.2+ adds: `evaluation_period_id` FK to a new `evaluation_periods` table, `rejection_reason TEXT NULLABLE`. Out of scope.

#### `0004-seed-internal-users.sql`

```sql
-- Seed: V0.1 internal-testing core users + bond
-- David (coach) + xty (coached_student) + bind_requests row status='accepted'
-- Usage: AFTER migration runs, deploy step must `psql UPDATE` real bcrypt hashes
-- (this file commits PLACEHOLDER hashes; "seed complete" gate is NOT just the migration running)

BEGIN;

-- David coach
INSERT INTO users (id, phone, password_hash, role, created_at, updated_at)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  '+8613800000001',
  '$2b$10$PLACEHOLDER_REPLACE_VIA_PSQL_UPDATE_POST_DEPLOY_______________',
  'coach',
  now(), now()
) ON CONFLICT (phone) DO NOTHING;

-- xty student
INSERT INTO users (id, phone, password_hash, role, created_at, updated_at)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  '+8613800000002',
  '$2b$10$PLACEHOLDER_REPLACE_VIA_PSQL_UPDATE_POST_DEPLOY_______________',
  'coached_student',
  now(), now()
) ON CONFLICT (phone) DO NOTHING;

INSERT INTO coach_profiles (user_id, display_name)
VALUES ('00000000-0000-0000-0000-000000000001', 'David(内测教练)')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO student_profiles (user_id, display_name)
VALUES ('00000000-0000-0000-0000-000000000002', 'xty(内测学员)')
ON CONFLICT (user_id) DO NOTHING;

-- bond: xty (student) ← → David (coach), status='accepted', skip evaluation
INSERT INTO bind_requests (
  id, student_id, coach_id, status, submitted_at, responded_at,
  expired_at, skip_evaluation, rejection_silent
)
VALUES (
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'accepted', now(), now(),
  now() + interval '7 days',
  TRUE,   -- skip 7-day evaluation period
  TRUE    -- no-op for accepted status, but column NOT NULL
)
ON CONFLICT DO NOTHING;

COMMIT;
```

> **Deploy step (out of git, NOT auto-run by `npm run migrate`)**: post-deploy `psql` execute:
>
> ```sh
> # Generate hashes locally (do NOT commit):
> #   node -e "console.log(require('bcrypt').hashSync('David-real-password', 10))"
> #   node -e "console.log(require('bcrypt').hashSync('xty-real-password',   10))"
> # Then:
> psql "$DATABASE_URL" -c "UPDATE users SET password_hash = '\$2b\$10\$REAL_HASH_FOR_DAVID' WHERE id = '00000000-0000-0000-0000-000000000001';"
> psql "$DATABASE_URL" -c "UPDATE users SET password_hash = '\$2b\$10\$REAL_HASH_FOR_XTY'   WHERE id = '00000000-0000-0000-0000-000000000002';"
> ```
>
> Record this as a deploy-checklist item; `0004` migration alone yields non-login-capable accounts.

#### `0005-init-set-logs.sql`

```sql
CREATE TABLE set_logs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_exercise_id UUID NOT NULL REFERENCES plan_exercises(id) ON DELETE CASCADE,
  set_index        INT NOT NULL CHECK (set_index >= 0),
  weight_kg        NUMERIC(6,2) NOT NULL CHECK (weight_kg >= 0 AND weight_kg <= 9999.99),
  reps             INT NOT NULL CHECK (reps >= 0 AND reps <= 99),
  rpe              NUMERIC(3,1) CHECK (rpe IS NULL OR (rpe >= 0 AND rpe <= 10.0)),
  completed        BOOLEAN NOT NULL DEFAULT FALSE,
  logged_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, plan_exercise_id, set_index)
);

CREATE INDEX set_logs_student_logged_idx ON set_logs (student_id, logged_at DESC);
CREATE INDEX set_logs_plan_exercise_idx  ON set_logs (plan_exercise_id);
```

> `rpe ≤ 10.0` CHECK aligns with iOS spec 028 §RPE 边界规则 (`rpe > 10` is invalid input). iOS validates first; this is a defense-in-depth backstop.

#### `0006-init-feedback.sql`

```sql
CREATE TABLE feedback (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_date         DATE,
  plan_exercise_id UUID REFERENCES plan_exercises(id) ON DELETE SET NULL,
  text             TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 2000),
  posted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at          TIMESTAMPTZ
);

CREATE INDEX feedback_student_posted_idx ON feedback (student_id, posted_at DESC);
CREATE INDEX feedback_student_unread_idx ON feedback (student_id, posted_at DESC) WHERE read_at IS NULL;
```

> `DATE` column read via existing pg type parser (OID 1082 returning string, per backend `Hard rule 3`). No timezone drift.

### Authorization helpers

`src/middleware/auth.ts` already has `requireAuth` + `requireRole(...)` from spec 002. Reused as-is — no new middleware.

For ownership checks (coach owns plan with trainee, etc.), pattern is **inline SQL** inside each route handler (per backend `Hard rule 1: No ORM`), not a generic `requireOwnership` middleware. Each route's authorization SQL is colocated with its business logic.

### Error code catalogue (additions)

| Code                               | HTTP | Meaning                                                                                         |
| ---------------------------------- | ---- | ----------------------------------------------------------------------------------------------- |
| `SETS_PLAN_EXERCISE_NOT_PUBLISHED` | 400  | `plan_exercise_id` does not reach a published plan trained by req.user.id                       |
| `SETS_VALIDATION_ERROR`            | 400  | zod validation fails on `POST /sets/log` body                                                   |
| `FEEDBACK_VALIDATION_ERROR`        | 400  | zod validation fails on `POST /coach/feedback` body                                             |
| `FEEDBACK_NOT_FOUND`               | 404  | `PATCH /feedback/:id/read` — feedback ID not exists or not student's                            |
| `BIND_NOT_FOUND`                   | 404  | `GET /coach/students` — no bonds (returns empty list, not error; this code reserved for future) |

`AUTHORIZATION_FORBIDDEN` (403) + `AUTH_INVALID_CREDENTIALS` (401) etc. reused from 001 / 002.

### File layout

```
src/
├── routes/
│   ├── auth.ts                     # 001 (existing)
│   ├── plans.ts                    # 002 (existing) + /plans/* CRUD
│   ├── exercises.ts                # 002 (existing)
│   ├── coach.ts                    # 002 has /coach/students 501 stub — THIS SPEC IMPL ITS BODY
│   ├── student-plans.ts            # 002 (existing) /students/:studentId/plans
│   ├── sets.ts                     # NEW (this spec): POST /sets/log + GET /students/:id/sets
│   └── feedback.ts                 # NEW (this spec): POST /coach/feedback + GET /students/:id/feedback + PATCH /feedback/:id/read
├── handlers/                        # business-logic functions called by routes
│   ├── coach-students.ts           # NEW: GET /coach/students implementation
│   ├── sets-log.ts                 # NEW
│   ├── sets-fetch.ts               # NEW
│   ├── feedback-post.ts            # NEW
│   ├── feedback-fetch.ts           # NEW
│   └── feedback-mark-read.ts       # NEW
└── db/types.ts                      # extend with CoachProfilesTable + StudentProfilesTable + BindRequestsTable + SetLogsTable + FeedbackTable
```

`createApp({ config, logger, db })` registers the new routers per backend `Hard rule 1: composition via factory functions`.

### Tests

| File                                                   | Coverage                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `tests/coach-students.test.ts` (new)                   | GET /coach/students returns 200 with bonded students;empty list when no bonds;403 for non-coach role;auth required |
| `tests/sets-log.test.ts` (new)                         | POST happy path;upsert idempotency;authorization (student self);403 wrong role;400 plan_exercise not published     |
| `tests/sets-fetch.test.ts` (new)                       | GET self;GET as owning coach;date range filter;403 non-owner coach                                                 |
| `tests/feedback-post.test.ts` (new)                    | POST happy;text trim;dayDate / planExerciseId optional;403 not-owning coach                                        |
| `tests/feedback-fetch.test.ts` (new)                   | GET self student;GET as coach;ordering by posted_at DESC;empty list                                                |
| `tests/feedback-mark-read.test.ts` (new)               | PATCH happy;idempotent re-mark (no overwrite of read_at);403 not-self student;404 wrong feedback ID                |
| `tests/migrations/0003.5-profile-tables.test.ts` (new) | Migration runs;UNIQUE PK enforced;CASCADE on user delete                                                           |
| `tests/migrations/0003.6-bind-requests.test.ts` (new)  | Migration runs;partial unique index (only `status='accepted'`)允许多 `pending` 行;CASCADE                          |
| `tests/migrations/0004-seed.test.ts` (new)             | Migration inserts 4 rows (2 users + 2 profiles + 1 bond);idempotent (re-run ON CONFLICT DO NOTHING)                |
| `tests/migrations/0005-set-logs.test.ts` (new)         | UNIQUE enforced;upsert via ON CONFLICT                                                                             |
| `tests/migrations/0006-feedback.test.ts` (new)         | CHECK length;partial index unread                                                                                  |
| `tests/auth-integration.test.ts` (extend if exists)    | Login with seed account after `psql UPDATE` real hash (manual deploy step,test mocks via local-dev hash)           |

Test DB strategy unchanged from 002: per-test transaction rollback via supertest fixture.

### Out of scope

- **Evaluation-workflow** (per PRD §5 #9-#11 / evaluation-workflow.md): `evaluation_periods` table + `bind_requests.evaluation_period_id` + 7-day-硬截止 timer job — V0.2+ separate backend spec
- **Invite codes** (PRD §5 #25): `invite_codes` table + `POST /invite-codes` + `POST /bind-requests` (student-side submit) — V0.1.x candidate-2 full version, separate backend spec
- **Solo bind cancel / coach unbind** — V0.1.x
- **Push notifications** (APNs for new feedback / set log etc.) — V0.1.x separate spec
- **Real-time sync** (WebSocket / SSE) — V1.5+ per ADR-004
- **Feedback edit / delete** — V0.1.x (V0.1 feedback is append-only)
- **Video feedback** (annotations + timestamps on video) — V0.2+ evaluation-workflow stage
- **Per-field permission matrix** (PRD §5 #18 Type A/B/C/D 4-level) — V0.1.x

### Deploy / secrets

- `DATABASE_URL` from Aliyun RDS (iOS spec 026 §1.1) — VPC internal,SAE env var
- Run all migrations in lexicographic order via `npm run migrate` (existing script per 002)
- **Post-migration deploy step**:`psql UPDATE` real bcrypt hashes for David / xty seed rows (not committed)
- Bitwarden vault entry `MeetPR RDS meetpr` stores the real DB password + the 2 user passwords for internal testers

## Estimate (impl PR, after this spec PR lands)

| Block                                                                                          | Days     |
| ---------------------------------------------------------------------------------------------- | -------- |
| 5 migrations + tests                                                                           | 1d       |
| Implement GET /coach/students (replace 501 stub) + tests                                       | 0.4d     |
| Implement POST /sets/log + GET /students/:id/sets + tests                                      | 0.8d     |
| Implement POST /coach/feedback + GET /students/:id/feedback + PATCH /feedback/:id/read + tests | 1d       |
| DB `Database` type extension + integration tests                                               | 0.3d     |
| CI / deploy hook adjustments                                                                   | 0.2d     |
| Manual run-through: migrations + curl all endpoints + Postman collection update                | 0.3d     |
| **Total**                                                                                      | **≈ 4d** |

## Risks / implementer notes

1. **Migration ordering**: `0003.5` / `0003.6` must run after `0003-init-plans.sql` (lex order naturally satisfies). `0004-seed-internal-users` references `0003.5` profiles + `0003.6` bind_requests — if any of the 3 migration fails the seed will too. Run in transaction unit per migration (existing migration script does this).
2. **bcrypt placeholder hash is non-login**: placeholder strings (`$2b$10$PLACEHOLDER...`) are syntactically valid bcrypt format but not real hashes. Login attempts will fail until deploy step `psql UPDATE` runs. CHECKLIST item.
3. **Partial UNIQUE index syntax**: `CREATE UNIQUE INDEX ... WHERE status='accepted'` (the standard pattern). The `CONSTRAINT UNIQUE ... NULLS NOT DISTINCT` syntax in `0003.6` is invalid PG — implementer must use the partial index. SPEC keeps the failed form to document the intent inversion.
4. **`/coach/students` empty-list semantics**: V0.1 `status='accepted'` only. If a coach has 0 students returns `200 { students: [] }` — not 404. iOS spec 029 StudentRosterView empty state handles this.
5. **iOS `MeetPRCodec` decimal-as-string round-trip**: `weightKg` / `rpe` / `target_value` etc. must serialize as JSON string (`"100.00"`) not number — pg's NUMERIC default serialization does this. Don't `Number()` coerce in handlers.
6. **iOS spec 029 hard prerequisite**: this spec's impl PR must land before iOS spec 029 impl PR can start. Track explicitly.
7. **Authorization SQL duplication**: ownership check pattern repeats in ~5 handlers. Per backend `Hard rule 1: No ORM` + composition over abstraction — accept duplication for V0.1; if pattern stabilizes V0.1.x extract `helpers/ownership.ts` with explicit SQL functions (not middleware).

## Codex review focus

- Endpoint contract matches iOS specs 024 / 026 / 029 wire shapes (especially `CoachStudentSummary` / `SetLog` / `Feedback` JSON keys)
- Authorization SQL queries are correct (no IDOR — student can't read other student's sets; coach can't see non-trainee's data)
- `0003.6 bind_requests` enum + partial unique index syntax is valid PG
- `0004 seed` migration is idempotent (`ON CONFLICT DO NOTHING` everywhere; safe to re-run)
- `rpe ≤ 10.0` CHECK aligns with iOS spec 028 §RPE 边界 (`rpe > 10 → nil` invariant)
- Test coverage above is sufficient (8-9 new test files;migrations + endpoints + auth bypass attempts)

## Per AGENTS.md / repo Spec workflow

This is the **spec PR** (Step 1). Codex impl PR (`feat/003-student-actions`) follows after this merges. iOS spec 026 / 029 impl PRs depend on Codex impl PR landing on `staging`.
