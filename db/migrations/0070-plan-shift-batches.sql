BEGIN;

SET search_path TO public;

ALTER TABLE plan_day_shifts
  ADD COLUMN seq BIGSERIAL NOT NULL;

UPDATE plan_day_shifts AS s
SET seq = (
  SELECT count(*) + 1
  FROM plan_day_shifts AS o
  WHERE o.created_at < s.created_at
     OR (o.created_at = s.created_at AND o.id < s.id)
);

SELECT setval(pg_get_serial_sequence('plan_day_shifts', 'seq'), max(seq))
FROM plan_day_shifts;

CREATE INDEX plan_day_shifts_seq_idx
  ON plan_day_shifts (seq);

CREATE TABLE plan_shift_batches (
  id          UUID PRIMARY KEY,
  plan_id     UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  actor_id    UUID NOT NULL REFERENCES users(id),
  actor_role  TEXT NOT NULL CHECK (actor_role IN ('coach', 'coached_student')),
  anchor_date DATE NOT NULL,
  offset_days INTEGER NOT NULL CHECK (offset_days BETWEEN 1 AND 30),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX plan_shift_batches_plan_created_idx
  ON plan_shift_batches (plan_id, created_at DESC);

INSERT INTO plan_shift_batches (id, plan_id, actor_id, actor_role, anchor_date, offset_days, created_at)
SELECT s.batch_id, d.plan_id, min(s.student_id::text)::uuid, 'coached_student',
       min(s.shifted_to_date) - 1, 1, min(s.created_at)
FROM plan_day_shifts s JOIN plan_days d ON d.id = s.plan_day_id
GROUP BY s.batch_id, d.plan_id;

COMMIT;
