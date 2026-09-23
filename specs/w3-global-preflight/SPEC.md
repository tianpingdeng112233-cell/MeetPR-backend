# W3 Global read-only release preflight

Status: Implemented; independent review CLEAN; live read-only run pending

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
No app spec, user rows, passwords, connection strings or raw error details may be
printed or uploaded. Missing or ambiguous resources fail closed.

Public seam: script runner commands/environment and sanitized JSON result;
tests inject realistic DO responses and assert read-only SQL, resource guards,
secret exclusion, and workflow job isolation. Out of scope: deployment, migration,
backup creation/restoration, firewall/permission changes, enabling coach shift,
CN, unrelated 0069 migration. Report exact remaining blockers for separate approval.

Validation: 6 Python guard tests pass; backend 153 suites / 1164 tests, typecheck,
lint, format and build pass. An initial serial run hit one existing admin-test
5-second timeout; the full repeated serial run passed. No runtime code changed.
