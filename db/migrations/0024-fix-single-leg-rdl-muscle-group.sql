-- Migration 0024: fix 单腿罗马尼亚硬拉 (ca70-…0108) muscle_groups quad → hamstring,
-- mirroring the iOS catalog correction (MeetPR PR #204). RDL is a hip hinge —
-- the quad tag was a seed error (cf. siblings …0109/…012d, both hamstring).
-- Context: David ruled 2026-07-02 that 单腿硬拉 (…0104) and 单腿罗马尼亚硬拉
-- (…0108) are two distinct exercises — no merge, no remap; name/name_en untouched.
-- Idempotent: UPDATE-by-id is safe to re-run.

BEGIN;

UPDATE exercises
SET muscle_groups = ARRAY['hamstring']::TEXT[]
WHERE id = '00000000-0000-0000-ca70-000000000108'::UUID;

COMMIT;
