# Review — 002-coach-planning-crud

**Reviewer:** Claude · **Date:** 2026-04-28 · **Verdict:** Request changes

## TL;DR

Strong spec overall. Format-compliant, faithful to data-model.md §1.4 + §1.8, strict 1:1 round-trip with iOS spec 004 (Decimal-as-string preserved, snake_case verbatim, all 5 enum families and `main_lift_family` Optional all match), ADR-003/004 fully respected, 404-vs-403 handling thoughtful, test plan exhaustive (16 happy + 22 edge = 38). Out-of-scope list and FOLLOWUPS are crisp.

Blocking: one real SQL bug in migration `0002` (P1). The two array CHECK constraints fail to enforce non-empty under PostgreSQL's NULL semantics — the spec text claims they do, but the SQL doesn't. Codex will copy-paste this verbatim. Fix is one operator change per CHECK.

After the P1 + P2 items below, this is mergeable. The P3 items are doc / defense-in-depth polish; either fix in this revision or carry forward.

Counts: **P0:0 P1:1 P2:2 P3:4**.

---

## P1 — must fix

### 1. `exercises_muscle_groups_valid` and `exercises_equipment_valid` CHECKs do not reject empty arrays

`SPEC.md` lines 175-184 (migration `0002-init-exercises.sql`) and the prose note at line 235 ("The two `array_length(... , 1) >= 1` checks enforce non-empty `muscle_groups` and `equipment` at the DB level"):

```sql
CONSTRAINT exercises_muscle_groups_valid CHECK (
  muscle_groups <@ ARRAY[
    'chest','shoulder','back','biceps','triceps','core','quad','hamstring','glute'
  ]::TEXT[]
  AND array_length(muscle_groups, 1) >= 1
),
CONSTRAINT exercises_equipment_valid CHECK (
  equipment <@ ARRAY['barbell','dumbbell','machine','bodyweight']::TEXT[]
  AND array_length(equipment, 1) >= 1
)
```

PostgreSQL semantics for an empty array `'{}'`:

- `array_length('{}'::TEXT[], 1)` returns **`NULL`** (zero-dim array has no length on dim 1)
- `NULL >= 1` evaluates to `NULL`
- `TRUE AND NULL` evaluates to `NULL`
- A `CHECK` constraint passes when the expression is `TRUE` or `NULL` (SQL "unknown is not a violation")
- Therefore `INSERT ... VALUES (..., '{}', '{}', ...)` succeeds

So these CHECKs **do not** enforce non-empty as the prose claims. Mitigation today is the zod `min(1)` rules in §Validation, which gate at the API layer — but the spec sells these CHECKs as DB-level defense-in-depth, and that defense is silently absent. Direct DB writes (psql, future migrations, future stored procs) bypass the invariant.

**Fix:** replace `array_length(x, 1) >= 1` with `cardinality(x) >= 1`. `cardinality('{}'::TEXT[])` returns `0`, and `0 >= 1` is `FALSE` → the CHECK rejects. `cardinality()` has been in PostgreSQL since 9.4; RDS 17.0 supports it.

```sql
CONSTRAINT exercises_muscle_groups_valid CHECK (
  muscle_groups <@ ARRAY[
    'chest','shoulder','back','biceps','triceps','core','quad','hamstring','glute'
  ]::TEXT[]
  AND cardinality(muscle_groups) >= 1
),
CONSTRAINT exercises_equipment_valid CHECK (
  equipment <@ ARRAY['barbell','dumbbell','machine','bodyweight']::TEXT[]
  AND cardinality(equipment) >= 1
)
```

`movement_pattern` intentionally allows empty (e.g. squat / abs seed rows pass `ARRAY[]::TEXT[]`); leave its CHECK alone.

---

## P2 — recommended fix

### 2. `end_date >= start_date` cross-field validation is asserted by the test plan but missing from the §Validation table

Edge-case test 8 (line 722) requires `POST /plans` with `end_date < start_date` → `400` cross-field issue. The migration's `plans_dates_order_check` enforces this at the DB layer — fine, but it would surface as a Postgres CHECK violation, not a `VALIDATION_ERROR` envelope, unless zod also enforces it.

The §Validation field table (lines 110-138) documents `start_date` / `end_date` only as date-format regex — no cross-field rule. The other cross-field rules (`source='template'` ⇔ `source_template_id`, `target_reps_max >= target_reps`, `accessory ⇔ main_lift_family IS NULL`, `intensity_mode='rpe' ⇒ value ∈ [1,10]`) are spelled out. This one is silently implicit, which is inconsistent and asks the implementer to infer the rule from the test plan.

**Fix:** add a row (or note) to the §Validation table:

> Cross-field on `POST /plans`, `PATCH /plans/:id`: if both `start_date` and `end_date` are present, require `end_date >= start_date`. Failure → `400 VALIDATION_ERROR` (envelope-uniform with the other cross-field issues, not a DB CHECK violation).

### 3. Student visibility gap: students cannot resolve coach-custom `exercise_id` referenced in their published plans

`SPEC.md` line 55 (Exercise catalog visibility):

> Visibility rule for both routes: `created_by_coach_id IS NULL` (system-seeded) **OR** `created_by_coach_id = req.user.id` (own customs). [...] Students see only system-seeded exercises (`created_by_coach_id IS NULL`).

`PlanWithChildren` (lines 442-489) carries only `exercise_id: <uuid>` per `PlanExercise`, not an embedded `Exercise`. To render a plan, iOS must resolve those UUIDs to names / facets via `GET /exercises`. There is no `GET /exercises/:id` (explicitly out of scope, line 634).

Failure mode: a coach creates a custom exercise (e.g. "侧蹬"), inserts it into Student S's plan, publishes. Student S calls `GET /plans/:id` and gets `exercise_id: <侧蹬-uuid>` — but `GET /exercises` excludes coach customs, so the UUID is unresolvable from the student side. Student app would render "unknown exercise" or fall back on the bundled iOS catalog, which doesn't have "侧蹬" either.

The spec doesn't address this. Three reasonable resolutions:

1. **Loosen student visibility** to also include any `exercise_id` referenced in plans the student is the trainee of. (Simplest, no wire-shape change.)
2. **Embed Exercise** inside `PlanExercise` in `PlanWithChildren` (response shape change; iOS would need to update Codable types, which contradicts "round-trip 1:1 with iOS spec 004").
3. **Forbid coach customs in trainee-bound plans for V1** — coaches can use customs only in self-train / draft plans. (Product constraint; needs to be stated.)

Option 1 is the cleanest and doesn't churn iOS. Recommended unless there's a reason to defer the question to a follow-up — in which case explicitly call this out in §Out of scope and add a FOLLOWUPS entry.

---

## P3 — nice-to-have

### 4. Migration `0002` seed comment is off-by-one

Line 203: `-- Initial seed: 6 main / variations + 8 accessories.` The actual `INSERT` lists 3 squat (`竞技深蹲` / `高杠深蹲` / `哈克深蹲`) + 2 bench + 2 deadlift = 7 main/variations. Acceptance criterion at line 672 says 15 total, which matches 7 + 8. Update the comment to "7 main / variations + 8 accessories".

### 5. `POST /plans/:id/publish` ownership row in §Authorization implies a "second SELECT" that the actual flow doesn't use

Line 82 (table row for publish):

> Owner SQL predicate: `id = $1 AND coach_id = $userId AND status = 'draft'` ... `404 PLAN_NOT_FOUND` (no plan or wrong owner) **OR** `409 PLAN_NOT_DRAFT` (correct owner, wrong status — distinguish with a second SELECT before the UPDATE)

But the actual publish flow at lines 533-535 uses a **single** `SELECT id, coach_id, status FROM plans WHERE id = $planId FOR UPDATE` and branches in app code on `coach_id` and `status`. The "second SELECT" mention is leftover from a different approach and risks Codex implementing two queries instead of one (less efficient, holds the row lock longer for nothing).

**Fix:** in the table row, change the owner predicate to `id = $1 AND coach_id = $userId` and reword the branch column to "`404` if no row / wrong owner; `409` if owner matches but `status <> 'draft'` (single `SELECT ... FOR UPDATE` then branch in code per § Publish flow)".

### 6. `name TEXT` columns have no DB-level length cap

`exercises.name` and `plans.name` are `TEXT` with no length constraint. `name` zod is `trim().min(1).max(120)`. zod gates today, but a `CHECK (length(name) BETWEEN 1 AND 120)` is one line of defense-in-depth and matches the API contract. Same argument as the array CHECKs — the spec is otherwise rigorous about defending invariants at the DB layer.

### 7. `target_value` regex allows 3+ decimal places, which `NUMERIC(6,2)` silently truncates

§Validation line 127: `coerce to a string matching ^\d+(\.\d+)?$`. A client sending `"180.555"` passes the regex, the cross-field rules (`weight > 0 AND < 1000`), and pg silently rounds to `180.56` on insert. The wire response then comes back as `"180.56"` — a non-trivial round-trip mismatch for the coach. Tighten to `^\d+(\.\d{1,2})?$` so the API rejects extra precision up-front rather than letting pg round.

Realistically powerlifting weights are 0.5kg / 2.5kg increments and RPE is 0.5 increments, so this won't fire in normal use. Cheap to harden anyway.

---

## What I checked and found clean

- **Spec format** (`specs/README.md`): Status / Date / numbering / kebab-case slug all conform. Section structure mirrors spec 001. ✓
- **Data model fidelity** (data-model.md v1.1 §1.4 Exercise, §1.8 Plan tree): every field name / type / nullability matches. snake_case preserved end-to-end. ✓
- **iOS spec 004 round-trip**: Exercise / TrainingPlan / PlanDay / PlanExercise / PlanSet all 1:1. `target_value` Decimal-as-string contract enforced (NUMERIC(6,2), no OID-1700 parser). All 9 enum value sets match (`MuscleGroup`/`Equipment`/`MovementPattern`/`ExerciseType`/`LiftFamily`/`PlanSource`/`PlanStatus`/`IntensityMode`/`SetType`). `main_lift_family` Optional ↔ nullable column with `accessory ⇔ NULL` enforced both in zod and DB CHECK. ✓
- **ADR-003 v4** (single role): `requireRole('coach')` gates all mutations; student paths read-only on published plans; no multi-role logic. Self-train (coach_id IS NULL) explicitly deferred. ✓
- **ADR-004**: no ORM (Kysely as SQL builder per CLAUDE.md), hand-managed migrations, JWT (reuses spec-001 `requireAuth`), V1 polling ≤30s SLA preserved (no WebSocket, no /notify endpoint, only forward-looking `notifyPlanPublished` log stub). DATE-as-text and NUMERIC-as-string explicitly maintained. ✓
- **Authz red lines**:
  - 404 for "plan not owned by coach" across all `/plans/*` mutation paths — no ID enumeration leak across coaches. ✓
  - 403 only for "student requesting another student's data" and `requireRole` mismatch — appropriate. ✓
  - `EXERCISE_NOT_FOUND_OR_HIDDEN` (400) for exercise IDs that exist but belong to another coach — caller can't disambiguate. ✓
  - `POST /plans/:id/publish` is its own endpoint, not a `PATCH status='published'` — anti-foot-gun (PATCH explicitly disallows `status='draft'` in zod, line 119). ✓
- **SQL constraints** (modulo P1): FK cascades correct (plans→users RESTRICT; plan_days/exercises/sets CASCADE; plan_exercises→exercises RESTRICT). All CHECK constraints comprehensive. Index choices match query patterns (GIN on facet arrays for `&&`; partial idx on nullable owner columns; composite idx for nested-fetch ordering). ✓
- **Validation completeness**: 16 single-field rules + 5 cross-field rules. `algorithm` PlanSource explicitly rejected at the API while remaining a valid DB enum value (V2 schema-only future-proofing). ✓
- **Test plan**: 16 happy paths (one per route), 22 edge cases across authz / validation / state / cascade / shape, plus a logging assertion. Coverage maps cleanly to acceptance criteria. ✓
- **Scope discipline**: ProgressionRule / WeekTemplate / e1RM / videos / coach feedback / evaluation / self-train / Aliyun / multi-device refresh / Apple Sign-In / E2E / per-coach rate limit / `GET /exercises/:id` / pool tuning all listed out-of-scope. FOLLOWUPS additions are concrete and align with the deferred items. ✓
- **Bind-relationship deferral**: explicitly acknowledged that `bind_requests` table doesn't exist yet, iOS UX is the gate, FOLLOWUPS entry added. Reasonable for V1 dogfood. ✓

---

## Summary of changes requested

1. **P1 #1** — replace `array_length(x, 1) >= 1` with `cardinality(x) >= 1` in both `exercises_muscle_groups_valid` and `exercises_equipment_valid`. Migration `0002`.
2. **P2 #2** — add `end_date >= start_date` cross-field rule to §Validation table.
3. **P2 #3** — resolve student-visibility gap for coach-custom exercises referenced in their published plans (recommended: loosen student visibility to include exercises in their own plans; otherwise add explicit FOLLOWUP and Out-of-scope entry).
4. **P3 #4** — fix seed comment count "6 → 7".
5. **P3 #5** — reword publish-row in §Authorization to match the single-`SELECT FOR UPDATE` flow at lines 533-535.
6. **P3 #6** — add `CHECK (length(name) BETWEEN 1 AND 120)` on `exercises.name` and `plans.name`.
7. **P3 #7** — tighten `target_value` regex to `^\d+(\.\d{1,2})?$`.

After these, ready to flip Status to `Ready` and merge into `staging`.
