BEGIN;
SET search_path TO public;

ALTER TABLE attachments
  ADD COLUMN coach_viewed_at TIMESTAMPTZ;

-- 存量照护:教练已发过视频级反馈(0046)或打过点(0054)的视频,显然已经审看过,
-- 回填为其最早的处理时间,避免升级后第一屏满墙假「待审」。
UPDATE attachments a
SET coach_viewed_at = sub.first_reviewed
FROM (
  SELECT video_id, MIN(created) AS first_reviewed
  FROM (
    SELECT video_id, posted_at AS created FROM feedback WHERE video_id IS NOT NULL
    UNION ALL
    SELECT video_id, created_at AS created FROM video_markers
  ) events
  GROUP BY video_id
) sub
WHERE a.id = sub.video_id
  AND a.coach_viewed_at IS NULL;

COMMIT;
