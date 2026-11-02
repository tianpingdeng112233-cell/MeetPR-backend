import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { tryEnqueuePushOutbox } from '../src/services/push-outbox';
import { buildPushPayload } from '../src/jobs/push-payloads';
import { request } from './helpers/inMemoryRequest';
import { auth, ids, makeContext } from './helpers/studentActions';

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

describe('bind_ended push', () => {
  it.each([
    ['zh', '王教练', '王教练已与你解绑', '训练记录都还在，输入邀请码可重新绑定'],
    ['zh-Hant', '王教练', '王教练已與你解綁', '訓練記錄都還在，輸入邀請碼可重新綁定'],
    [
      'en',
      'Alex',
      'Alex has unlinked you',
      'Your training history is kept. Enter an invite code to link again.',
    ],
    ['zh', null, '教练已与你解绑', '训练记录都还在，输入邀请码可重新绑定'],
    ['zh-Hant', '  ', '教練已與你解綁', '訓練記錄都還在，輸入邀請碼可重新綁定'],
    [
      'en',
      '',
      'Your coach has unlinked you',
      'Your training history is kept. Enter an invite code to link again.',
    ],
  ] as const)('builds %s copy with coach %s', (locale, coachName, title, body) => {
    const payload = buildPushPayload(
      'bind_ended',
      { coach_name: coachName, student_id: ids.trainee, request_id: ids.exercise },
      locale,
    );
    expect(payload.alert).toEqual({ title, body });
    expect(payload.custom).toEqual({
      kind: 'bind_ended',
      student_id: ids.trainee,
      request_id: ids.exercise,
    });
  });

  it('enqueues once after unbind and survives an outbox failure', async () => {
    const warn = vi.fn();
    const logger = pino({ level: 'silent' });
    logger.warn = warn;
    const ctx = await makeContext(logger, { config: { PUSH_ENABLED: true } });
    const unbind = () =>
      request(ctx.app).post(`/coach/students/${ids.trainee}/unbind`).set(auth(ctx.coachToken));
    expect((await unbind()).status).toBe(200);
    const rows = await ctx.db
      .selectFrom('notification_outbox')
      .selectAll()
      .where('event_type', '=', 'bind_ended')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient_id: ids.trainee,
      payload: { student_id: ids.trainee, request_id: expect.any(String) },
    });
    expect((await unbind()).status).toBe(404);
    expect(
      await ctx.db
        .selectFrom('notification_outbox')
        .selectAll()
        .where('event_type', '=', 'bind_ended')
        .execute(),
    ).toHaveLength(1);
    await ctx.db
      .updateTable('bind_requests')
      .set({ status: 'accepted', ended_at: null })
      .where('student_id', '=', ids.trainee)
      .where('coach_id', '=', ids.coach)
      .execute();
    await ctx.db.schema.dropTable('notification_outbox').execute();
    expect((await unbind()).status).toBe(200);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'bind_ended' }),
      'push_outbox_enqueue_failed',
    );
  });
});
