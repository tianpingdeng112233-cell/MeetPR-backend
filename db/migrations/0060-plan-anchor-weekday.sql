-- spec 037: D1 weekday display anchor for the week-band editor.
-- Pure display metadata: positional day_of_week canon is untouched; shifts,
-- sequence progression and settlement keep reading ordinals only.
BEGIN;
SET search_path TO public;

ALTER TABLE plans ADD COLUMN anchor_weekday SMALLINT;

ALTER TABLE plans ADD CONSTRAINT plans_anchor_weekday_check CHECK (
  anchor_weekday IS NULL OR anchor_weekday BETWEEN 1 AND 7
);

COMMIT;
