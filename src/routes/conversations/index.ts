import { randomUUID } from 'node:crypto';

import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { sql } from 'kysely';

import { resolveCanonicalAcceptedBond } from '../../db/bonds';
import type { ConversationsTable, Database, MessagesTable } from '../../db/types';
import { timestamp } from '../../handlers/serialization';
import type { Logger } from '../../logger';
import { requireRole } from '../../middleware/auth';
import type { OssService } from '../../services/oss';
import { uuidEquals } from '../../utils/uuid';
import { route, validationEnvelope } from '../http';
import {
  ConversationIdParamSchema,
  CreateConversationBodySchema,
  ListMessagesQuerySchema,
  ReadConversationBodySchema,
  SendMessageBodySchema,
} from './schemas';

const IMAGE_URL_TTL_SECONDS = 900;
const MAX_SEQUENCE_ALLOCATION_ATTEMPTS = 5;
const MESSAGE_IDEMPOTENCY_CONSTRAINT = 'messages_conversation_id_sender_id_client_id_key';
const MESSAGE_SEQUENCE_CONSTRAINT = 'messages_conversation_id_seq_key';

type DbExecutor = Kysely<Database> | Transaction<Database>;
type ConversationRow = Selectable<ConversationsTable>;
type MessageRow = Selectable<MessagesTable>;
type SendMessageResult =
  | { outcome: 'bind_required' }
  | { outcome: 'invalid_attachment' }
  | { outcome: 'not_found' }
  | { outcome: 'sequence_conflict' }
  | { outcome: 'message'; message: MessageRow; created: boolean };

interface ConversationsRouterDeps {
  db: Kysely<Database>;
  logger: Logger;
  oss?: OssService | undefined;
}

interface ReadCursorWire {
  message_id: string;
  seq: number;
}

interface MessageWire {
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
}

interface ConversationWire {
  id: string;
  other_party: { id: string; display_name: string };
  last_message: {
    id: string;
    seq: number;
    kind: 'text' | 'image';
    preview: string;
    created_at: string;
    sender_id: string;
  } | null;
  last_message_at: string | null;
  unread_count: number;
  my_last_read: ReadCursorWire | null;
  other_last_read: ReadCursorWire | null;
}

function otherParticipantId(conversation: ConversationRow, userId: string): string {
  return uuidEquals(conversation.coach_id, userId)
    ? conversation.student_id
    : conversation.coach_id;
}

function isConversationMember(conversation: ConversationRow, userId: string): boolean {
  return uuidEquals(conversation.coach_id, userId) || uuidEquals(conversation.student_id, userId);
}

async function findConversationForMember(
  db: DbExecutor,
  conversationId: string,
  userId: string,
): Promise<ConversationRow | undefined> {
  const conversation = await db
    .selectFrom('conversations')
    .selectAll()
    .where('id', '=', conversationId)
    .executeTakeFirst();
  return conversation && isConversationMember(conversation, userId) ? conversation : undefined;
}

async function fetchReadCursor(
  db: DbExecutor,
  conversationId: string,
  userId: string,
): Promise<ReadCursorWire | null> {
  const cursor = await db
    .selectFrom('conversation_reads as cr')
    .innerJoin('messages as m', (join) =>
      join
        .onRef('m.conversation_id', '=', 'cr.conversation_id')
        .onRef('m.seq', '=', 'cr.last_read_seq'),
    )
    .select(['m.id as message_id', 'cr.last_read_seq as seq'])
    .where('cr.conversation_id', '=', conversationId)
    .where('cr.user_id', '=', userId)
    .executeTakeFirst();

  return cursor ?? null;
}

async function fetchUnreadCount(
  db: DbExecutor,
  conversationId: string,
  userId: string,
  lastReadSeq: number | null,
): Promise<number> {
  const unread = await db
    .selectFrom('messages')
    .select((eb) => eb.fn.countAll<string | number>().as('count'))
    .where('conversation_id', '=', conversationId)
    .where('sender_id', '!=', userId)
    .where('seq', '>', lastReadSeq ?? 0)
    .executeTakeFirstOrThrow();

  return Number(unread.count);
}

async function serializeMessage(
  row: MessageRow & { attachment_oss_key: string | null },
  oss: OssService | undefined,
): Promise<MessageWire> {
  const isImage = row.kind === 'image';
  const imageUrl =
    isImage && oss && row.attachment_oss_key !== null
      ? await oss.signGetUrl(row.attachment_oss_key, IMAGE_URL_TTL_SECONDS)
      : null;

  return {
    id: row.id,
    conversation_id: row.conversation_id,
    seq: row.seq,
    sender_id: row.sender_id,
    kind: row.kind,
    body: row.body,
    attachment_id: row.attachment_id,
    image_url: imageUrl,
    image_expires_in: isImage ? IMAGE_URL_TTL_SECONDS : null,
    client_id: row.client_id,
    created_at: timestamp(row.created_at),
  };
}

async function fetchMessageWire(
  db: Kysely<Database>,
  messageId: string,
  oss: OssService | undefined,
): Promise<MessageWire> {
  const row = await db
    .selectFrom('messages as m')
    .leftJoin('attachments as a', 'a.id', 'm.attachment_id')
    .selectAll('m')
    .select('a.oss_key as attachment_oss_key')
    .where('m.id', '=', messageId)
    .executeTakeFirstOrThrow();

  return serializeMessage(row, oss);
}

async function fetchConversationWire(
  db: Kysely<Database>,
  conversation: ConversationRow,
  viewerId: string,
): Promise<ConversationWire> {
  const viewerIsCoach = uuidEquals(conversation.coach_id, viewerId);
  const otherId = otherParticipantId(conversation, viewerId);

  const [profile, lastMessage, myLastRead, otherLastRead] = await Promise.all([
    viewerIsCoach
      ? db
          .selectFrom('student_profiles')
          .select('display_name')
          .where('user_id', '=', otherId)
          .executeTakeFirst()
      : db
          .selectFrom('coach_profiles')
          .select('display_name')
          .where('user_id', '=', otherId)
          .executeTakeFirst(),
    db
      .selectFrom('messages')
      .select(['id', 'seq', 'kind', 'body', 'created_at', 'sender_id'])
      .where('conversation_id', '=', conversation.id)
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst(),
    fetchReadCursor(db, conversation.id, viewerId),
    fetchReadCursor(db, conversation.id, otherId),
  ]);

  const unreadCount = await fetchUnreadCount(
    db,
    conversation.id,
    viewerId,
    myLastRead?.seq ?? null,
  );

  return {
    id: conversation.id,
    other_party: { id: otherId, display_name: profile?.display_name ?? '' },
    last_message: lastMessage
      ? {
          id: lastMessage.id,
          seq: lastMessage.seq,
          kind: lastMessage.kind,
          preview: lastMessage.kind === 'image' ? '[图片]' : (lastMessage.body ?? ''),
          created_at: timestamp(lastMessage.created_at),
          sender_id: lastMessage.sender_id,
        }
      : null,
    last_message_at:
      conversation.last_message_at === null ? null : timestamp(conversation.last_message_at),
    unread_count: unreadCount,
    my_last_read: myLastRead,
    other_last_read: otherLastRead,
  };
}

function canonicalPairMatches(
  conversation: Pick<ConversationRow, 'coach_id' | 'student_id'>,
  canonical: { coach_id: string; student_id: string } | undefined,
): boolean {
  return (
    canonical !== undefined &&
    uuidEquals(conversation.coach_id, canonical.coach_id) &&
    uuidEquals(conversation.student_id, canonical.student_id)
  );
}

function messagePayloadMatches(
  message: MessageRow,
  body:
    | { kind: 'text'; body: string; client_id: string }
    | { kind: 'image'; attachment_id: string; client_id: string },
): boolean {
  if (message.kind !== body.kind) return false;
  if (body.kind === 'text') return message.body === body.body && message.attachment_id === null;
  return message.body === null && uuidEquals(message.attachment_id, body.attachment_id);
}

function postgresErrorField(error: unknown, field: 'code' | 'constraint'): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as Record<string, unknown>)[field];
}

function pgMemConflictColumns(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  const details = (data as { details?: unknown }).details;
  if (typeof details !== 'string') return undefined;
  return /^Key \(([^)]+)\)=/.exec(details)?.[1];
}

function isUniqueConstraintViolation(
  error: unknown,
  constraint: string,
  pgMemColumns: string,
): boolean {
  if (postgresErrorField(error, 'code') !== '23505') return false;

  const reportedConstraint = postgresErrorField(error, 'constraint');
  if (reportedConstraint !== undefined) return reportedConstraint === constraint;

  // pg-mem 3.x omits `constraint` and incorrectly labels every UNIQUE as the
  // table primary key. Its structured DETAIL still identifies the exact key,
  // so keep this narrow compatibility path instead of treating every 23505 as
  // a sequence or idempotency collision.
  return pgMemConflictColumns(error) === pgMemColumns;
}

function isMessageSequenceConflict(error: unknown): boolean {
  return isUniqueConstraintViolation(error, MESSAGE_SEQUENCE_CONSTRAINT, 'conversation_id,seq');
}

function isMessageIdempotencyConflict(error: unknown): boolean {
  return isUniqueConstraintViolation(
    error,
    MESSAGE_IDEMPOTENCY_CONSTRAINT,
    'conversation_id,sender_id,client_id',
  );
}

export function conversationsRouter(deps: ConversationsRouterDeps): ExpressRouter {
  const router = Router();
  const { db, logger, oss } = deps;

  router.use(requireRole('coach', 'coached_student'));

  router.post(
    '/',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      const body = CreateConversationBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const requestedPair =
        req.user.role === 'coach'
          ? { coach_id: req.user.id, student_id: body.data.other_user_id }
          : { coach_id: body.data.other_user_id, student_id: req.user.id };

      const result = await db.transaction().execute(async (trx) => {
        const canonical = await resolveCanonicalAcceptedBond(trx, requestedPair.student_id);
        if (!canonicalPairMatches(requestedPair, canonical)) return null;

        // Generate the id up front so "was it created?" never depends on how the
        // driver reports ON CONFLICT DO NOTHING ... RETURNING. Postgres returns no
        // row on conflict; pg-mem returns the pre-existing row. Comparing against
        // the id we minted is correct under both.
        const newConversationId = randomUUID();
        const inserted = await trx
          .insertInto('conversations')
          .values({ id: newConversationId, ...requestedPair })
          .onConflict((conflict) => conflict.columns(['coach_id', 'student_id']).doNothing())
          .returningAll()
          .executeTakeFirst();
        const created = inserted !== undefined && uuidEquals(inserted.id, newConversationId);
        const conversation =
          inserted ??
          (await trx
            .selectFrom('conversations')
            .selectAll()
            .where('coach_id', '=', requestedPair.coach_id)
            .where('student_id', '=', requestedPair.student_id)
            .executeTakeFirstOrThrow());

        return { conversation, created };
      });

      if (!result) {
        res.status(403).json({ error: 'CHAT_BIND_REQUIRED' });
        return;
      }

      const conversation = await fetchConversationWire(db, result.conversation, req.user.id);
      res.status(result.created ? 201 : 200).json({ conversation });
    }),
  );

  router.get(
    '/',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      const user = req.user;

      let query = db.selectFrom('conversations').selectAll();
      if (user.role === 'coach') {
        query = query.where('coach_id', '=', user.id);
      } else {
        const canonical = await resolveCanonicalAcceptedBond(db, user.id);
        if (!canonical) {
          res.status(200).json({ conversations: [] });
          return;
        }
        query = query
          .where('coach_id', '=', canonical.coach_id)
          .where('student_id', '=', canonical.student_id);
      }

      const rows = await query
        .orderBy(sql`last_message_at DESC NULLS LAST`)
        .orderBy('id', 'desc')
        .execute();
      const conversations = await Promise.all(
        rows.map((conversation) => fetchConversationWire(db, conversation, user.id)),
      );

      res.status(200).json({ conversations });
    }),
  );

  router.get(
    '/:id/messages',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      const user = req.user;
      const params = ConversationIdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      const conversation = await findConversationForMember(db, params.data.id, user.id);
      if (!conversation) {
        res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' });
        return;
      }
      const query = ListMessagesQuerySchema.safeParse(req.query);
      if (!query.success) {
        res.status(400).json(validationEnvelope(query.error));
        return;
      }

      let messagesQuery = db
        .selectFrom('messages as m')
        .leftJoin('attachments as a', 'a.id', 'm.attachment_id')
        .selectAll('m')
        .select('a.oss_key as attachment_oss_key')
        .where('m.conversation_id', '=', conversation.id);

      if (query.data.since_seq !== undefined) {
        messagesQuery = messagesQuery
          .where('m.seq', '>', query.data.since_seq)
          .orderBy('m.seq', 'asc');
      } else if (query.data.before_seq !== undefined) {
        messagesQuery = messagesQuery
          .where('m.seq', '<', query.data.before_seq)
          .orderBy('m.seq', 'desc');
      } else {
        messagesQuery = messagesQuery.orderBy('m.seq', 'desc');
      }

      const batch = await messagesQuery.limit(query.data.limit + 1).execute();
      const hasMore = batch.length > query.data.limit;
      const selected = batch.slice(0, query.data.limit);
      const messages = await Promise.all(selected.map((message) => serializeMessage(message, oss)));
      const otherLastRead = await fetchReadCursor(
        db,
        conversation.id,
        otherParticipantId(conversation, user.id),
      );

      res.status(200).json({
        messages,
        meta: { other_last_read: otherLastRead, has_more: hasMore },
      });
    }),
  );

  router.post(
    '/:id/messages',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      const user = req.user;
      const params = ConversationIdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      const conversation = await findConversationForMember(db, params.data.id, user.id);
      if (!conversation) {
        res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' });
        return;
      }
      const body = SendMessageBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const executeSendAttempt = async (): Promise<SendMessageResult> =>
        db.transaction().execute(async (trx) => {
          const canonical = await resolveCanonicalAcceptedBond(trx, conversation.student_id);
          if (!canonicalPairMatches(conversation, canonical)) {
            return { outcome: 'bind_required' };
          }

          // D1/D2b ordering is intentional: idempotency first, attachment lock
          // second, then the conversation allocation lock before any write.
          const existing = await trx
            .selectFrom('messages')
            .selectAll()
            .where('conversation_id', '=', conversation.id)
            .where('sender_id', '=', user.id)
            .where('client_id', '=', body.data.client_id)
            .executeTakeFirst();
          if (existing) {
            if (!messagePayloadMatches(existing, body.data)) {
              logger.warn(
                {
                  conversationId: conversation.id,
                  senderId: user.id,
                  existingMessageId: existing.id,
                },
                'chat_message_idempotency_payload_mismatch',
              );
            }
            return { outcome: 'message', message: existing, created: false };
          }

          if (body.data.kind === 'image') {
            const attachment = await trx
              .selectFrom('attachments')
              .select(['id', 'owner_id', 'kind', 'status'])
              .where('id', '=', body.data.attachment_id)
              .forUpdate()
              .executeTakeFirst();
            if (
              !attachment ||
              !uuidEquals(attachment.owner_id, user.id) ||
              attachment.kind !== 'chat_image' ||
              attachment.status !== 'ready'
            ) {
              return { outcome: 'invalid_attachment' };
            }
          }

          const lockedConversation = await trx
            .selectFrom('conversations')
            .select('id')
            .where('id', '=', conversation.id)
            .forUpdate()
            .executeTakeFirst();
          if (!lockedConversation) return { outcome: 'not_found' };

          const maxSeq = await trx
            .selectFrom('messages')
            .select((eb) => eb.fn.max<number | null>('seq').as('max_seq'))
            .where('conversation_id', '=', conversation.id)
            .executeTakeFirstOrThrow();
          const nextSeq = (maxSeq.max_seq ?? 0) + 1;

          const newMessageId = randomUUID();
          const insertedRow =
            body.data.kind === 'image'
              ? (
                  await sql<MessageRow>`
                    INSERT INTO messages (
                      id, conversation_id, seq, sender_id, kind, body,
                      attachment_id, client_id, created_at
                    )
                    SELECT
                      ${newMessageId}::uuid, ${conversation.id}::uuid, ${nextSeq}::integer,
                      ${user.id}::uuid,
                      'image', NULL::text, eligible.id, ${body.data.client_id}::text,
                      clock_timestamp()
                    FROM attachments AS eligible
                    WHERE eligible.id = ${body.data.attachment_id}::uuid
                      AND eligible.owner_id = ${user.id}::uuid
                      AND eligible.kind = 'chat_image'
                      AND eligible.status = 'ready'
                    ON CONFLICT (conversation_id, sender_id, client_id) DO NOTHING
                    RETURNING *
                  `.execute(trx)
                ).rows[0]
              : await trx
                  .insertInto('messages')
                  .values({
                    id: newMessageId,
                    conversation_id: conversation.id,
                    seq: nextSeq,
                    sender_id: user.id,
                    kind: 'text',
                    body: body.data.body,
                    attachment_id: null,
                    client_id: body.data.client_id,
                    created_at: sql<Date>`clock_timestamp()`,
                  })
                  .onConflict((conflict) =>
                    conflict.columns(['conversation_id', 'sender_id', 'client_id']).doNothing(),
                  )
                  .returningAll()
                  .executeTakeFirst();

          // Same ON CONFLICT ... RETURNING caveat as conversation creation above:
          // only the id we minted proves this row is genuinely new.
          const inserted =
            insertedRow !== undefined && uuidEquals(insertedRow.id, newMessageId)
              ? insertedRow
              : undefined;

          if (!inserted) {
            const raced =
              insertedRow ??
              (await trx
                .selectFrom('messages')
                .selectAll()
                .where('conversation_id', '=', conversation.id)
                .where('sender_id', '=', user.id)
                .where('client_id', '=', body.data.client_id)
                .executeTakeFirst());
            if (!raced) return { outcome: 'invalid_attachment' };
            if (!messagePayloadMatches(raced, body.data)) {
              logger.warn(
                {
                  conversationId: conversation.id,
                  senderId: user.id,
                  existingMessageId: raced.id,
                },
                'chat_message_idempotency_payload_mismatch',
              );
            }
            return { outcome: 'message', message: raced, created: false };
          }

          await trx
            .updateTable('conversations')
            .set({
              last_message_at: sql<Date>`GREATEST(last_message_at, ${inserted.created_at})`,
            })
            .where('id', '=', conversation.id)
            .execute();

          return { outcome: 'message', message: inserted, created: true };
        });

      let result: SendMessageResult | undefined;
      for (let attempt = 1; attempt <= MAX_SEQUENCE_ALLOCATION_ATTEMPTS; attempt += 1) {
        try {
          result = await executeSendAttempt();
          break;
        } catch (error) {
          if (isMessageIdempotencyConflict(error)) {
            const raced = await db
              .selectFrom('messages')
              .selectAll()
              .where('conversation_id', '=', conversation.id)
              .where('sender_id', '=', user.id)
              .where('client_id', '=', body.data.client_id)
              .executeTakeFirst();
            if (!raced) throw error;
            if (!messagePayloadMatches(raced, body.data)) {
              logger.warn(
                {
                  conversationId: conversation.id,
                  senderId: user.id,
                  existingMessageId: raced.id,
                },
                'chat_message_idempotency_payload_mismatch',
              );
            }
            result = { outcome: 'message', message: raced, created: false };
            break;
          }
          if (!isMessageSequenceConflict(error)) throw error;
          if (attempt === MAX_SEQUENCE_ALLOCATION_ATTEMPTS) {
            logger.warn(
              { conversationId: conversation.id, senderId: user.id, attempts: attempt },
              'chat_message_sequence_retry_exhausted',
            );
            result = { outcome: 'sequence_conflict' };
          }
        }
      }

      if (!result || result.outcome === 'sequence_conflict') {
        res.status(409).json({ error: 'CHAT_SEQUENCE_CONFLICT' });
        return;
      }

      if (result.outcome === 'bind_required') {
        res.status(403).json({ error: 'CHAT_BIND_REQUIRED' });
        return;
      }
      if (result.outcome === 'invalid_attachment') {
        res.status(400).json({ error: 'CHAT_INVALID_ATTACHMENT' });
        return;
      }
      if (result.outcome === 'not_found') {
        res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' });
        return;
      }

      const message = await fetchMessageWire(db, result.message.id, oss);
      res.status(result.created ? 201 : 200).json({ message });
    }),
  );

  router.post(
    '/:id/read',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      const user = req.user;
      const params = ConversationIdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      const conversation = await findConversationForMember(db, params.data.id, user.id);
      if (!conversation) {
        res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' });
        return;
      }
      const body = ReadConversationBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const cursor = await db.transaction().execute(async (trx) => {
        const requested = await trx
          .selectFrom('messages')
          .select(['id', 'seq'])
          .where('id', '=', body.data.message_id)
          .where('conversation_id', '=', conversation.id)
          .executeTakeFirst();
        if (!requested) return null;

        const read = await trx
          .insertInto('conversation_reads')
          .values({
            conversation_id: conversation.id,
            user_id: user.id,
            last_read_seq: requested.seq,
          })
          .onConflict((conflict) =>
            conflict.columns(['conversation_id', 'user_id']).doUpdateSet({
              last_read_seq: sql<number>`GREATEST(conversation_reads.last_read_seq, EXCLUDED.last_read_seq)`,
            }),
          )
          .returning('last_read_seq')
          .executeTakeFirstOrThrow();

        const actual = await trx
          .selectFrom('messages')
          .select(['id as message_id', 'seq'])
          .where('conversation_id', '=', conversation.id)
          .where('seq', '=', read.last_read_seq)
          .executeTakeFirstOrThrow();
        return actual;
      });

      if (!cursor) {
        res.status(400).json({ error: 'CHAT_INVALID_CURSOR' });
        return;
      }

      const unreadCount = await fetchUnreadCount(db, conversation.id, user.id, cursor.seq);
      res.status(200).json({ my_last_read: cursor, unread_count: unreadCount });
    }),
  );

  return router;
}
