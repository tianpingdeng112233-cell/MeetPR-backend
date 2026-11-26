# 071 — Actual training date on explicit completion

Status: InProgress. David approved App 115 on 2026-11-26 for the next train. Read CONTEXT.md first.

## Backend card A

Record the date the athlete explicitly confirms when finishing an earlier session. Keep the submission instant for idempotency, plan handoff and seven-day undo. Completed sets keep their own logged dates. Newly filled sets receive the date selected by the client using the existing set log contract. A completion can exist without any set logs.

## API seams and acceptance

- Student plan detail exposes top-level `actual_completion_date_enabled: true` before the client attempts any dated write. A missing capability on older deployments keeps the client on its existing path.
- `POST /plans/days/:dayId/complete` accepts an optional `actual_completion_date` in YYYY-MM-DD format. The persisted date appears under that key on the completion response and on each day in plan detail. No date supplied, legacy records, backfill and uncompleted days return null. Omitted request body keeps ordinary completion behavior.
- Two submissions for an already completed day return the first committed row including its actual date and timestamp. Undo stays relative to submission, even if the athlete confirms a training date more than a week earlier.
- Reject an invalid calendar date with HTTP 400 `VALIDATION_ERROR`, and a date after the athlete's current training day with HTTP 400 `FUTURE_COMPLETION_DATE`. Use the existing 04:00 cutoff in the athlete's timezone. Client restricts choices to the last opening through today. Existing ownership, active-plan and rest checks apply.
- Coach roster “today” and the date of missing-set alerts use the actual date if present. The time when an alert became actionable remains the completion submission instant.
- Verify via actual HTTP routes including a restored plan detail, retry and undo, coach roster, missing-set alert, the local 04:00 boundary, and upgrade of a pre-existing completion row.

## Rollout and rollback

Migration 0091 adds a nullable DATE on plan_day_completions, with no default or backfill. Existing rows retain their original time-based interpretation. Apply the migration before deploying the server and verify the capability before releasing clients. Application rollback keeps the column and previously recorded dates. Do not delete data to roll back.

## Out of Scope

No changes to how the client chooses the cursor or tracks visits, no new clock for undo, no rewriting existing set logs, no historical data inference or administrative date editing. No production migration in this card.
