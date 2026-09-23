# W3 Global read-only release preflight

Status: Implemented; independent review CLEAN; live read-only run passed (35857998786)

Read CONTEXT.md, AGENTS.md and CLAUDE.md. David authorized completing W3;
production deployment and migration remain separately gated.

The old live service rejects coach shift and lacks explicit preview semantics.
Before preparing production approval, inspect the actual active app deployment,
coach-shift flag, database migration ledger and backup metadata. Use the existing
GitHub-held DO credential only inside its runner; no credentials leave the job.

Add an explicit read-only mode to the existing manual Global deployment workflow.
When selected, the deploy job must be skipped regardless of other inputs. The
preflight performs only DO reads and a PostgreSQL READ ONLY transaction with
TLS verify-full, short statement/connection timeouts, and allowlisted output.
No complete app spec, user rows, passwords, connection strings or raw error details may be
printed or uploaded. Missing or ambiguous resources fail closed.

Public seam: script runner commands/environment and sanitized JSON result;
tests inject realistic DO responses and assert read-only SQL, resource guards,
secret exclusion, and workflow job isolation. Out of scope: deployment, migration,
backup creation/restoration, firewall/permission changes, enabling coach shift,
CN, unrelated 0069 migration. Expose the existing coach-shift gate as an explicit
manual-deploy input (default false); this prepares the approved spec045 behavior
but does not authorize any deployment or enabling it. Report exact remaining blockers for separate approval.

Validation: 8 Python guard tests pass; backend 153 suites / 1164 tests, typecheck,
lint, format and build pass. An initial serial run hit one existing admin-test
5-second timeout; the full repeated serial run passed. No runtime code changed.

Live read-only run 35857998786 succeeded; deploy job skipped. Active image tag is
sha-7ce724538b385104efdea9e549ddad65657a7dc9, PG17.11 ledger0068, no0070 tables/column,
coach flag absent. Backup metadata exists through2026-09-23T10:02:08Z; restore not
verified. Full image digest was not exposed by active spec. Candidate repository
at1b9c6f5 contains0070 as its only unapplied migration;0069 remains outside this ref.
