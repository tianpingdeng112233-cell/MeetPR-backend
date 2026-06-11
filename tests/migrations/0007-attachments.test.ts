import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

const studentId = '10000000-0000-4000-8000-000000000003';

describe('migration 0007 attachments', () => {
  it('creates the attachments table with kind/status/size checks and the owner index', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0007-init-attachments.sql');

    mem.public.none(`
      INSERT INTO attachments (owner_id, kind, oss_key, oss_upload_id, content_type, size_bytes)
      VALUES (
        '${studentId}',
        'set_video',
        'attachments/${studentId}/aaaaaaaa-0000-4000-8000-000000000001.mp4',
        'upload-1',
        'video/mp4',
        52428800
      );
    `);

    const rows = mem.public.many('SELECT * FROM attachments');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'set_video', status: 'uploading' });

    // kind CHECK
    expect(() => {
      mem.public.none(`
        INSERT INTO attachments (owner_id, kind, oss_key, content_type, size_bytes)
        VALUES ('${studentId}', 'avatar', 'attachments/x/1.png', 'image/png', 1024);
      `);
    }).toThrow();

    // status CHECK
    expect(() => {
      mem.public.none(`
        INSERT INTO attachments (owner_id, kind, oss_key, content_type, size_bytes, status)
        VALUES ('${studentId}', 'onboarding_doc', 'attachments/x/2.png', 'image/png', 1024, 'deleted');
      `);
    }).toThrow();

    // size_bytes > 0 CHECK
    expect(() => {
      mem.public.none(`
        INSERT INTO attachments (owner_id, kind, oss_key, content_type, size_bytes)
        VALUES ('${studentId}', 'onboarding_doc', 'attachments/x/3.png', 'image/png', 0);
      `);
    }).toThrow();

    // oss_key UNIQUE
    expect(() => {
      mem.public.none(`
        INSERT INTO attachments (owner_id, kind, oss_key, content_type, size_bytes)
        VALUES (
          '${studentId}',
          'set_video',
          'attachments/${studentId}/aaaaaaaa-0000-4000-8000-000000000001.mp4',
          'video/mp4',
          1024
        );
      `);
    }).toThrow();

    const migrationSql = fs.readFileSync('db/migrations/0007-init-attachments.sql', 'utf8');
    expect(migrationSql).toContain(
      'CREATE INDEX attachments_owner_created_idx ON attachments (owner_id, created_at DESC)',
    );
    expect(migrationSql).toContain('ON DELETE CASCADE');
  });
});
