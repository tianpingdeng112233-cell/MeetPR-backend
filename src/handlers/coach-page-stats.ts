import type { Kysely } from 'kysely';
import type { Database } from '../db/types';
import { resolveCanonicalAcceptedBonds } from '../db/bonds';
import { computeCoachPageStats } from '../domain/coach-page-stats';
import { fetchScopedLogs, onboardingSnapshot } from './exercise-stats';

export async function fetchCoachPageStats(db: Kysely<Database>, coachId: string, now = new Date()) {
  const [bonds, plans, completions, prs, videos] = await Promise.all([
    db
      .selectFrom('bind_requests')
      .select(['student_id', 'responded_at'])
      .where('coach_id', '=', coachId)
      .where('status', '=', 'accepted')
      .execute(),
    db
      .selectFrom('plans')
      .select('trainee_id')
      .where('coach_id', '=', coachId)
      .where('status', 'in', ['published', 'paused', 'completed'])
      .execute(),
    db
      .selectFrom('plan_day_completions as c')
      .innerJoin('plan_days as d', 'd.id', 'c.plan_day_id')
      .innerJoin('plans as p', 'p.id', 'd.plan_id')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('p.coach_id', '=', coachId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('student_events')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('coach_id', '=', coachId)
      .where('event_type', '=', 'pr_e1rm')
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('attachments')
      .select(['id', 'created_at'])
      .where('source_coach_id', '=', coachId)
      .where('kind', '=', 'set_video')
      .where('status', '=', 'ready')
      .where('created_at', '>=', new Date(now.getTime() - 90 * 86_400_000))
      .execute(),
  ]);
  const studentIds = [...new Set(plans.map((p) => p.trainee_id))].sort();
  const videoIds = videos.map((v) => v.id);
  const [canonical, students, feedback, markers] = await Promise.all([
    resolveCanonicalAcceptedBonds(db, [...new Set(bonds.map((b) => b.student_id))]),
    Promise.all(
      studentIds.map(async (id) => ({
        profile: await onboardingSnapshot(db, id),
        logs: await fetchScopedLogs(db, coachId, id),
      })),
    ),
    videoIds.length
      ? db
          .selectFrom('feedback')
          .select(['video_id', 'posted_at'])
          .where('coach_id', '=', coachId)
          .where('video_id', 'in', videoIds)
          .execute()
      : [],
    videoIds.length
      ? db
          .selectFrom('video_markers')
          .select(['video_id', 'created_at'])
          .where('coach_id', '=', coachId)
          .where('video_id', 'in', videoIds)
          .execute()
      : [],
  ]);
  const accepted = bonds.flatMap((b) => (b.responded_at ? [b.responded_at.getTime()] : []));
  return computeCoachPageStats({
    now,
    firstAcceptedAt: accepted.length ? new Date(Math.min(...accepted)) : null,
    activeStudentCount: canonical.filter((b) => b.coach_id === coachId).length,
    totalStudentCount: new Set(bonds.map((b) => b.student_id)).size,
    completedSessionCount: Number(completions.count),
    prCount: Number(prs.count),
    students,
    videos: videos.map((video) => ({
      createdAt: video.created_at,
      feedbackAt: [
        ...feedback.filter((f) => f.video_id === video.id).map((f) => f.posted_at),
        ...markers.filter((m) => m.video_id === video.id).map((m) => m.created_at),
      ],
    })),
  });
}
