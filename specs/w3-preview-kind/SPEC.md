# W3 P-31 conversation preview semantics

Status: Implemented; local acceptance passed; Global deployment pending

Read CONTEXT.md, AGENTS.md and CLAUDE.md first. David authorized completion of
remaining RN W3 items on 2026-09-23. The existing P-31 card requires explicit
preview semantics so RN does not translate ordinary user text that happens to
equal a system marker.

Add `last_message.preview_kind` to conversation HTTP responses. Values are
`text`, `image`, `training_plan`, `training_share`, derived from the same visible
message's stored kind and set_ref.source. Existing preview, canonical message
body, filtering, cursors and push payloads remain unchanged. No schema migration.

Public test seam: authenticated POST message / GET conversations HTTP boundary,
including literal marker text, image, planned/logged references and former-coach
visibility. RN independently accepts missing/null/unknown metadata as legacy
and preserves preview verbatim; only explicit supported system types localize.

Acceptance: old clients retain current fields/values, no additional hidden
message information leaks, type/lint/format/test/build gates pass and independent
Standards/Spec review passes. Deliver a PR; Global deployment is a separate
production gate and is not implied by local test success.

Out of scope: database migration, canonical body changes, push translation,
production operations, new message types, account or role changes.

Validation: typecheck/lint/format/build passed; 153 suites / 1164 tests passed. Independent Standards and Spec reviews CLEAN (one round). The first concurrent regression run hit an unrelated onboarding HTTP 400; isolated and full serial reruns passed.
