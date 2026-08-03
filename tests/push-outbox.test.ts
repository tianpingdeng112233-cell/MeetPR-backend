import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { tryEnqueuePushOutbox } from '../src/services/push-outbox';
import { ids, makeContext } from './helpers/studentActions';

describe('push outbox writer', () => {
  it('silently ignores the event idempotency conflict', async () => {
    const ctx = await makeContext();
    const warn = vi.fn();
    const logger = { ...pino({ level: 'silent' }), warn };
    const values = () => ({
      aggregateId: ids.exercise,
      recipientId: ids.coach,
      payload: { student_name: '陈某', request_id: ids.exercise },
    });

    await tryEnqueuePushOutbox(ctx.db, logger, 'bind_request', values);
    await tryEnqueuePushOutbox(ctx.db, logger, 'bind_request', values);

    expect(
      await ctx.db
        .selectFrom('notification_outbox')
        .select('id')
        .where('event_type', '=', 'bind_request')
        .execute(),
    ).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and resolves when the independent insert fails', async () => {
    const ctx = await makeContext();
    const warn = vi.fn();
    await ctx.db.schema.dropTable('notification_outbox').execute();

    await expect(
      tryEnqueuePushOutbox(ctx.db, { warn }, 'bind_request', () => ({
        aggregateId: ids.exercise,
        recipientId: ids.coach,
        payload: { student_name: '陈某', request_id: ids.exercise },
      })),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'bind_request' }),
      'push_outbox_enqueue_failed',
    );
  });
});
