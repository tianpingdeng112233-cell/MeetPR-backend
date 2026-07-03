# AGENTS.md — Implementer Rules

For non-Claude-Code agents (Codex, etc.) executing tasks in this repo.

## Roles

- **Engineer (Claude)** — reads SPEC, designs, reviews
- **Implementer (Codex / agent)** — writes code per SPEC, opens PR, addresses review

## Startup checklist

Before touching any file:

1. Read the linked `specs/NNN-slug/SPEC.md`. Status must be `InProgress`.
2. `pnpm install` (installs the husky hook via the `prepare` script)
3. `pnpm typecheck && pnpm lint && pnpm test` — confirm baseline is green
4. Create a feature branch off `staging`
5. **迁移取号(若本次新增 `db/migrations` 文件)。** 下一个号 = `max(A, B, C) + 1`,现场核对、别凭记忆:
   - **A** = `git ls-tree --name-only origin/staging db/migrations` 的最大号
   - **B** = `gh pr list --state open` 里每个 open PR 已占用的号
   - **C** = 已直跑 prod RDS 但未合回 staging 的号

   被抢号时 rebase 一并改:文件名 + 文件头 `-- Migration NNNN:` 注释 + 配套 `tests/migrations/NNNN-*.test.ts`。规则权威在 `CLAUDE.md` Hard rule 2。

## During implementation

- Stay inside the spec scope. Out-of-scope changes go in a follow-up SPEC.
- Run `pnpm test` frequently (target every 5–10 minutes of work).
- Don't add business logic to scaffolding files (`app.ts`, `server.ts`, `config.ts`) without coordination.
- Don't change ADR-mandated choices (no ORM, no Apple-specific code, etc.).

## Hard rules

- ❌ Never `git commit --no-verify`
- ❌ Never `git push --force` to `main`
- ❌ Never edit `~/Brain/wiki/` from this repo
- ❌ Never commit `.env` (gitignored, but verify)
- ❌ Never log secrets, JWTs, or passwords (pino has redact paths configured)

## Before opening a PR

- All gates pass: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build`
- PR description links the spec
- Verification checklist in the PR template is filled out
