import { describe, expect, it } from 'vitest';

import { toFeedbackWithVideo } from '../../src/handlers/feedback-serialization';
import { VIDEO_POSTER_PROCESS } from '../../src/services/oss';
import { makeFakeOss } from '../helpers/uploads';

const row = {
  id: 'feedback-1',
  coach_id: 'coach-1',
  student_id: 'student-1',
  day_date: null,
  plan_exercise_id: null,
  video_id: 'video-1',
  text: 'Good lift',
  posted_at: new Date('2026-11-06T12:00:00Z'),
  read_at: null,
  video_attachment_id: 'video-1',
  video_oss_key: 'attachments/student-1/video.mp4',
  video_exercise_name: 'Squat',
  video_exercise_owner: null,
  video_exercise_name_en: 'Squat',
  video_set_index: 0,
  video_weight_kg: '120',
  video_reps: 5,
  video_rpe: '8',
  video_logged_at: new Date('2026-11-06T11:00:00Z'),
};

describe('feedback video serialization (spec 060)', () => {
  it.each(['absent', 'non-OSS'] as const)(
    'keeps both preview fields null for %s storage',
    async (storage) => {
      const fake = makeFakeOss();
      delete fake.service.signVideoPosterUrl;
      const result = await toFeedbackWithVideo(
        row,
        undefined,
        storage === 'absent' ? undefined : fake.service,
      );
      expect(result.video).toMatchObject({
        id: 'video-1',
        poster_url: null,
        duration_seconds: null,
      });
      expect(fake.calls.signGet).toHaveLength(0);
    },
  );

  it('keeps feedback without an attachment video-null without signing', async () => {
    const fake = makeFakeOss();
    const result = await toFeedbackWithVideo(
      { ...row, video_attachment_id: null, video_oss_key: null },
      undefined,
      fake.service,
    );
    expect(result.video).toBeNull();
    expect(fake.calls.signPoster).toHaveLength(0);
  });
  it('adds a signed JPEG poster with the playback TTL and an unavailable duration', async () => {
    const oss = makeFakeOss();
    const result = await toFeedbackWithVideo(row, undefined, oss.service);

    expect(result.video).toMatchObject({
      id: 'video-1',
      weight_kg: '120.00',
      rpe: '8.0',
      duration_seconds: null,
      poster_url: expect.any(String),
    });
    const poster = new URL(result.video?.poster_url ?? 'https://missing.invalid');
    expect(poster.pathname).toBe('/attachments/student-1/video.mp4');
    expect(poster.searchParams.get('x-oss-process')).toBe(VIDEO_POSTER_PROCESS);
    expect(poster.searchParams.get('expires')).toBe('900');
  });
});
