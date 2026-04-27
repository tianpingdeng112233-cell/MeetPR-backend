# specs/

Spec-driven workflow: every non-trivial change starts with a SPEC.md inside `specs/NNN-slug/`.

## Format

```
specs/
  000-bootstrap/
    SPEC.md
  001-feature-name/
    SPEC.md
```

## Rules

1. **One spec per change.** A spec defines the scope of a single PR.
2. **Status field is the source of truth.**
   - `Draft` — being written, scope not yet locked
   - `InProgress` — code being written; spec is now immutable
   - `Done` — merged; spec is archived as-is
3. **Immutable once `InProgress`.** If scope changes, write a follow-up spec.
4. **Link from the PR.** Every PR description references its spec.

## Numbering

Three-digit zero-padded, monotonically increasing. Slug is kebab-case.
