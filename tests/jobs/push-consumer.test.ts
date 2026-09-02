import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { PUSH_POLICY } from '../../src/domain/push-policy';
import { consumePushOutbox, pendingDigestRowQuery } from '../../src/jobs/push-consumer';
import type { ApnsClient, ApnsResult } from '../../src/services/apns';
import { ids, makeContext } from '../helpers/studentActions';

const now = new Date('2026-07-17T08:00:00.000Z');
const logger = pino({ level: 'silent' });

async function addOutbox(
  ctx: Awaited<ReturnType<typeof makeContext>>,
  options: { eventType?: string; attemptCount?: number; payload?: Record<string, unknown> } = {},
): Promise<string> {
  const row = await ctx.db
    .insertInto('notification_outbox')
    .values({
      event_type: options.eventType ?? 'coach_daily_digest',
      aggregate_id: randomUUID(),
      recipient_id: ids.coach,
      payload: JSON.stringify(
        options.payload ?? {
          aps: { alert: { title: '今日训练摘要', body: '1 缺练' } },
          counts: { missed_training: 1 },
          gym_day: '2026-07-17',
        },
      ),
      ...(options.attemptCount === undefined ? {} : { attempt_count: options.attemptCount }),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function addToken(
  ctx: Awaited<ReturnType<typeof makeContext>>,
  token: string,
): Promise<void> {
  await ctx.db
    .insertInto('device_tokens')
    .values({ user_id: ids.coach, token, platform: 'ios' })
    .execute();
}

function fakeClient(result: ApnsResult): { client: ApnsClient; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn<ApnsClient['send']>().mockResolvedValue(result);
  return { client: { send }, send };
}

describe('consumePushOutbox', () => {
  it('localizes copy by the recipient track: phone set → Chinese, phone NULL → English', async () => {
    const ctx = await makeContext();
    const payload = {
      student_name: 'Alex',
      consecutive_days: 1,
      student_id: ids.trainee,
    };
    await addToken(ctx, 'aaaa');

    const cnId = await addOutbox(ctx, { eventType: 'missed_training', payload });
    const cnFake = fakeClient({ ok: true, status: 200 });
    await consumePushOutbox(ctx.db, cnFake.client, now, logger);
    const cnPayload = cnFake.send.mock.calls[0]?.[1] as {
      aps: { alert: { title: string; body: string } };
    };
    expect(cnPayload.aps.alert).toEqual({ title: '学员缺练提醒', body: 'Alex已 1 天未训练' });

    // Same event again for the same coach after the track flips to global.
    await ctx.db.updateTable('users').set({ phone: null }).where('id', '=', ids.coach).execute();
    const globalId = await addOutbox(ctx, { eventType: 'missed_training', payload });
    const globalFake = fakeClient({ ok: true, status: 200 });
    await consumePushOutbox(ctx.db, globalFake.client, now, logger);
    const globalPayload = globalFake.send.mock.calls[0]?.[1] as {
      aps: { alert: { title: string; body: string } };
    };
    expect(globalPayload.aps.alert).toEqual({
      title: 'Missed training',
      body: "Alex hasn't trained for 1 day",
    });

    const statuses = await ctx.db
      .selectFrom('notification_outbox')
      .select(['id', 'status'])
      .where('id', 'in', [cnId, globalId])
      .execute();
    expect(statuses.every((row) => row.status === 'delivered')).toBe(true);
  });

  it('drains unknown pending event types as terminal failures', async () => {
    const ctx = await makeContext();
    const id = await addOutbox(ctx, { eventType: 'legacy_unknown_event' });
    await addToken(ctx, 'aaaa');
    const fake = fakeClient({ ok: true, status: 200 });

    await consumePushOutbox(ctx.db, fake.client, now, logger);

    const row = await ctx.db
      .selectFrom('notification_outbox')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: 'failed',
      attempt_count: 0,
      last_error: 'unknown_event_type',
    });
    expect(fake.send).not.toHaveBeenCalled();
  });

  it('marks the row delivered when every token succeeds', async () => {
    const ctx = await makeContext();
    const id = await addOutbox(ctx);
    await addToken(ctx, 'aaaa');
    await addToken(ctx, 'bbbb');
    const fake = fakeClient({ ok: true, status: 200 });

    await consumePushOutbox(ctx.db, fake.client, now, logger);

    const row = await ctx.db
      .selectFrom('notification_outbox')
      .select(['status', 'attempt_count', 'delivered_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('delivered');
    expect(row.attempt_count).toBe(0);
    expect(row.delivered_at?.toISOString()).toBe(now.toISOString());
    expect(fake.send).toHaveBeenCalledTimes(2);
  });

  it('increments the retry count and records an APNs failure', async () => {
    const ctx = await makeContext();
    const id = await addOutbox(ctx);
    await addToken(ctx, 'aaaa');
    const fake = fakeClient({ ok: false, status: 500, reason: 'InternalServerError' });

    await consumePushOutbox(ctx.db, fake.client, now, logger);

    const row = await ctx.db
      .selectFrom('notification_outbox')
      .select(['status', 'attempt_count', 'last_error'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      status: 'pending',
      attempt_count: 1,
      last_error: 'apns_500:InternalServerError',
    });
  });

  it('marks the row failed when the maximum attempt count is reached', async () => {
    const ctx = await makeContext();
    const id = await addOutbox(ctx, { attemptCount: PUSH_POLICY.maxAttempts - 1 });
    await addToken(ctx, 'aaaa');
    const fake = fakeClient({ ok: false, status: 503 });

    await consumePushOutbox(ctx.db, fake.client, now, logger);

    const row = await ctx.db
      .selectFrom('notification_outbox')
      .select(['status', 'attempt_count'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'failed', attempt_count: PUSH_POLICY.maxAttempts });
  });

  it('deletes a token rejected with 410 and continues sending to other tokens', async () => {
    const ctx = await makeContext();
    const id = await addOutbox(ctx);
    await addToken(ctx, 'aaaa');
    await addToken(ctx, 'bbbb');
    const send = vi.fn<ApnsClient['send']>((token) =>
      Promise.resolve(
        token === 'aaaa'
          ? { ok: false, status: 410, reason: 'Unregistered' }
          : { ok: true, status: 200 },
      ),
    );

    await consumePushOutbox(ctx.db, { send }, now, logger);

    const tokens = await ctx.db.selectFrom('device_tokens').select('token').execute();
    const row = await ctx.db
      .selectFrom('notification_outbox')
      .select(['status', 'attempt_count'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(tokens).toEqual([{ token: 'bbbb' }]);
    // A terminally-dead token must not fail the row: bbbb already received the
    // push, so retrying would deterministically duplicate it.
    expect(row).toEqual({ status: 'delivered', attempt_count: 0 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('marks the row failed-path when every token is terminally unregistered', async () => {
    const ctx = await makeContext();
    const id = await addOutbox(ctx);
    await addToken(ctx, 'aaaa');
    const fake = fakeClient({ ok: false, status: 410, reason: 'Unregistered' });

    await consumePushOutbox(ctx.db, fake.client, now, logger);

    const row = await ctx.db
      .selectFrom('notification_outbox')
      .select(['status', 'attempt_count', 'last_error'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(await ctx.db.selectFrom('device_tokens').select('id').execute()).toEqual([]);
    // Terminal: retrying cannot reach anyone; a later-registered token gets
    // the NEXT day's digest instead of this stale one.
    expect(row).toEqual({
      status: 'failed',
      attempt_count: 1,
      last_error: 'all_tokens_unregistered',
    });
  });

  it('passes the builder collapse id on every send', async () => {
    const ctx = await makeContext();
    const conversationId = randomUUID();
    await addOutbox(ctx, {
      eventType: 'chat_message',
      payload: {
        sender_name: '王晨曦',
        preview: '今天练吗？',
        conversation_id: conversationId,
        seq: 3,
      },
    });
    await addToken(ctx, 'aaaa');
    const send = vi.fn<ApnsClient['send']>(() => Promise.resolve({ ok: true, status: 200 }));

    await consumePushOutbox(ctx.db, { send }, now, logger);

    expect(send).toHaveBeenCalledWith(
      'aaaa',
      {
        aps: {
          alert: { title: '王晨曦', body: '今天练吗？' },
          sound: 'default',
          'thread-id': 'chat_message',
        },
        kind: 'chat_message',
        conversation_id: conversationId,
        seq: 3,
      },
      {
        collapseId: `conv-${conversationId}`,
      },
    );
  });

  it('falls back to the outbox row id as collapse id when the builder sets none', async () => {
    const ctx = await makeContext();
    const outboxId = await addOutbox(ctx);
    await addToken(ctx, 'aaaa');
    const send = vi.fn<ApnsClient['send']>(() => Promise.resolve({ ok: true, status: 200 }));

    await consumePushOutbox(ctx.db, { send }, now, logger);

    // Digest retries after a partial multi-device failure must keep replacing
    // the already-delivered copy instead of stacking a duplicate banner.
    expect(send).toHaveBeenCalledWith(
      'aaaa',
      expect.anything(),
      expect.objectContaining({ collapseId: outboxId }),
    );
  });

  it('accepts an emoji preview truncated by code points on the write side', async () => {
    const ctx = await makeContext();
    const conversationId = randomUUID();
    // 31 emoji = 31 code points but 62 UTF-16 code units: a code-unit cap
    // would permanently fail a row the write side considers valid.
    const preview = '😀'.repeat(31);
    await addOutbox(ctx, {
      eventType: 'chat_message',
      payload: {
        sender_name: '王晨曦',
        preview,
        conversation_id: conversationId,
        seq: 4,
      },
    });
    await addToken(ctx, 'aaaa');
    const send = vi.fn<ApnsClient['send']>(() => Promise.resolve({ ok: true, status: 200 }));

    await consumePushOutbox(ctx.db, { send }, now, logger);

    expect(send).toHaveBeenCalledWith(
      'aaaa',
      expect.objectContaining({
        aps: expect.objectContaining({ alert: { title: '王晨曦', body: preview } }),
      }),
      expect.anything(),
    );
  });

  it('fails one malformed row without blocking the rest of the batch', async () => {
    const ctx = await makeContext();
    const malformedId = await addOutbox(ctx, {
      eventType: 'chat_message',
      payload: { conversation_id: randomUUID() },
    });
    const deliveredId = await addOutbox(ctx, {
      eventType: 'bind_request',
      payload: { student_name: '陈某', request_id: randomUUID() },
    });
    await addToken(ctx, 'aaaa');
    const fake = fakeClient({ ok: true, status: 200 });

    await consumePushOutbox(ctx.db, fake.client, now, logger);

    const rows = await ctx.db
      .selectFrom('notification_outbox')
      .select(['id', 'status', 'last_error'])
      .where('id', 'in', [malformedId, deliveredId])
      .execute();
    expect(rows.find((row) => row.id === malformedId)).toMatchObject({
      status: 'failed',
      last_error: expect.stringContaining('payload_builder_error:'),
    });
    expect(rows.find((row) => row.id === deliveredId)).toMatchObject({ status: 'delivered' });
    expect(fake.send).toHaveBeenCalledOnce();
  });

  it('locks pending rows with FOR UPDATE SKIP LOCKED in production SQL', async () => {
    const ctx = await makeContext();
    const compiled = pendingDigestRowQuery(
      ctx.db,
      '00000000-0000-4000-8000-000000000000',
    ).compile();
    expect(compiled.sql.toLowerCase()).toContain('for update skip locked');
  });

  it('treats a recipient with no device tokens as a retryable failure', async () => {
    const ctx = await makeContext();
    const id = await addOutbox(ctx);
    const fake = fakeClient({ ok: true, status: 200 });

    await consumePushOutbox(ctx.db, fake.client, now, logger);

    const row = await ctx.db
      .selectFrom('notification_outbox')
      .select(['status', 'attempt_count', 'last_error'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      status: 'pending',
      attempt_count: 1,
      last_error: 'no_device_tokens',
    });
    expect(fake.send).not.toHaveBeenCalled();
  });

  it('does not resend a delivered row when the worker runs again', async () => {
    const ctx = await makeContext();
    await addOutbox(ctx);
    await addToken(ctx, 'aaaa');
    const fake = fakeClient({ ok: true, status: 200 });

    await consumePushOutbox(ctx.db, fake.client, now, logger);
    await consumePushOutbox(ctx.db, fake.client, now, logger);

    expect(fake.send).toHaveBeenCalledTimes(1);
  });
});
