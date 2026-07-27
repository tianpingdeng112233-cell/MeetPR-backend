import { z } from 'zod';

const UuidSchema = z.string().uuid();
const PositiveIntegerQuerySchema = z.coerce.number().int().positive();

export const ConversationIdParamSchema = z.object({
  id: UuidSchema,
});

export const CreateConversationBodySchema = z
  .object({
    other_user_id: UuidSchema,
  })
  .strict();

const TextMessageBodySchema = z
  .object({
    kind: z.literal('text'),
    body: z.string().min(1).max(4000),
    client_id: z.string().min(1).max(64),
    // Parsed strictly only after the idempotency lookup. Existing client_id
    // hits intentionally return the stored message without revalidating a
    // retried payload (chat spec 024 idempotency contract).
    set_ref: z.unknown().optional(),
    video_id: z.unknown().optional(),
  })
  .strict();

const ImageMessageBodySchema = z
  .object({
    kind: z.literal('image'),
    attachment_id: UuidSchema,
    client_id: z.string().min(1).max(64),
  })
  .strict();

export const SendMessageBodySchema = z.discriminatedUnion('kind', [
  TextMessageBodySchema,
  ImageMessageBodySchema,
]);

export const ListMessagesQuerySchema = z
  .object({
    before_seq: PositiveIntegerQuerySchema.optional(),
    since_seq: PositiveIntegerQuerySchema.optional(),
    limit: PositiveIntegerQuerySchema.max(100).default(30),
  })
  .strict()
  .refine((query) => query.before_seq === undefined || query.since_seq === undefined, {
    path: ['since_seq'],
    message: 'since_seq and before_seq are mutually exclusive',
  });

export const ReadConversationBodySchema = z
  .object({
    message_id: UuidSchema,
  })
  .strict();
