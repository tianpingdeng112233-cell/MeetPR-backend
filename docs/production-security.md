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
6. Apply `db/migrations/0029-security-history-hardening.sql` in the normal
   migration runner before deploying code that uses imported-history or upload
   provenance. Verify no old direct plan-tree writer bypasses the API.
7. Set an OSS multipart lifecycle rule to abort incomplete uploads after a short
   period (for example 24 hours). The API provides `POST /uploads/:id/reconcile`
   for client recovery, but it cannot clean uploads whose client never returns.
   When a user deletes an uploaded video/document, the client must call
   `DELETE /uploads/:id` and only remove its local record after the API returns
   `204`; this endpoint removes the OSS object and attachment metadata together.

Once `FORCE_HTTPS=true`, `/health` is intentionally allowed over the private
proxy hop for load-balancer health checks, and all other production requests fail
with `426 HTTPS_REQUIRED` unless Express observes the trusted HTTPS proxy signal.
While `FORCE_HTTPS` is false the app serves HTTP normally and emits no HSTS.
