import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { TestContext } from './helpers/studentActions';
import { auth, ids, makeContext } from './helpers/studentActions';

interface MessageResponse {
  message: {
    id: string;
    conversation_id: string;
    seq: number;
    sender_id: string;
    kind: 'text' | 'image';
    body: string | null;
    attachment_id: string | null;
    image_url: string | null;
    image_expires_in: number | null;
    client_id: string;
    created_at: string;
  };
}

async function createConversation(ctx: TestContext): Promise<string> {
  await ctx.db
    .updateTable('bind_requests')
    .set({ responded_at: new Date('2026-01-01T00:00:00.000Z') })
    .where('student_id', '=', ids.trainee)
    .execute();
  await ctx.db
    .updateTable('bind_requests')
    .set({ responded_at: new Date('2026-02-01T00:00:00.000Z') })
    .where('student_id', '=', ids.trainee)
    .where('coach_id', '=', ids.coach)
    .execute();

  const response = await request(ctx.app)
    .post('/conversations')
    .set(auth(ctx.coachToken))
    .send({ other_user_id: ids.trainee });
  expect(response.status).toBe(201);
  return (response.body as { conversation: { id: string } }).conversation.id;
}

describe('POST /conversations/:id/messages text', () => {
  it('writes the strict wire shape and treats client_id as payload-agnostic idempotency', async () => {
    const ctx = await makeContext();
    const conversationId = await createConversation(ctx);
    const future = new Date('2030-01-01T00:00:00.000Z');
    await ctx.db
      .updateTable('conversations')
      .set({ last_message_at: future })
      .where('id', '=', conversationId)
      .execute();

    const created = await request(ctx.app)
      .post(`/conversations/${conversationId}/messages`)
      .set(auth(ctx.coachToken))
      .send({ kind: 'text', body: 'original', client_id: 'idem-1' });
    const repeatedWithDifferentPayload = await request(ctx.app)
      .post(`/conversations/${conversationId}/messages`)
      .set(auth(ctx.coachToken))
      .send({ kind: 'text', body: 'different', client_id: 'idem-1' });

    expect(created.status).toBe(201);
    expect(repeatedWithDifferentPayload.status).toBe(200);
    const first = (created.body as MessageResponse).message;
    const repeated = (repeatedWithDifferentPayload.body as MessageResponse).message;
    expect(repeated).toEqual(first);
    expect(first).toMatchObject({
      conversation_id: conversationId,
      seq: 1,
      sender_id: ids.coach,
      kind: 'text',
      body: 'original',
      attachment_id: null,
      image_url: null,
      image_expires_in: null,
      client_id: 'idem-1',
    });
    expect(typeof first.seq).toBe('number');
    expect(Number.isNaN(Date.parse(first.created_at))).toBe(false);
    expect(
      await ctx.db
        .selectFrom('messages')
        .select('id')
        .where('conversation_id', '=', conversationId)
        .execute(),
    ).toHaveLength(1);
    expect(
      (
        await ctx.db
          .selectFrom('conversations')
          .select('last_message_at')
          .where('id', '=', conversationId)
          .executeTakeFirstOrThrow()
      ).last_message_at,
    ).toEqual(future);
  });

  it('validates text limits and rechecks the accepted canonical bond on every send', async () => {
    const ctx = await makeContext();
    const conversationId = await createConversation(ctx);

    for (const body of ['', 'x'.repeat(4001)]) {
      const invalid = await request(ctx.app)
        .post(`/conversations/${conversationId}/messages`)
        .set(auth(ctx.coachToken))
        .send({ kind: 'text', body, client_id: `invalid-${String(body.length)}` });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toBe('VALIDATION_ERROR');
    }

    await ctx.db
      .updateTable('bind_requests')
      .set({ status: 'cancelled' })
      .where('student_id', '=', ids.trainee)
      .where('coach_id', '=', ids.coach)
      .execute();
    const unbound = await request(ctx.app)
      .post(`/conversations/${conversationId}/messages`)
      .set(auth(ctx.coachToken))
      .send({ kind: 'text', body: 'blocked', client_id: 'unbound-1' });

    expect(unbound.status).toBe(403);
    expect(unbound.body).toEqual({ error: 'CHAT_BIND_REQUIRED' });
  });

  it('serializes concurrent sends into continuous seq values and deduplicates a concurrent retry', async () => {
    const ctx = await makeContext();
    const conversationId = await createConversation(ctx);
    const path = `/conversations/${conversationId}/messages`;

    const distinct = await Promise.all([
      request(ctx.app)
        .post(path)
        .set(auth(ctx.coachToken))
        .send({ kind: 'text', body: 'one', client_id: 'concurrent-1' }),
      request(ctx.app)
        .post(path)
        .set(auth(ctx.traineeToken))
        .send({ kind: 'text', body: 'two', client_id: 'concurrent-2' }),
    ]);
    expect(distinct.map((response) => response.status)).toEqual([201, 201]);

    const sameClient = { kind: 'text', body: 'same', client_id: 'concurrent-same' };
    const retried = await Promise.all([
      request(ctx.app).post(path).set(auth(ctx.coachToken)).send(sameClient),
      request(ctx.app).post(path).set(auth(ctx.coachToken)).send(sameClient),
    ]);
    expect(retried.map((response) => response.status).sort()).toEqual([200, 201]);
    expect((retried[0].body as MessageResponse).message.id).toBe(
      (retried[1].body as MessageResponse).message.id,
    );

    const rows = await ctx.db
      .selectFrom('messages')
      .select(['seq', 'client_id'])
      .where('conversation_id', '=', conversationId)
      .orderBy('seq', 'asc')
      .execute();
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(new Set(rows.map((row) => row.client_id)).size).toBe(3);
  });
});

describe('GET /conversations/:id/messages pagination', () => {
  it('uses seq for oldest-next since pages, newest-first history pages, and has_more', async () => {
    const ctx = await makeContext();
    const conversationId = await createConversation(ctx);
    const tiedCreatedAt = new Date('2026-07-20T09:00:00.000Z');
    await ctx.db
      .insertInto('messages')
      .values(
        Array.from({ length: 6 }, (_, index) => ({
          conversation_id: conversationId,
          seq: index + 1,
          sender_id: index % 2 === 0 ? ids.coach : ids.trainee,
          kind: 'text' as const,
          body: `message-${String(index + 1)}`,
          attachment_id: null,
          client_id: `page-${String(index + 1)}`,
          created_at: tiedCreatedAt,
        })),
      )
      .execute();

    const sinceFirst = await request(ctx.app)
      .get(`/conversations/${conversationId}/messages?since_seq=1&limit=2`)
      .set(auth(ctx.coachToken));
    const sinceSecond = await request(ctx.app)
      .get(`/conversations/${conversationId}/messages?since_seq=3&limit=2`)
      .set(auth(ctx.coachToken));
    const sinceLast = await request(ctx.app)
      .get(`/conversations/${conversationId}/messages?since_seq=5&limit=2`)
      .set(auth(ctx.coachToken));

    expect(messageSeqs(sinceFirst.body)).toEqual([2, 3]);
    expect(messageMeta(sinceFirst.body).has_more).toBe(true);
    expect(messageSeqs(sinceSecond.body)).toEqual([4, 5]);
    expect(messageMeta(sinceSecond.body).has_more).toBe(true);
    expect(messageSeqs(sinceLast.body)).toEqual([6]);
    expect(messageMeta(sinceLast.body).has_more).toBe(false);

    const before = await request(ctx.app)
      .get(`/conversations/${conversationId}/messages?before_seq=6&limit=2`)
      .set(auth(ctx.coachToken));
    expect(messageSeqs(before.body)).toEqual([5, 4]);
    expect(messageMeta(before.body).has_more).toBe(true);

    const latest = await request(ctx.app)
      .get(`/conversations/${conversationId}/messages?limit=2`)
      .set(auth(ctx.coachToken));
    expect(messageSeqs(latest.body)).toEqual([6, 5]);
    expect(messageMeta(latest.body).has_more).toBe(true);
    expect(
      (latest.body as { messages: { seq: unknown }[] }).messages.every(
        (message) => typeof message.seq === 'number',
      ),
    ).toBe(true);
  });

  it('rejects mixed cursors, non-positive cursors, and limits above 100', async () => {
    const ctx = await makeContext();
    const conversationId = await createConversation(ctx);

    for (const query of ['since_seq=1&before_seq=2', 'since_seq=0', 'before_seq=-1', 'limit=101']) {
      const response = await request(ctx.app)
        .get(`/conversations/${conversationId}/messages?${query}`)
        .set(auth(ctx.coachToken));
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('VALIDATION_ERROR');
    }
  });
});

describe('POST /conversations/:id/read', () => {
  it('advances monotonically, reports unread baseline/count, and rejects a cross-conversation cursor', async () => {
    const ctx = await makeContext();
    const conversationId = await createConversation(ctx);
    const sent: MessageResponse['message'][] = [];
    for (let index = 1; index <= 3; index += 1) {
      const response = await request(ctx.app)
        .post(`/conversations/${conversationId}/messages`)
        .set(auth(ctx.coachToken))
        .send({ kind: 'text', body: `read-${String(index)}`, client_id: `read-${String(index)}` });
      sent.push((response.body as MessageResponse).message);
    }

    const beforeRead = await request(ctx.app).get('/conversations').set(auth(ctx.traineeToken));
    expect(
      (beforeRead.body as { conversations: { unread_count: number; my_last_read: unknown }[] })
        .conversations[0],
    ).toMatchObject({ unread_count: 3, my_last_read: null });

    const second = sent[1];
    const first = sent[0];
    const third = sent[2];
    if (!first || !second || !third) throw new Error('expected three sent messages');
    const advance = await request(ctx.app)
      .post(`/conversations/${conversationId}/read`)
      .set(auth(ctx.traineeToken))
      .send({ message_id: second.id });
    expect(advance.body).toEqual({
      my_last_read: { message_id: second.id, seq: 2 },
      unread_count: 1,
    });

    const noRollback = await request(ctx.app)
      .post(`/conversations/${conversationId}/read`)
      .set(auth(ctx.traineeToken))
      .send({ message_id: first.id });
    expect(noRollback.body).toEqual(advance.body);

    const coachView = await request(ctx.app).get('/conversations').set(auth(ctx.coachToken));
    expect(
      (coachView.body as { conversations: { other_last_read: unknown }[] }).conversations[0]
        ?.other_last_read,
    ).toEqual({ message_id: second.id, seq: 2 });
    const messageView = await request(ctx.app)
      .get(`/conversations/${conversationId}/messages`)
      .set(auth(ctx.coachToken));
    expect(messageMeta(messageView.body).other_last_read).toEqual({
      message_id: second.id,
      seq: 2,
    });

    const oldConversation = await ctx.db
      .insertInto('conversations')
      .values({ coach_id: ids.otherCoach, student_id: ids.trainee })
      .returning('id')
      .executeTakeFirstOrThrow();
    const otherMessage = await ctx.db
      .insertInto('messages')
      .values({
        conversation_id: oldConversation.id,
        seq: 1,
        sender_id: ids.otherCoach,
        kind: 'text',
        body: 'other',
        attachment_id: null,
        client_id: 'cross-1',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const crossConversation = await request(ctx.app)
      .post(`/conversations/${conversationId}/read`)
      .set(auth(ctx.traineeToken))
      .send({ message_id: otherMessage.id });
    expect(crossConversation.status).toBe(400);
    expect(crossConversation.body).toEqual({ error: 'CHAT_INVALID_CURSOR' });

    const clear = await request(ctx.app)
      .post(`/conversations/${conversationId}/read`)
      .set(auth(ctx.traineeToken))
      .send({ message_id: third.id });
    expect(clear.body).toEqual({
      my_last_read: { message_id: third.id, seq: 3 },
      unread_count: 0,
    });
  });
});

function messageSeqs(body: unknown): number[] {
  return (body as { messages: { seq: number }[] }).messages.map((message) => message.seq);
}

function messageMeta(body: unknown): {
  has_more: boolean;
  other_last_read: { message_id: string; seq: number } | null;
} {
  return (
    body as {
      meta: {
        has_more: boolean;
        other_last_read: { message_id: string; seq: number } | null;
      };
    }
  ).meta;
}
