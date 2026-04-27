# 001-auth

**Status:** Ready
**Date:** 2026-04-27

## Goal

Land password-based authentication for the three V1 user roles (`coach`, `coached_student`, `self_train_student`): register, login, and refresh-token rotation. Ship the first hand-managed migration that initializes the `users` table per [data-model.md v1.1 §1.1](~/Brain/wiki/projects/MeetPR/data-model.md). Apple Sign-In and Aliyun SMS OTP integration are explicitly deferred — only their placeholder seams (`apple_user_id` column, OTP stub function) ship in this spec.

Refs: [ADR 003 v4](~/Brain/wiki/projects/MeetPR/decisions/003-dual-end-native-architecture.md) (single role per user, V1) · [ADR 004](~/Brain/wiki/projects/MeetPR/decisions/004-backend-selection.md) (no ORM, hand-managed SQL, JWT dual-token + bcrypt 10 rounds).

## Scope

### Endpoints

| Method + Path         | Request body                | Success                                   | Errors                                                                           |
| --------------------- | --------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| `POST /auth/register` | `{ phone, password, role }` | `201 { user, accessToken, refreshToken }` | `400 VALIDATION_ERROR` · `409 AUTH_PHONE_TAKEN`                                  |
| `POST /auth/login`    | `{ phone, password }`       | `200 { user, accessToken, refreshToken }` | `400 VALIDATION_ERROR` · `401 AUTH_INVALID_CREDENTIALS`                          |
| `POST /auth/refresh`  | `{ refreshToken }`          | `200 { accessToken, refreshToken }`       | `400 VALIDATION_ERROR` · `401 AUTH_INVALID_REFRESH` · `401 AUTH_REFRESH_EXPIRED` |

`user` shape returned to clients:

| Field       | Type                                                   | Source                                 |
| ----------- | ------------------------------------------------------ | -------------------------------------- |
| `id`        | `string` (uuid)                                        | `users.id`                             |
| `phone`     | `string` (E.164)                                       | `users.phone`                          |
| `role`      | `'coach' \| 'coached_student' \| 'self_train_student'` | `users.role`                           |
| `createdAt` | `string` (ISO-8601)                                    | `users.created_at` (TIMESTAMPTZ → ISO) |

The existing `requireAuth` middleware at [src/middleware/auth.ts](src/middleware/auth.ts) already validates the access JWT and populates `req.user`. **No changes to this middleware in this spec** — the access tokens issued here must satisfy its `AccessTokenPayloadSchema` (`{ sub: non-empty string, role: enum }`).

### Validation (zod)

| Field          | Rule                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `phone`        | string, regex `^\+[1-9]\d{7,14}$` (E.164, 8–15 digits, leading non-zero). Stored verbatim.                          |
| `password`     | string, length ≥ 8 chars **and** UTF-8 byte length ≤ 72 (bcrypt input limit; refuse rather than silently truncate). |
| `role`         | `z.enum(['coach', 'coached_student', 'self_train_student'])`.                                                       |
| `refreshToken` | non-empty string.                                                                                                   |

Outbound payloads (`user`, tokens) are not zod-validated on the way out — they're constructed from trusted DB rows and signed JWTs.

### Token model

Both tokens are HS256 JWTs signed with **disjoint secrets** (`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`, both ≥32 chars per existing [src/config.ts](src/config.ts)). Cross-use is impossible at the signature layer, so we don't add a `type` discriminator claim.

|                   | Access                              | Refresh                                            |
| ----------------- | ----------------------------------- | -------------------------------------------------- |
| Secret            | `JWT_ACCESS_SECRET`                 | `JWT_REFRESH_SECRET`                               |
| TTL               | `JWT_ACCESS_TTL` (default `15m`)    | `JWT_REFRESH_TTL` (default `30d`)                  |
| Claims            | `{ sub: <userId>, role, iat, exp }` | `{ sub: <userId>, role, jti, iat, exp }`           |
| Server-side state | none                                | `users.refresh_token_jti` must equal `payload.jti` |

#### Register / login flow (text)

1. zod-validate body. Failure → `400 VALIDATION_ERROR`.
2. **(login only)** `SELECT id, password_hash, role FROM users WHERE phone = $1`. No row → `401 AUTH_INVALID_CREDENTIALS`. Then `bcrypt.compare(password, password_hash)`; false → `401 AUTH_INVALID_CREDENTIALS`. Both branches return the same code to prevent phone enumeration.
3. **(register only)** `password_hash = bcrypt.hash(password, 10)`. `INSERT users(phone, password_hash, role, ...) RETURNING id, phone, role, created_at`. On Postgres unique-violation (`code === '23505'` on `users_phone_key`) → `409 AUTH_PHONE_TAKEN`.
4. Generate `jti = crypto.randomUUID()`. `UPDATE users SET refresh_token_jti = $jti, updated_at = now() WHERE id = $userId`.
5. Sign access JWT (claims above, no `jti`) and refresh JWT (claims above, with `jti`).
6. Return `{ user, accessToken, refreshToken }`.

#### Refresh flow (rotation + reuse detection)

1. zod-validate body.
2. `jwt.verify(refreshToken, JWT_REFRESH_SECRET)`:
   - `TokenExpiredError` → `401 AUTH_REFRESH_EXPIRED`.
   - any other verify error, or payload-shape mismatch (must contain `sub: string`, `role: enum`, `jti: uuid`) → `401 AUTH_INVALID_REFRESH`.
3. `SELECT id, role, refresh_token_jti FROM users WHERE id = $sub`. Row not found → `401 AUTH_INVALID_REFRESH`.
4. **Reuse detection**: if `users.refresh_token_jti !== payload.jti` (mismatch or NULL), set `users.refresh_token_jti = NULL` (forces full re-login) and return `401 AUTH_INVALID_REFRESH`.
5. Generate new `jti`, `UPDATE users SET refresh_token_jti = $newJti, updated_at = now() WHERE id = $userId` (single statement; concurrent rotation is naturally serialized via row lock since the refresh path always writes before reading the new value).
6. Sign new access + refresh pair. **Use `users.role` from the DB row, not the JWT claim** — guards against an out-of-band role change.
7. Return `{ accessToken, refreshToken }`.

V1 implication: a single `refresh_token_jti` column means **at most one device's refresh token is live at a time**. A second login (e.g. iPad after iPhone) invalidates the first device's refresh. Multi-device tracking requires a separate `refresh_tokens` table — deferred (see Out of scope).

### Migration `db/migrations/0001-init-users.sql`

```sql
-- Migration 0001: initialize users table.
-- Spec: specs/001-auth/SPEC.md
-- ADR: 003 v4 (single role per user, V1) · 004 (no ORM, hand-managed SQL).

BEGIN;

CREATE TABLE users (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  phone               TEXT         NOT NULL,
  apple_user_id       TEXT,
  password_hash       TEXT         NOT NULL,
  role                TEXT         NOT NULL,
  refresh_token_jti   UUID,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT users_phone_key  UNIQUE (phone),
  CONSTRAINT users_role_check CHECK (role IN ('coach', 'coached_student', 'self_train_student'))
);

-- Apple Sign-In (deferred): nullable column with partial unique index — only enforces
-- uniqueness for rows that actually have an apple_user_id, so V1 password-only users
-- don't conflict on NULL.
CREATE UNIQUE INDEX users_apple_user_id_key
  ON users (apple_user_id)
  WHERE apple_user_id IS NOT NULL;

COMMIT;
```

Notes:

- `gen_random_uuid()` is built-in on PostgreSQL 13+. Aliyun RDS runs 17.0 (per ADR 004 §6); no `CREATE EXTENSION pgcrypto` needed.
- `updated_at` is touched by application code on every UPDATE (e.g. `SET refresh_token_jti = ..., updated_at = now()`). No trigger — keeps the migration minimal and the source visible at the call site.
- No DATE columns in this migration; the OID-1082 parser registered in [src/db/pool.ts](src/db/pool.ts) is irrelevant here but stays the contract for future DATE columns.
- Profile fields from data-model.md v1.1 §1.1 (`name`, `avatar_url`, `gender`, `birth_date`, `height_cm`, `weight_kg`, `unit_system`) are **not** in this migration. They land in a later spec (`/me` PATCH or onboarding). Adding them via `ALTER TABLE ADD COLUMN` is straightforward; nothing in this migration precludes it.

After the migration lands, augment [src/db/types.ts](src/db/types.ts):

- Add a `UsersTable` interface with the columns above (`id`, `phone`, `apple_user_id`, `password_hash`, `role`, `refresh_token_jti`, `created_at`, `updated_at`). Use Kysely's `Generated<T>` for the defaulted columns (`id`, `created_at`, `updated_at`). `apple_user_id` and `refresh_token_jti` are `string | null`.
- Add `users: UsersTable` to the `Database` interface and remove the `eslint-disable-next-line @typescript-eslint/no-empty-object-type` line — the interface is no longer empty.

### Error envelope

All error responses share the shape mandated by [CLAUDE.md](CLAUDE.md):

```json
{ "error": "<MACHINE_CODE>", "...details": "..." }
```

| Code                       | HTTP | Triggered by                                                                                 | Details                                                                                                              |
| -------------------------- | ---- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`         | 400  | zod parse fail on request body                                                               | `{ "issues": [{ "path": ["..."], "message": "..." }] }` (mapped from `ZodError.issues` — no internal codes / values) |
| `AUTH_INVALID_CREDENTIALS` | 401  | login: phone not found OR bcrypt mismatch                                                    | (no extra fields — uniform to prevent phone enumeration)                                                             |
| `AUTH_PHONE_TAKEN`         | 409  | register: phone already in `users`                                                           | (none)                                                                                                               |
| `AUTH_INVALID_REFRESH`     | 401  | refresh: bad signature / unknown user / jti mismatch / payload-shape mismatch                | (none)                                                                                                               |
| `AUTH_REFRESH_EXPIRED`     | 401  | refresh: `jwt.TokenExpiredError`                                                             | (none)                                                                                                               |
| `RATE_LIMITED`             | 429  | global limiter (already wired in [src/middleware/rateLimit.ts](src/middleware/rateLimit.ts)) | (existing — unchanged)                                                                                               |

Stack traces never reach the client. The unhandled-error path in [src/middleware/errorHandler.ts](src/middleware/errorHandler.ts) keeps its existing `500 internal_error` envelope.

### Logging

The existing pino redact paths in [src/logger.ts](src/logger.ts) (`req.headers.authorization`, `req.headers.cookie`, `*.password`, `*.token`) are baseline correct for headers and shallow log objects. The auth handlers must not log request bodies or token values. Concretely:

- Log only structured fields like `logger.info({ userId, role }, 'auth_register_success')`.
- **Never** log `password`, `accessToken`, `refreshToken`, or the entire `req.body`.
- Add `*.refreshToken` and `*.accessToken` to the redact path list as belt-and-suspenders for any object spreading that escapes review.

### Stub helpers (deferred-but-shipped seams)

- **`src/services/sms.ts`** — exports `async function sendOtp(phone: string): Promise<string>` that returns `"000000"` and emits a `sms_stub_called` warn-level log. Not wired to any route in this PR. Exists so the next spec wiring real Aliyun 短信 OTP can replace the body without churning import sites.
- **No `POST /auth/apple-sign-in` route** — not even a 501 stub. The `apple_user_id` column is the only seam this spec ships. Future Apple Sign-In spec adds the route.

## Out of scope

- `POST /auth/apple-sign-in` (real or stub). Column `apple_user_id` is the reserved seam; route is deferred.
- Aliyun SMS OTP integration. Stub function ships, not wired.
- **Multi-device refresh tracking**. V1 ships single-device (one live `refresh_token_jti` per user). Multi-device requires a `refresh_tokens` table — separate spec.
- Profile fields on `users` (`name`, `avatar_url`, `gender`, `birth_date`, `height_cm`, `weight_kg`, `unit_system`) — added when `/me` PATCH or onboarding spec lands.
- `coach_profiles` / `student_profiles` tables. The bind / invite / coach-dashboard / student-plan endpoints (already 501 stubs) stay 501 stubs.
- Logout / session-revocation endpoint. Refresh-reuse detection covers token-theft mitigation; explicit logout is a small follow-up spec.
- Password reset / change-password.
- Per-phone or per-route rate limiting (the global limiter applies as-is).
- DB connection-pool tuning, RDS SSL toggle, whitelist hardening — covered by [FOLLOWUPS.md](FOLLOWUPS.md) and ADR 004 §6.
- Local Postgres docker-compose harness for integration tests (also FOLLOWUPS).

## Verification

End-to-end smoke (local PG 17 with the migration applied — set up your own or use the harness if it lands in this PR):

```bash
psql "$DATABASE_URL" -f db/migrations/0001-init-users.sql
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build

# happy path
curl -fsS -X POST localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"phone":"+8613800000001","password":"hunter2hunter2","role":"coach"}'
```

### Acceptance checklist

- [ ] `db/migrations/0001-init-users.sql` applies cleanly to a fresh PG 17 database (no `CREATE EXTENSION` needed).
- [ ] `users` has `UNIQUE(phone)`, partial `UNIQUE(apple_user_id) WHERE apple_user_id IS NOT NULL`, `CHECK(role IN (...))`.
- [ ] [src/db/types.ts](src/db/types.ts) augmented with `users: UsersTable`; the empty-interface eslint-disable is removed.
- [ ] `POST /auth/register` returns `201 { user, accessToken, refreshToken }` for a valid body. Inserted row has bcrypt hash matching `^\$2[ayb]\$10\$` and a UUID `refresh_token_jti`.
- [ ] `POST /auth/login` returns `200` with the same shape and rotates `refresh_token_jti`.
- [ ] `POST /auth/refresh` returns `200` with a new pair; the old refresh token now fails reuse detection.
- [ ] All 5 application error codes are emitted with the correct HTTP status and envelope shape.
- [ ] `VALIDATION_ERROR` payloads include an `issues` array with `path` + `message` (no internal zod codes / received values leaked).
- [ ] bcrypt rounds = `10` (constant in code, no env flag).
- [ ] Access TTL honors `JWT_ACCESS_TTL` (default `15m`); refresh TTL honors `JWT_REFRESH_TTL` (default `30d`).
- [ ] pino redact path list includes `*.refreshToken` and `*.accessToken`. Manual log inspection during a register call shows neither plaintext password nor either token in the captured log lines.
- [ ] OTP stub `src/services/sms.ts::sendOtp` returns `"000000"` and is not wired to any route.
- [ ] No new Apple Sign-In route. `apple_user_id` column exists and is nullable.
- [ ] vitest + supertest suite (below) passes: 3 happy-path + 8 edge-case tests.
- [ ] All gates green: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build`.
- [ ] No `git commit --no-verify` was used.
- [ ] [FOLLOWUPS.md](FOLLOWUPS.md) updated: cross off "First migration: define users, coach_profiles, student_profiles tables" (this spec does `users` only); add new follow-ups for `coach_profiles` / `student_profiles` migration, multi-device refresh tracking, profile fields on `users`.

### Test plan (vitest + supertest)

Layout: pure logic in `tests/unit/`, HTTP round-trips in `tests/smoke/`, both using the `createApp` factory and a real Kysely instance backed by either a docker-compose Postgres (if the FOLLOWUPS harness lands in the same PR) **or** the `pg-mem` adapter as a fallback. Mock at the network/DB boundary only — per CLAUDE.md "Code standards" — never mock zod, bcrypt, or jwt.

#### Happy paths (3)

1. **register** → `201` + `{ user, accessToken, refreshToken }`. Row exists; `password_hash` matches `^\$2[ayb]\$10\$`; `refresh_token_jti` is a UUID. `jwt.verify(accessToken, JWT_ACCESS_SECRET)` decodes to `{ sub: user.id, role }`.
2. **login** with the same phone+password → `200` + new tokens. The new `refresh_token_jti` differs from the registration's.
3. **refresh** with the most recent refresh token → `200` + new tokens. The new refresh token's `jti` differs from the previous; the new access token's `sub` matches the user's id.

#### Edge cases (8 — ≥5 required)

1. **register** with a phone that already exists → `409 AUTH_PHONE_TAKEN`.
2. **login** with the right phone + wrong password → `401 AUTH_INVALID_CREDENTIALS`.
3. **login** with a phone that doesn't exist → `401 AUTH_INVALID_CREDENTIALS` (same code — no enumeration).
4. **refresh** with a JWT signed with `exp` already in the past → `401 AUTH_REFRESH_EXPIRED`.
5. **refresh** reusing a token that was already rotated → `401 AUTH_INVALID_REFRESH`; subsequent SELECT shows `users.refresh_token_jti IS NULL`.
6. **register** with `role: "admin"` → `400 VALIDATION_ERROR`; issues array includes `{ path: ["role"], … }`.
7. **register** with `phone: "13800000000"` (missing `+` country prefix) → `400 VALIDATION_ERROR`.
8. **refresh** with body `{ refreshToken: "garbage" }` → `401 AUTH_INVALID_REFRESH`.

#### Logging assertion (smoke or unit)

With a pino destination collecting log lines (e.g. `pino({ ... }, sink)`), perform a register call with a known password and assert that **no captured line contains the literal password string or either token string**.
