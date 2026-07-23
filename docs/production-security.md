# Production security checklist

The service deliberately cannot create a public certificate or choose a public
domain. HTTPS is therefore a **go-live blocker, not an immediate deploy step**:
the service can be deployed to production before TLS is ready, and the HTTPS
enforcement below stays dormant until `FORCE_HTTPS=true` is set. Flip that switch
only after the business license + ICP filing are approved and the domain TLS
certificate is live, then supply the matching runtime environment values.

1. Put an Aliyun CLB/ALB or equivalent trusted reverse proxy in front of SAE.
   Terminate a valid TLS certificate there, redirect public HTTP to HTTPS, and
   do not expose the Node `PORT`/3000 directly to the internet.
2. Configure the proxy to send `X-Forwarded-Proto: https` only after it has
   terminated TLS. Set `TRUST_PROXY` to the exact number of trusted hops
   (normally `1`), never a broad or guessed value.
3. At HTTPS go-live, set `FORCE_HTTPS=true`, `PUBLIC_BASE_URL` to the confirmed
   `https://` API URL, and `CORS_ORIGIN` to the exact comma-separated HTTPS web
   origins. With `FORCE_HTTPS=true`, production startup rejects a wildcard CORS
   policy, missing HTTPS URL, or `TRUST_PROXY=0`. While `FORCE_HTTPS` is false
   these HTTPS/CORS shape checks are skipped so a pre-TLS build still boots.
4. Leave `REGISTRATION_ENABLED` unset/false for the closed beta. Pre-provision
   all accounts and coaches. If a small student cohort must self-register, set
   `REGISTRATION_ENABLED=true` and an explicit `REGISTRATION_ALLOWLIST`; coach
   self-registration remains disabled.
5. Generate independent `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` values
   (at least 32 characters). The process refuses equal secrets. Rotate both if
   the old HTTP endpoint ever carried credentials; users may then need to log in
   again.
6. Apply `db/migrations/0035-attachment-lifecycle.sql` and
   `db/migrations/0036-notification-outbox.sql` (the set-log history-retention
   and `assumed` marker already shipped in `0034-imported-history-assumed.sql`)
   before deploying code that uses upload provenance or publish notifications.
   Verify no old direct plan-tree writer bypasses the API.
7. Set an OSS multipart lifecycle rule to abort incomplete uploads after a short
   period (for example 24 hours). The API provides `POST /uploads/:id/reconcile`
   for client recovery, but it cannot clean uploads whose client never returns.
   When a user deletes an uploaded video/document, the client must call
   `DELETE /uploads/:id` and only remove its local record after the API returns
   `204`; this endpoint removes the OSS object and attachment metadata together.

## Data backups（数据备份）

1. Treat RDS automatic backups and point-in-time recovery as the primary,
   business-critical recovery path. Enable them for every production database,
   monitor backup success, and retain recovery points for at least 7 days.
2. Before every migration or dangerous data operation, run
   `pnpm tsx scripts/backup-db.ts`. Confirm that it prints an absolute archive
   path and a non-zero compressed size; use `--out-dir <directory>` when the
   default local `./backups/` directory is not appropriate.
3. Keep `backup-db.ts` as the application-layer fallback, not a replacement for
   RDS backups. Store its `.sql.gz` archives securely, restrict access, retain
   them for at least 7 days, and periodically test restoration in an isolated
   non-production database.

## Test account cleanup（测试账号清理）

1. Apply `db/migrations/0049-add-users-is-test.sql` before cleanup and mark
   disposable accounts with `users.is_test`; never infer that real learner data
   is disposable from a phone number alone. Migration 0049 marks only the two
   exact `(id, phone)` pairs seeded by 0004. For any other existing test account,
   verify it first and use an exact-ID statement such as
   `UPDATE public.users SET is_test = true WHERE id = '<reviewed-uuid>';`.
   Account provisioning (including `/testacct`) should set `is_test=true` when
   the disposable account is created; never bulk-mark a phone or UUID range.
2. Run `pnpm tsx scripts/delete-test-accounts.ts` first and review the default
   dry-run account list, warnings, and per-table foreign-key impact counts. Copy
   the apply command it prints; that command contains one `--id` for every
   reviewed candidate.
3. Run the printed `--apply --id <uuid> ...` command only after review. Apply
   requires at least one explicit ID, must complete its mandatory full backup
   before connecting for deletion, and deletes only the supplied IDs that still
   match both `is_test=true` and the test phone/UUID allowlist. Any supplied ID
   outside that intersection aborts the whole transaction; allowlisted accounts
   not supplied are skipped.
4. Never hand-write `DELETE FROM users` for test-account cleanup. Investigate
   every `is_test=true` row that the script warns about and skips instead of
   widening or bypassing the allowlist.

Once `FORCE_HTTPS=true`, `/health` is intentionally allowed over the private
proxy hop for load-balancer health checks, and all other production requests fail
with `426 HTTPS_REQUIRED` unless Express observes the trusted HTTPS proxy signal.
While `FORCE_HTTPS` is false the app serves HTTP normally and emits no HSTS.
