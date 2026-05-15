import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';

import {
  giveVideoConsent,
  insertVideo,
  makeVideoContext,
  planExerciseId,
  studentId,
  validThumbnailKey,
  validVideoKey,
} from '../helpers/video';

describe('migration 0007 video attachments and privacy consents', () => {
  it('enforces one video per student plan exercise set slot', async () => {
    const ctx = await makeVideoContext();
    await insertVideo(ctx);

    await expect(
      insertVideo(ctx, {
        oss_key: validVideoKey(studentId, planExerciseId, 0, 'mov'),
        thumbnail_oss_key: validThumbnailKey(studentId, planExerciseId, 0),
      }),
    ).rejects.toThrow();
  });

  it('enforces duration and file size caps', async () => {
    const ctx = await makeVideoContext();

    await expect(
      ctx.db
        .insertInto('video_attachments')
        .values({
          student_id: studentId,
          plan_exercise_id: planExerciseId,
          set_index: 0,
          oss_key: validVideoKey(),
          oss_upload_id: 'upload-id',
          duration_seconds: 121.01,
          file_size_bytes: 123,
          thumbnail_oss_key: validThumbnailKey(),
          recorded_at: new Date(),
          uploaded_at: new Date(),
          coach_visible_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();

    await expect(
      ctx.db
        .insertInto('video_attachments')
        .values({
          student_id: studentId,
          plan_exercise_id: planExerciseId,
          set_index: 1,
          oss_key: validVideoKey(studentId, planExerciseId, 1),
          oss_upload_id: 'upload-id',
          duration_seconds: 45,
          file_size_bytes: 1_073_741_825,
          thumbnail_oss_key: validThumbnailKey(studentId, planExerciseId, 1),
          recorded_at: new Date(),
          uploaded_at: new Date(),
          coach_visible_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('enforces one consent row per user and consent kind', async () => {
    const ctx = await makeVideoContext();
    await giveVideoConsent(ctx);

    await expect(
      ctx.db
        .insertInto('privacy_consents')
        .values({
          user_id: studentId,
          consent_kind: 'video_visibility_v1',
          agreed_at: new Date(),
          user_agent: null,
          ip_address: null,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('requires coach_visible_at and accepts inet consent IPs', async () => {
    const ctx = await makeVideoContext();

    await expect(
      sql`
        INSERT INTO video_attachments (
          student_id,
          plan_exercise_id,
          set_index,
          oss_key,
          oss_upload_id,
          duration_seconds,
          file_size_bytes,
          thumbnail_oss_key,
          recorded_at,
          uploaded_at
        )
        VALUES (
          ${studentId},
          ${planExerciseId},
          ${0},
          ${validVideoKey()},
          ${'upload-id'},
          ${45},
          ${123456},
          ${validThumbnailKey()},
          ${new Date()},
          ${new Date()}
        )
      `.execute(ctx.db),
    ).rejects.toThrow();

    await ctx.db
      .insertInto('privacy_consents')
      .values({
        user_id: studentId,
        consent_kind: 'video_visibility_v1',
        agreed_at: new Date(),
        user_agent: 'MeetPRTests/1',
        ip_address: '127.0.0.1',
      })
      .execute();

    const row = await ctx.db
      .selectFrom('privacy_consents')
      .select(['ip_address'])
      .where('user_id', '=', studentId)
      .executeTakeFirstOrThrow();
    expect(row.ip_address).toBe('127.0.0.1');
  });
});
