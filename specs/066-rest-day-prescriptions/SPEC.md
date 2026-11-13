# 066 — Durable rest-day prescriptions

Status: InProgress. Authorized 2026-11-13 by David together with plan-web 027 final HTML and development through CN release. Base staging 2ea533e. One backend card A.

## Contract

- Add nullable-compatible, default-false `plan_days.is_rest` (migration 0087, pending final remote/applied-number verification). Existing days remain training; no destructive data transformation. Keep day/exercise/set IDs and shifts when only switching type.
- Coach-only opt-in GET `/plans/:id?include_rest_days=true` returns retained days and explicit `is_rest`; default GET (including existing mobile clients) and all student-facing projections exclude rest days and prescriptions. Capability `rest_days_enabled` is exposed only to the opted-in owning coach; mutation flag `PLAN_REST_DAYS_ENABLED` defaults false.
- Extend atomic batch with `day_types: [{day_id, is_rest}]` and optional `is_rest` on inserted days. Existing callers that omit them retain existing behavior. Type update, tree writes and history checks occur in one transaction. Only owning coach can write, read-only statuses reject; logged/completed days reject. Preserve IDs for pure switches. Upserts may include empty draft training days; active empty published days remain rejected by publish/update validation. Rest does not count toward completion, scheduling, active prescriptions, validation or student progression.
- A stale student client cannot log/complete/upload against a rest day. Existing logged history and its reads stay intact because changing logged days is prohibited.
- Gate off prevents new rest mutations; persisted rests must stay hidden from students even when gate is off. Rollback disables switches, retains data and schema, and keeps rest-aware server reads until all rests are deliberately restored. Do not deploy an old rest-unaware server after activating this feature.

## Public test seams / acceptance

HTTP through existing createApp + pg-mem adapters; real interfaces, no private-method mocks. Migration schema test. One red/green behavior per cycle.

- [ ] Owner toggles populated day to rest and back; GET demonstrates ID/content/date stability and durable flag.
- [ ] Student/default old-client GET excludes rest while opted-in owner can read; unrelated coach forbidden.
- [ ] Batch atomic rejection on logged/completed day and concurrent history guard; no partial type/tree writes.
- [ ] Gate off rejects opt-in writes and leaves legacy requests working.
- [ ] Publish validates only active days; progression, counters, next-day/scheduling queries exclude rest.
- [ ] Cached student logging/completion attempts against rest reject; existing history unaffected.
- [ ] Full typecheck/lint/format/tests/build; independent Standards/Spec reviews.
- [ ] Additive migration plan, applied schema/version and feature gate verified before release. Production migration approval obtained per global rule; no destructive operation.

## Out of scope

Student app UI, calendar-enforced recovery, deleting retained prescriptions, retroactive changes to logged days, Global catch-up, unrelated migrations or open PRs. Frontend spec/design is plan-web 027.
