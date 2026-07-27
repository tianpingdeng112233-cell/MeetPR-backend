import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { TestContext } from './helpers/studentActions';
import { auth, ids, makeContext, signToken } from './helpers/studentActions';

const adminId = '10000000-0000-4000-8000-000000000099';

async function chooseCanonicalCoach(ctx: TestContext, coachId = ids.coach): Promise<void> {
  await ctx.db
    .updateTable('bind_requests')
    .set({ responded_at: new Date('2026-01-01T00:00:00.000Z') })
    .where('student_id', '=', ids.trainee)
    .where('status', '=', 'accepted')
    .execute();
  await ctx.db
    .updateTable('bind_requests')
    .set({ responded_at: new Date('2026-02-01T00:00:00.000Z') })
    .where('student_id', '=', ids.trainee)
    .where('coach_id', '=', coachId)
    .execute();
}

async function createConversation(ctx: TestContext): Promise<string> {
  await chooseCanonicalCoach(ctx);
  const response = await request(ctx.app)
    .post('/conversations')
    .set(auth(ctx.coachToken))
    .send({ other_user_id: ids.trainee });
  expect(response.status).toBe(201);
  return (response.body as { conversation: { id: string } }).conversation.id;
}

describe('POST /conversations', () => {
  it('derives the canonical pair, creates once, and returns the full wrapped wire object', async () => {
    const ctx = await makeContext();
    const conversationId = await createConversation(ctx);

    const repeatedFromOtherDirection = await request(ctx.app)
      .post('/conversations')
      .set(auth(ctx.traineeToken))
      .send({ other_user_id: ids.coach });

    expect(repeatedFromOtherDirection.status).toBe(200);
    expect(repeatedFromOtherDirection.body).toEqual({
      conversation: {
        id: conversationId,
        other_party: { id: ids.coach, display_name: 'Coach A' },
        last_message: null,
        last_message_at: null,
        unread_count: 0,
        my_last_read: null,
        other_last_read: null,
      },
    });
    expect(await ctx.db.selectFrom('conversations').select('id').execute()).toHaveLength(1);
  });

  it('returns CHAT_BIND_REQUIRED for no bond and the non-canonical accepted coach', async () => {
    const ctx = await makeContext();
    await chooseCanonicalCoach(ctx);

    const noBond = await request(ctx.app)
      .post('/conversations')
      .set(auth(ctx.coachToken))
      .send({ other_user_id: ids.otherStudent });
    const nonCanonical = await request(ctx.app)
      .post('/conversations')
      .set(auth(ctx.otherCoachToken))
      .send({ other_user_id: ids.trainee });

    expect(noBond.status).toBe(403);
    expect(noBond.body).toEqual({ error: 'CHAT_BIND_REQUIRED' });
    expect(nonCanonical.status).toBe(403);
    expect(nonCanonical.body).toEqual({ error: 'CHAT_BIND_REQUIRED' });
  });

  it('blocks self-train students and admins at the router-wide role gate', async () => {
    const ctx = await makeContext();
    await ctx.db
      .insertInto('users')
      .values({
        id: adminId,
        phone: '+8613800024099',
        password_hash: 'hash',
        role: 'admin',
      })
      .execute();

    for (const token of [ctx.selfTrainStudentToken, signToken(adminId, 'admin')]) {
      const response = await request(ctx.app).get('/conversations').set(auth(token));
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
    }
  });
});

describe('canonical and member authorization', () => {
  it('prevents ghost writes but preserves member access to non-canonical history', async () => {
    const ctx = await makeContext();
    await chooseCanonicalCoach(ctx);
    const oldConversation = await ctx.db
      .insertInto('conversations')
      .values({ coach_id: ids.otherCoach, student_id: ids.trainee })
      .returning('id')
      .executeTakeFirstOrThrow();
    await ctx.db
      .insertInto('messages')
      .values({
        conversation_id: oldConversation.id,
        seq: 1,
        sender_id: ids.otherCoach,
        kind: 'text',
        body: 'historical',
        attachment_id: null,
        client_id: 'old-1',
      })
      .execute();

    const blockedSend = await request(ctx.app)
      .post(`/conversations/${oldConversation.id}/messages`)
      .set(auth(ctx.otherCoachToken))
      .send({ kind: 'text', body: 'ghost', client_id: 'ghost-1' });
    const historicalRead = await request(ctx.app)
      .get(`/conversations/${oldConversation.id}/messages`)
      .set(auth(ctx.traineeToken));

    expect(blockedSend.status).toBe(403);
    expect(blockedSend.body).toEqual({ error: 'CHAT_BIND_REQUIRED' });
    expect(historicalRead.status).toBe(200);
    expect((historicalRead.body as { messages: { body: string }[] }).messages[0]?.body).toBe(
      'historical',
    );
  });

  it('returns the same 404 envelope to non-members for every conversation-id route', async () => {
    const ctx = await makeContext();
    const conversationId = await createConversation(ctx);

    const responses = await Promise.all([
      request(ctx.app)
        .get(`/conversations/${conversationId}/messages`)
        .set(auth(ctx.otherStudentToken)),
      request(ctx.app)
        .post(`/conversations/${conversationId}/messages`)
        .set(auth(ctx.otherStudentToken))
        .send({ kind: 'text', body: 'nope', client_id: 'outsider-1' }),
      request(ctx.app)
        .post(`/conversations/${conversationId}/read`)
        .set(auth(ctx.otherStudentToken))
        .send({ message_id: '90000000-0000-4000-8000-000000000001' }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'CONVERSATION_NOT_FOUND' });
    }
  });
});

describe('GET /conversations', () => {
  it('orders non-empty before empty and returns unread count, both cursors, and role profiles', async () => {
    const ctx = await makeContext();
    await chooseCanonicalCoach(ctx);
    await ctx.db
      .insertInto('bind_requests')
      .values({
        student_id: ids.otherStudent,
        coach_id: ids.coach,
        status: 'accepted',
        responded_at: new Date('2026-02-01T00:00:00.000Z'),
        expired_at: new Date('2027-01-01T00:00:00.000Z'),
      })
      .execute();

    const active = await ctx.db
      .insertInto('conversations')
      .values({
        coach_id: ids.coach,
        student_id: ids.trainee,
        last_message_at: new Date('2026-06-01T10:03:00.000Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const empty = await ctx.db
      .insertInto('conversations')
      .values({ coach_id: ids.coach, student_id: ids.otherStudent })
      .returning('id')
      .executeTakeFirstOrThrow();
    const historical = await ctx.db
      .insertInto('conversations')
      .values({
        coach_id: ids.otherCoach,
        student_id: ids.trainee,
        last_message_at: new Date('2026-07-01T00:00:00.000Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const messages = await ctx.db
      .insertInto('messages')
      .values([
        {
          conversation_id: active.id,
          seq: 1,
          sender_id: ids.trainee,
          kind: 'text',
          body: 'one',
          attachment_id: null,
          client_id: 'list-1',
          created_at: new Date('2026-06-01T10:01:00.000Z'),
        },
        {
          conversation_id: active.id,
          seq: 2,
          sender_id: ids.coach,
          kind: 'text',
          body: 'two',
          attachment_id: null,
          client_id: 'list-2',
          created_at: new Date('2026-06-01T10:02:00.000Z'),
        },
        {
          conversation_id: active.id,
          seq: 3,
          sender_id: ids.trainee,
          kind: 'image',
          body: null,
          attachment_id: await createChatAttachment(ctx, ids.trainee),
          client_id: 'list-3',
          created_at: new Date('2026-06-01T10:03:00.000Z'),
        },
      ])
      .returning(['id', 'seq'])
      .execute();
    const bySeq = new Map(messages.map((message) => [message.seq, message.id]));
    await ctx.db
      .insertInto('conversation_reads')
      .values([
        { conversation_id: active.id, user_id: ids.coach, last_read_seq: 1 },
        { conversation_id: active.id, user_id: ids.trainee, last_read_seq: 2 },
      ])
      .execute();

    const coachList = await request(ctx.app).get('/conversations').set(auth(ctx.coachToken));
    expect(coachList.status).toBe(200);
    expect(
      (coachList.body as { conversations: { id: string }[] }).conversations.map((c) => c.id),
    ).toEqual([active.id, empty.id]);
    expect((coachList.body as { conversations: unknown[] }).conversations[0]).toMatchObject({
      id: active.id,
      other_party: { id: ids.trainee, display_name: 'Trainee One' },
      last_message: {
        id: bySeq.get(3),
        seq: 3,
        kind: 'image',
        preview: '[图片]',
        sender_id: ids.trainee,
      },
      unread_count: 1,
      my_last_read: { message_id: bySeq.get(1), seq: 1 },
      other_last_read: { message_id: bySeq.get(2), seq: 2 },
    });
    expect((coachList.body as { conversations: unknown[] }).conversations[1]).toMatchObject({
      id: empty.id,
      last_message: null,
      last_message_at: null,
    });

    const studentList = await request(ctx.app).get('/conversations').set(auth(ctx.traineeToken));
    expect(
      (studentList.body as { conversations: { id: string }[] }).conversations.map((c) => c.id),
    ).toEqual([active.id]);
    expect((studentList.body as { conversations: unknown[] }).conversations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: historical.id })]),
    );
  });

  it('uses id DESC as the stable tie-break for equal last_message_at values', async () => {
    const ctx = await makeContext();
    // The harness deliberately leaves ids.coach non-canonical for one student. Since spec 029
    // a former coach's last_message_at falls back to the last *visible* message — null for
    // these synthetic message-less rows — which would sort that row last and stop this test
    // from exercising what it exists for: the id tie-break. Pin ids.coach as the canonical
    // accepted coach for both students so both rows keep their seeded timestamp.
    await ctx.db
      .updateTable('bind_requests')
      .set({ responded_at: new Date('2026-05-01T00:00:00.000Z') })
      .where('student_id', '=', ids.trainee)
      .execute();
    await ctx.db
      .updateTable('bind_requests')
      .set({ responded_at: new Date('2026-05-02T00:00:00.000Z') })
      .where('student_id', '=', ids.trainee)
      .where('coach_id', '=', ids.coach)
      .execute();
    // The harness seeds no bond at all for otherStudent — add one so this row is a
    // current-coach view too.
    await ctx.db
      .insertInto('bind_requests')
      .values({
        student_id: ids.otherStudent,
        coach_id: ids.coach,
        status: 'accepted',
        responded_at: new Date('2026-05-02T00:00:00.000Z'),
        expired_at: new Date('2026-05-22T00:00:00.000Z'),
      })
      .execute();
    const tiedAt = new Date('2026-06-01T10:00:00.000Z');
    const lowerId = '20000000-0000-4000-8000-000000000001';
    const higherId = '20000000-0000-4000-8000-000000000002';
    await ctx.db
      .insertInto('conversations')
      .values([
        {
          id: lowerId,
          coach_id: ids.coach,
          student_id: ids.trainee,
          last_message_at: tiedAt,
        },
        {
          id: higherId,
          coach_id: ids.coach,
          student_id: ids.otherStudent,
          last_message_at: tiedAt,
        },
      ])
      .execute();

    const response = await request(ctx.app).get('/conversations').set(auth(ctx.coachToken));

    expect(
      (response.body as { conversations: { id: string }[] }).conversations.map(
        (conversation) => conversation.id,
      ),
    ).toEqual([higherId, lowerId]);
  });
});

async function createChatAttachment(ctx: TestContext, ownerId: string): Promise<string> {
  const attachment = await ctx.db
    .insertInto('attachments')
    .values({
      owner_id: ownerId,
      kind: 'chat_image',
      oss_key: `attachments/${ownerId}/list-image.jpg`,
      oss_upload_id: 'upload-list',
      content_type: 'image/jpeg',
      size_bytes: 1024,
      filename: 'list-image.jpg',
      set_log_id: null,
      source_plan_id: null,
      source_coach_id: null,
      is_unlinked_explicit: true,
      part_count: 1,
      actual_size_bytes: 1024,
      status: 'ready',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return attachment.id;
}
