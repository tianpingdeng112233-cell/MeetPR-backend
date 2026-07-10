import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('migration 0035 attachment lifecycle', () => {
  it('declares the immutable provenance columns, status repair, and coach-wall index', () => {
    // pg-mem cannot parse PostgreSQL's UPDATE ... FROM multi-join backfill, so
    // this guards the migration contract while app-level tests cover the new
    // runtime behavior. Production rollout still requires a real PostgreSQL
    // migration dry run (documented in docs/production-security.md).
    const migration = fs.readFileSync('db/migrations/0035-attachment-lifecycle.sql', 'utf8');

    expect(migration).toContain('ADD COLUMN source_plan_id UUID');
    expect(migration).toContain('ADD COLUMN source_coach_id UUID');
    expect(migration).toContain('ADD COLUMN is_unlinked_explicit BOOLEAN NOT NULL DEFAULT FALSE');
    expect(migration).toContain('ADD COLUMN part_count SMALLINT NOT NULL DEFAULT 1');
    expect(migration).toContain('ADD COLUMN actual_size_bytes BIGINT');
    expect(migration).toContain("'deleting'");
    expect(migration).toContain('attachments_source_coach_wall_idx');
  });
});
