import { randomUUID } from 'node:crypto';

import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';

import { resolveCanonicalAcceptedBond, resolveCanonicalAcceptedBonds } from '../../db/bonds';
import type { ConversationsTable, Database, MessagesTable } from '../../db/types';
import { bodyMatchesSetRef, SetRefV1Schema, type SetRefV1 } from '../../domain/set-ref';
import { requesterOssSignOptions } from '../../handlers/oss-sign-options';
import { timestamp } from '../../handlers/serialization';
import type { Logger } from '../../logger';
import { requireRole } from '../../middleware/auth';
import { chatMessageEvent, chatReadEvent } from '../../realtime/events';
import type { RealtimeHub } from '../../realtime/hub';
import type { OssService, OssSignOptions } from '../../services/oss';
import { pushDisplayName, tryEnqueuePushOutbox } from '../../services/push-outbox';
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
const UuidSchema = z.string().uuid();

type DbExecutor = Kysely<Database> | Transaction<Database>;
type ConversationRow = Selectable<ConversationsTable>;
type MessageRow = Selectable<MessagesTable>;
type ValidationErrorEnvelope = ReturnType<typeof validationEnvelope>;
type SendMessageResult =
  | { outcome: 'authorization_forbidden' }
  | { outcome: 'bind_required' }
  | { outcome: 'invalid_attachment' }
  | { outcome: 'not_found' }
  | { outcome: 'sequence_conflict' }
  | { outcome: 'validation_error'; error: ValidationErrorEnvelope }
  | { outcome: 'message'; message: MessageRow; created: boolean };

interface ConversationsRouterDeps {
  db: Kysely<Database>;
  logger: Logger;
  pushEnabled?: boolean;
  hub?: RealtimeHub | undefined;
  oss?: OssService | undefined;
}

interface ReadCursorWire {
  message_id: string;
  seq: number;
}

interface ReadCursorProjection {
  rawSeq: number | null;
  cursor: ReadCursorWire | null;
}

interface VisibilityContext {
  conversationId: string;
  showSetRefs: boolean;
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
  set_ref: SetRefV1 | null;
  video_url: string | null;
  video_expires_in: number | null;
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

export function pushMessagePreview(message: {
  kind: 'text' | 'image';
  body: string | null;
  set_ref: unknown;
}): string {
  if (message.kind === 'image') return '[图片]';
  if (message.set_ref !== null) return '[训练组]';
  const characters = Array.from(message.body ?? '');
  return characters.length <= 60 ? characters.join('') : `${characters.slice(0, 59).join('')}…`;
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

async function resolveVisibilityContext(
  db: DbExecutor,
  conversation: ConversationRow,
  viewerId: string,
): Promise<VisibilityContext> {
  if (uuidEquals(conversation.student_id, viewerId)) {
    return { conversationId: conversation.id, showSetRefs: true };
  }

  const canonical = await resolveCanonicalAcceptedBond(db, conversation.student_id);
  return {
    conversationId: conversation.id,
    showSetRefs:
      uuidEquals(conversation.coach_id, viewerId) && canonicalPairMatches(conversation, canonical),
  };
}

async function resolveVisibilityContexts(
  db: DbExecutor,
  conversations: ConversationRow[],
  viewerId: string,
): Promise<Map<string, VisibilityContext>> {
  const contexts = new Map<string, VisibilityContext>();
  const coachConversations = conversations.filter(
    (conversation) => !uuidEquals(conversation.student_id, viewerId),
  );

  for (const conversation of conversations) {
    if (uuidEquals(conversation.student_id, viewerId)) {
      contexts.set(conversation.id, {
        conversationId: conversation.id,
        showSetRefs: true,
      });
    }
  }

  const canonicalBonds = await resolveCanonicalAcceptedBonds(db, [
    ...new Set(coachConversations.map((conversation) => conversation.student_id)),
  ]);
  const canonicalByStudent = new Map(
    canonicalBonds.map((canonical) => [canonical.student_id, canonical]),
  );
  for (const conversation of coachConversations) {
    contexts.set(conversation.id, {
      conversationId: conversation.id,
      showSetRefs:
        uuidEquals(conversation.coach_id, viewerId) &&
        canonicalPairMatches(conversation, canonicalByStudent.get(conversation.student_id)),
    });
  }

  return contexts;
}

function visibleMessagePredicate(
  context: VisibilityContext,
  tableAlias: 'm' | 'messages' = 'messages',
) {
  return context.showSetRefs
    ? sql<boolean>`TRUE`
    : sql<boolean>`${sql.ref(`${tableAlias}.set_ref`)} IS NULL`;
}

async function fetchReadCursor(
  db: DbExecutor,
  conversationId: string,
  userId: string,
  visibility: VisibilityContext,
): Promise<ReadCursorProjection> {
  const read = await db
    .selectFrom('conversation_reads')
    .select('last_read_seq')
    .where('conversation_id', '=', conversationId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!read) return { rawSeq: null, cursor: null };

  const cursor = await db
    .selectFrom('messages')
    .select(['id as message_id', 'seq'])
    .where('conversation_id', '=', conversationId)
    .where('seq', '<=', read.last_read_seq)
    .where(visibleMessagePredicate(visibility))
    .orderBy('seq', 'desc')
    .limit(1)
    .executeTakeFirst();

  return { rawSeq: read.last_read_seq, cursor: cursor ?? null };
}

async function fetchUnreadCount(
  db: DbExecutor,
  conversationId: string,
  userId: string,
  lastReadSeq: number | null,
  visibility: VisibilityContext,
): Promise<number> {
  const unread = await db
    .selectFrom('messages')
    .select((eb) => eb.fn.countAll<string | number>().as('count'))
    .where('conversation_id', '=', conversationId)
    .where('sender_id', '!=', userId)
    .where('seq', '>', lastReadSeq ?? 0)
    .where(visibleMessagePredicate(visibility))
    .executeTakeFirstOrThrow();

  return Number(unread.count);
}

async function serializeMessage(
  row: MessageRow & {
    attachment_oss_key: string | null;
    video_oss_key: string | null;
  },
  oss: OssService | undefined,
  signOptions: OssSignOptions,
  signedVideoUrls = new Map<string, Promise<string>>(),
): Promise<MessageWire> {
  const isImage = row.kind === 'image';
  const imageUrl =
    isImage && oss && row.attachment_oss_key !== null
      ? await oss.signGetUrl(row.attachment_oss_key, IMAGE_URL_TTL_SECONDS, signOptions)
      : null;
  let videoUrl: string | null = null;
  if (row.video_id !== null && oss && row.video_oss_key !== null) {
    let signedUrl = signedVideoUrls.get(row.video_oss_key);
    if (!signedUrl) {
      signedUrl = oss.signGetUrl(row.video_oss_key, IMAGE_URL_TTL_SECONDS, signOptions);
      signedVideoUrls.set(row.video_oss_key, signedUrl);
    }
    videoUrl = await signedUrl;
  }

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
    set_ref: row.set_ref,
    video_url: videoUrl,
    video_expires_in: videoUrl === null ? null : IMAGE_URL_TTL_SECONDS,
    client_id: row.client_id,
    created_at: timestamp(row.created_at),
  };
}

async function fetchAttachmentOssKeys(
  db: DbExecutor,
  attachmentIds: (string | null)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(attachmentIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();

  const attachments = await db
    .selectFrom('attachments')
    .select(['id', 'oss_key'])
    .where('id', 'in', ids)
    .execute();
  return new Map(attachments.map((attachment) => [attachment.id, attachment.oss_key]));
}

async function fetchMessageWire(
  db: Kysely<Database>,
  messageId: string,
  oss: OssService | undefined,
  signOptions: OssSignOptions,
): Promise<MessageWire> {
  const row = await db
    .selectFrom('messages')
    .selectAll()
    .where('id', '=', messageId)
    .executeTakeFirstOrThrow();
  const attachmentOssKeys =
    oss === undefined
      ? new Map<string, string>()
      : await fetchAttachmentOssKeys(db, [row.attachment_id, row.video_id]);

  return serializeMessage(
    {
      ...row,
      attachment_oss_key:
        row.attachment_id === null ? null : (attachmentOssKeys.get(row.attachment_id) ?? null),
      video_oss_key: row.video_id === null ? null : (attachmentOssKeys.get(row.video_id) ?? null),
    },
    oss,
    signOptions,
  );
}

async function fetchConversationWire(
  db: Kysely<Database>,
  conversation: ConversationRow,
  viewerId: string,
  visibility: VisibilityContext,
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
      .select(['id', 'seq', 'kind', 'body', 'set_ref', 'created_at', 'sender_id'])
      .where('conversation_id', '=', conversation.id)
      .where(visibleMessagePredicate(visibility))
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst(),
    fetchReadCursor(db, conversation.id, viewerId, visibility),
    fetchReadCursor(db, conversation.id, otherId, visibility),
  ]);

  const unreadCount = await fetchUnreadCount(
    db,
    conversation.id,
    viewerId,
    myLastRead.rawSeq,
    visibility,
  );

  return {
    id: conversation.id,
    other_party: { id: otherId, display_name: profile?.display_name ?? '' },
    last_message: lastMessage
      ? {
          id: lastMessage.id,
          seq: lastMessage.seq,
          kind: lastMessage.kind,
          preview:
            lastMessage.set_ref !== null
              ? lastMessage.set_ref.source === 'planned'
                ? '[训练计划]'
                : '[训练分享]'
              : lastMessage.kind === 'image'
                ? '[图片]'
                : (lastMessage.body ?? ''),
          created_at: timestamp(lastMessage.created_at),
          sender_id: lastMessage.sender_id,
        }
      : null,
    last_message_at: visibility.showSetRefs
      ? conversation.last_message_at === null
        ? null
        : timestamp(conversation.last_message_at)
      : lastMessage === undefined
        ? null
        : timestamp(lastMessage.created_at),
    unread_count: unreadCount,
    my_last_read: myLastRead.cursor,
    other_last_read: otherLastRead.cursor,
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

function messageValidationError(
  path: (string | number)[],
  message: string,
): ValidationErrorEnvelope {
  return { error: 'VALIDATION_ERROR', issues: [{ path, message }] };
}

function messagePayloadMatches(
  message: MessageRow,
  body:
    | {
        kind: 'text';
        body: string;
        client_id: string;
        set_ref?: unknown;
        video_id?: unknown;
      }
    | { kind: 'image'; attachment_id: string; client_id: string },
): boolean {
  if (message.kind !== body.kind) return false;
  if (body.kind === 'text') {
    const setRef = body.set_ref === undefined ? null : body.set_ref;
    const videoId = typeof body.video_id === 'string' ? body.video_id : null;
    return (
      message.body === body.body &&
      message.attachment_id === null &&
      JSON.stringify(message.set_ref) === JSON.stringify(setRef) &&
      (message.video_id === null ? videoId === null : uuidEquals(message.video_id, videoId))
    );
  }
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
  const { db, hub, logger, oss } = deps;

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

      const visibility = await resolveVisibilityContext(db, result.conversation, req.user.id);
      const conversation = await fetchConversationWire(
        db,
        result.conversation,
        req.user.id,
        visibility,
      );
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

      const rows = await query.execute();
      const visibilityByConversation = await resolveVisibilityContexts(db, rows, user.id);
      const conversations = await Promise.all(
        rows.map((conversation) =>
          fetchConversationWire(
            db,
            conversation,
            user.id,
            visibilityByConversation.get(conversation.id) ??
              ({
                conversationId: conversation.id,
                showSetRefs: false,
              } satisfies VisibilityContext),
          ),
        ),
      );
      conversations.sort((left, right) => {
        if (left.last_message_at === null && right.last_message_at !== null) return 1;
        if (left.last_message_at !== null && right.last_message_at === null) return -1;
        if (left.last_message_at !== right.last_message_at) {
          return (right.last_message_at ?? '').localeCompare(left.last_message_at ?? '');
        }
        if (left.id === right.id) return 0;
        return left.id < right.id ? 1 : -1;
      });

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
      const visibility = await resolveVisibilityContext(db, conversation, user.id);

      let messagesQuery = db
        .selectFrom('messages as m')
        .selectAll('m')
        .where('m.conversation_id', '=', conversation.id)
        .where(visibleMessagePredicate(visibility, 'm'));

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
      const attachmentOssKeys =
        oss === undefined
          ? new Map<string, string>()
          : await fetchAttachmentOssKeys(
              db,
              selected.flatMap((message) => [message.attachment_id, message.video_id]),
            );
      const signOptions = await requesterOssSignOptions(db, oss, user.id, logger);
      if (signOptions === null) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      const signedVideoUrls = new Map<string, Promise<string>>();
      const messages = await Promise.all(
        selected.map((message) =>
          serializeMessage(
            {
              ...message,
              attachment_oss_key:
                message.attachment_id === null
                  ? null
                  : (attachmentOssKeys.get(message.attachment_id) ?? null),
              video_oss_key:
                message.video_id === null
                  ? null
                  : (attachmentOssKeys.get(message.video_id) ?? null),
            },
            oss,
            signOptions,
            signedVideoUrls,
          ),
        ),
      );
      const otherLastRead = await fetchReadCursor(
        db,
        conversation.id,
        otherParticipantId(conversation, user.id),
        visibility,
      );

      res.status(200).json({
        messages,
        meta: { other_last_read: otherLastRead.cursor, has_more: hasMore },
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
      const signOptions = await requesterOssSignOptions(db, oss, user.id, logger);
      if (signOptions === null) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
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

          let setRef: SetRefV1 | null = null;
          let videoId: string | null = null;
          if (body.data.kind === 'text') {
            if (body.data.set_ref === undefined) {
              if (body.data.video_id !== undefined) {
                return {
                  outcome: 'validation_error',
                  error: messageValidationError(['video_id'], 'video_id requires a valid set_ref'),
                };
              }
            } else {
              if (!uuidEquals(user.id, conversation.student_id)) {
                return { outcome: 'authorization_forbidden' };
              }

              const parsedSetRef = SetRefV1Schema.safeParse(body.data.set_ref);
              if (!parsedSetRef.success) {
                return {
                  outcome: 'validation_error',
                  error: validationEnvelope(parsedSetRef.error),
                };
              }
              setRef = parsedSetRef.data;

              if (!bodyMatchesSetRef(body.data.body, setRef)) {
                return {
                  outcome: 'validation_error',
                  error: messageValidationError(
                    ['body'],
                    'body must equal or begin with the canonical set_ref first line',
                  ),
                };
              }

              if (setRef.source === 'logged') {
                const sourceSet = await trx
                  .selectFrom('set_logs')
                  .select('id')
                  .where('id', '=', setRef.set_log_id)
                  .where('student_id', '=', user.id)
                  .executeTakeFirst();
                if (!sourceSet) {
                  return {
                    outcome: 'validation_error',
                    error: messageValidationError(
                      ['set_ref', 'set_log_id'],
                      'set_log_id must identify a set owned by the sender',
                    ),
                  };
                }

                if (body.data.video_id !== undefined) {
                  const parsedVideoId = UuidSchema.safeParse(body.data.video_id);
                  if (!parsedVideoId.success) {
                    return {
                      outcome: 'validation_error',
                      error: validationEnvelope(parsedVideoId.error),
                    };
                  }
                  videoId = parsedVideoId.data;
                }
              } else {
                const sourceSet = await trx
                  .selectFrom('plan_sets')
                  .innerJoin('plan_exercises', 'plan_exercises.id', 'plan_sets.plan_exercise_id')
                  .innerJoin('plan_days', 'plan_days.id', 'plan_exercises.plan_day_id')
                  .innerJoin('plans', 'plans.id', 'plan_days.plan_id')
                  .select('plan_sets.id')
                  .where('plan_sets.id', '=', setRef.plan_set_id)
                  .where('plans.trainee_id', '=', user.id)
                  .executeTakeFirst();
                if (!sourceSet) {
                  return {
                    outcome: 'validation_error',
                    error: messageValidationError(
                      ['set_ref', 'plan_set_id'],
                      'plan_set_id must identify a planned set on a plan owned by the sender',
                    ),
                  };
                }

                if (body.data.video_id !== undefined) {
                  return {
                    outcome: 'validation_error',
                    error: messageValidationError(
                      ['video_id'],
                      'video_id is not allowed for source=planned',
                    ),
                  };
                }
              }
            }
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

          if (videoId !== null && setRef !== null) {
            const video = await trx
              .selectFrom('attachments')
              .select(['id', 'owner_id', 'kind', 'status', 'set_log_id'])
              .where('id', '=', videoId)
              .forUpdate()
              .executeTakeFirst();
            if (
              !video ||
              !uuidEquals(video.owner_id, user.id) ||
              video.kind !== 'set_video' ||
              video.status !== 'ready' ||
              !uuidEquals(video.set_log_id, setRef.set_log_id)
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
                    set_ref: setRef,
                    video_id: videoId,
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
      if (result.outcome === 'authorization_forbidden') {
        res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
        return;
      }
      if (result.outcome === 'validation_error') {
        res.status(400).json(result.error);
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

      if (result.created) {
        const event = chatMessageEvent({
          conversation_id: conversation.id,
          seq: result.message.seq,
          sender_id: result.message.sender_id,
        });
        hub?.publish(conversation.coach_id, event);
        hub?.publish(conversation.student_id, event);
        if (deps.pushEnabled) {
          await tryEnqueuePushOutbox(db, logger, 'chat_message', async () => ({
            aggregateId: result.message.id,
            recipientId: otherParticipantId(conversation, user.id),
            payload: {
              sender_name: await pushDisplayName(db, user.id),
              preview: pushMessagePreview(result.message),
              conversation_id: conversation.id,
              seq: result.message.seq,
            },
          }));
        }
      }

      const message = await fetchMessageWire(db, result.message.id, oss, signOptions);
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
      const visibility = await resolveVisibilityContext(db, conversation, user.id);

      const cursor = await db.transaction().execute(async (trx) => {
        const requested = await trx
          .selectFrom('messages')
          .select(['id', 'seq'])
          .where('id', '=', body.data.message_id)
          .where('conversation_id', '=', conversation.id)
          .where(visibleMessagePredicate(visibility))
          .executeTakeFirst();
        if (!requested) return null;

        await trx
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

        return fetchReadCursor(trx, conversation.id, user.id, visibility);
      });

      if (!cursor?.cursor || cursor.rawSeq === null) {
        res.status(400).json({ error: 'CHAT_INVALID_CURSOR' });
        return;
      }

      const unreadCount = await fetchUnreadCount(
        db,
        conversation.id,
        user.id,
        cursor.rawSeq,
        visibility,
      );
      hub?.publish(
        otherParticipantId(conversation, user.id),
        chatReadEvent({
          conversation_id: conversation.id,
          user_id: user.id,
          last_read_seq: cursor.rawSeq,
        }),
      );
      res.status(200).json({ my_last_read: cursor.cursor, unread_count: unreadCount });
    }),
  );

  return router;
}
