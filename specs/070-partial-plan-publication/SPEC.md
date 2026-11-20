# 070 — Publish the prescribed part of a plan

Status: InProgress. David approved retaining unfilled training days on 2026-11-20. Read CONTEXT.md first. This card supersedes the empty-day publication rule in 066.

## Backend card A

Keep each empty training day in the coach's calendar. Publish when at least one active exercise has a prescription and all active exercises contain sets. A day with no exercise can remain empty. Deliver only scheduled lessons to students. Preserve already logged or completed days, including historical days with only student-added work. Keep existing rest and history protections.

## Public seams and acceptance

Use the coach publish, plan detail and atomic day batch routes, and student plan detail, handoff, day completion and logging routes. Publish a mixed draft, reopen as both users, verify only the coach sees the empty date, then fill that slot and verify the student sees it. Preserve the original calendar identity and shift when filling an unlogged empty slot. Empty-only and zero-set plans still fail. Check that placeholders do not count towards student schedules, alerts or progress. Student queries cannot enable coach access. Verify legacy training history remains accessible.

## Out of Scope

No client release, destructive cleanup, data backfill or production change. The only schema change is additive migration 0090 (`plan_days.is_placeholder`, default false), so existing days keep their meaning and need no backfill. Existing plan start/end dates and explicit rests retain their meaning.

## Rollout

Deploy the backend first. Detail and batch responses then carry `partial_plan_publication_enabled: true`; the web editor refuses to write empty training days into a published plan until it sees that flag, so a web build that lands first cannot deliver empty sessions to students.
