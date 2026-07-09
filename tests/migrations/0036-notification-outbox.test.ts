import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('migration 0036 notification outbox', () => {
  it('declares the durable outbox table and pending-delivery index', () => {
    const migration = fs.readFileSync('db/migrations/0036-notification-outbox.sql', 'utf8');

    expect(migration).toContain('CREATE TABLE notification_outbox');
    expect(migration).toContain("status IN ('pending', 'delivered', 'failed')");
    expect(migration).toContain('UNIQUE (event_type, aggregate_id, recipient_id)');
    expect(migration).toContain('notification_outbox_pending_idx');
  });
});
