BEGIN;

SET search_path TO public;

ALTER TABLE plan_sets ADD CONSTRAINT plan_sets_load_mode_check CHECK (
  load_mode IS NULL OR
  load_mode IN ('pct', 'rpe', 'rir', 'weight_range', 'rpe_range', 'fixed_weight')
);

ALTER TABLE plan_sets
  ALTER COLUMN rpe_low  TYPE NUMERIC(3,1),
  ALTER COLUMN rpe_high TYPE NUMERIC(3,1);

ALTER TABLE plan_sets ADD COLUMN target_pct NUMERIC(4,1);

ALTER TABLE plan_sets ADD COLUMN weight_low  NUMERIC(6,2),
                      ADD COLUMN weight_high NUMERIC(6,2);

ALTER TABLE plan_sets ADD COLUMN target_rpe NUMERIC(3,1);

ALTER TABLE plan_sets ADD COLUMN target_weight NUMERIC(6,2);

ALTER TABLE plan_sets ADD CONSTRAINT plan_sets_intensity_values_check CHECK (
  (target_pct    IS NULL OR (target_pct BETWEEN 20.0 AND 110.0)) AND
  (target_rpe    IS NULL OR (target_rpe BETWEEN 1.0 AND 10.0)) AND
  (rir_target    IS NULL OR (rir_target BETWEEN 0 AND 9)) AND
  (rpe_low       IS NULL OR (rpe_low  BETWEEN 1.0 AND 10.0)) AND
  (rpe_high      IS NULL OR (rpe_high BETWEEN 1.0 AND 10.0)) AND
  (rpe_low  IS NULL OR rpe_high  IS NULL OR rpe_low  < rpe_high) AND
  (weight_low IS NULL OR weight_high IS NULL OR weight_low < weight_high) AND
  (target_weight IS NULL OR (target_weight > 0 AND target_weight < 1000)) AND
  (weight_low  IS NULL OR (weight_low  > 0 AND weight_low  < 1000)) AND
  (weight_high IS NULL OR (weight_high > 0 AND weight_high < 1000))
);

COMMIT;
