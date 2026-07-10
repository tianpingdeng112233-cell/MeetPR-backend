import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';

import type { AttachmentKind, AttachmentStatus, AttachmentsTable, Database } from '../db/types';
import { timestamp } from './serialization';

export type AttachmentRow = Selectable<AttachmentsTable>;

export interface AttachmentWire {
  id: string;
  owner_id: string;
  kind: AttachmentKind;
  oss_key: string;
  content_type: string;
  size_bytes: number;
  filename: string | null;
  set_log_id: string | null;
  source_plan_id: string | null;
  source_coach_id: string | null;
  is_unlinked_explicit: boolean;
  part_count: number;
  actual_size_bytes: number | null;
  status: AttachmentStatus;
  created_at: string;
  updated_at: string;
}

export function serializeAttachment(row: AttachmentRow): AttachmentWire {
  return {
    id: row.id,
    owner_id: row.owner_id,
    kind: row.kind,
    oss_key: row.oss_key,
    content_type: row.content_type,
    // BIGINT arrives as string from node-pg; caps (<= 200 MB) keep Number() exact.
    size_bytes: Number(row.size_bytes),
    filename: row.filename,
    set_log_id: row.set_log_id,
    source_plan_id: row.source_plan_id,
    source_coach_id: row.source_coach_id,
    is_unlinked_explicit: row.is_unlinked_explicit,
    part_count: row.part_count,
    actual_size_bytes: row.actual_size_bytes === null ? null : Number(row.actual_size_bytes),
    status: row.status,
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  };
}

export interface NewAttachment {
  owner_id: string;
  kind: AttachmentKind;
  oss_key: string;
  oss_upload_id: string;
  content_type: string;
  size_bytes: number;
  filename: string | null;
  set_log_id: string | null;
  source_plan_id: string | null;
  source_coach_id: string | null;
  is_unlinked_explicit: boolean;
  part_count: number;
}

export async function insertAttachment(
  db: Kysely<Database>,
  input: NewAttachment,
): Promise<AttachmentRow> {
  return db
    .insertInto('attachments')
    .values({
      owner_id: input.owner_id,
      kind: input.kind,
      oss_key: input.oss_key,
      oss_upload_id: input.oss_upload_id,
      content_type: input.content_type,
      size_bytes: input.size_bytes,
      filename: input.filename,
      set_log_id: input.set_log_id,
      source_plan_id: input.source_plan_id,
      source_coach_id: input.source_coach_id,
      is_unlinked_explicit: input.is_unlinked_explicit,
      part_count: input.part_count,
      status: 'uploading',
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function markAttachmentReady(
  db: Kysely<Database>,
  attachmentId: string,
  actualSizeBytes: number,
): Promise<AttachmentRow | undefined> {
  return db
    .updateTable('attachments')
    .set({ status: 'ready', actual_size_bytes: actualSizeBytes, updated_at: sql<Date>`now()` })
    .where('id', '=', attachmentId)
    .where('status', '=', 'completing')
    .returningAll()
    .executeTakeFirst();
}

/**
 * Remove local attachment metadata only after OSS deletion has succeeded. The
 * onboarding link deliberately has no FK in the legacy schema, so clear it in
 * the same transaction to avoid a stale document/video reference.
 */
export async function deleteAttachmentMetadata(
  db: Kysely<Database>,
  attachmentId: string,
  ownerId: string,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom('onboarding_uploads')
      .where('user_id', '=', ownerId)
      .where('attachment_id', '=', attachmentId)
      .execute();
    const deleted = await trx
      .deleteFrom('attachments')
      .where('id', '=', attachmentId)
      .where('owner_id', '=', ownerId)
      .where('status', '=', 'deleting')
      .returning(['id'])
      .executeTakeFirst();
    return deleted !== undefined;
  });
}

export async function findOwnedAttachment(
  db: Kysely<Database>,
  attachmentId: string,
  ownerId: string,
): Promise<AttachmentRow | undefined> {
  return db
    .selectFrom('attachments')
    .selectAll()
    .where('id', '=', attachmentId)
    .where('owner_id', '=', ownerId)
    .executeTakeFirst();
}

export async function findAttachment(
  db: Kysely<Database>,
  attachmentId: string,
): Promise<AttachmentRow | undefined> {
  return db.selectFrom('attachments').selectAll().where('id', '=', attachmentId).executeTakeFirst();
}

/**
 * Atomic status transition: only updates while the row is still in `from`,
 * so a concurrent double complete/abort loses and gets undefined back.
 */
export async function transitionAttachmentStatus(
  db: Kysely<Database>,
  attachmentId: string,
  from: AttachmentStatus,
  to: AttachmentStatus,
): Promise<AttachmentRow | undefined> {
  return db
    .updateTable('attachments')
    .set({ status: to, updated_at: sql<Date>`now()` })
    .where('id', '=', attachmentId)
    .where('status', '=', from)
    .returningAll()
    .executeTakeFirst();
}

/** True when the coach has an accepted bind with the student (attachment owner). */
export async function coachHasAcceptedBind(
  db: Kysely<Database>,
  coachId: string,
  studentId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('bind_requests')
    .select(sql<number>`1`.as('exists'))
    .where('coach_id', '=', coachId)
    .where('student_id', '=', studentId)
    .where('status', '=', 'accepted')
    .limit(1)
    .executeTakeFirst();

  return row !== undefined;
}
