-- Migration 0002: exercise catalog (system-seeded + coach customs).
-- Spec: specs/002-coach-planning-crud/SPEC.md
-- Source: data-model.md v1.1 §1.4
-- ADR: 004 (no ORM, hand-managed SQL).

BEGIN;

CREATE TABLE exercises (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     TEXT         NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  exercise_type            TEXT         NOT NULL,
  main_lift_family         TEXT,
  is_competition_lift      BOOLEAN      NOT NULL DEFAULT FALSE,
  muscle_groups            TEXT[]       NOT NULL,
  equipment                TEXT[]       NOT NULL,
  movement_pattern         TEXT[]       NOT NULL DEFAULT '{}',
  created_by_coach_id      UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT exercises_exercise_type_check
    CHECK (exercise_type IN ('main_lift', 'main_lift_variation', 'accessory')),
  CONSTRAINT exercises_main_lift_family_check
    CHECK (main_lift_family IS NULL OR main_lift_family IN ('squat', 'bench', 'deadlift')),
  CONSTRAINT exercises_main_lift_family_consistency CHECK (
    (exercise_type = 'accessory' AND main_lift_family IS NULL) OR
    (exercise_type IN ('main_lift', 'main_lift_variation') AND main_lift_family IS NOT NULL)
  ),
  CONSTRAINT exercises_muscle_groups_valid CHECK (
    muscle_groups <@ ARRAY[
      'chest','shoulder','back','biceps','triceps','core','quad','hamstring','glute'
    ]::TEXT[]
    AND cardinality(muscle_groups) >= 1
  ),
  CONSTRAINT exercises_equipment_valid CHECK (
    equipment <@ ARRAY['barbell','dumbbell','machine','bodyweight']::TEXT[]
    AND cardinality(equipment) >= 1
  ),
  CONSTRAINT exercises_movement_pattern_valid CHECK (
    movement_pattern <@ ARRAY['push','pull']::TEXT[]
  )
);

CREATE INDEX exercises_muscle_groups_gin    ON exercises USING GIN (muscle_groups);
CREATE INDEX exercises_equipment_gin        ON exercises USING GIN (equipment);
CREATE INDEX exercises_movement_pattern_gin ON exercises USING GIN (movement_pattern);

CREATE INDEX exercises_created_by_coach_id_idx
  ON exercises (created_by_coach_id)
  WHERE created_by_coach_id IS NOT NULL;

INSERT INTO exercises (name, exercise_type, main_lift_family, is_competition_lift, muscle_groups, equipment, movement_pattern) VALUES
  ('竞技深蹲',     'main_lift',           'squat',    TRUE,  ARRAY['quad','glute','core']::TEXT[], ARRAY['barbell']::TEXT[],     ARRAY[]::TEXT[]),
  ('高杠深蹲',     'main_lift_variation', 'squat',    FALSE, ARRAY['quad','glute','core']::TEXT[], ARRAY['barbell']::TEXT[],     ARRAY[]::TEXT[]),
  ('哈克深蹲',     'main_lift_variation', 'squat',    FALSE, ARRAY['quad','glute']::TEXT[],         ARRAY['machine']::TEXT[],     ARRAY[]::TEXT[]),
  ('竞技卧推',     'main_lift',           'bench',    TRUE,  ARRAY['chest','triceps','shoulder']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['push']::TEXT[]),
  ('窄距卧推',     'main_lift_variation', 'bench',    FALSE, ARRAY['triceps','chest']::TEXT[],      ARRAY['barbell']::TEXT[],     ARRAY['push']::TEXT[]),
  ('传统硬拉',     'main_lift',           'deadlift', TRUE,  ARRAY['hamstring','glute','back','core']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['pull']::TEXT[]),
  ('相扑硬拉',     'main_lift_variation', 'deadlift', FALSE, ARRAY['hamstring','glute','quad','back','core']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['pull']::TEXT[]),
  ('引体向上',     'accessory',           NULL,       FALSE, ARRAY['back','biceps']::TEXT[],        ARRAY['bodyweight']::TEXT[],  ARRAY['pull']::TEXT[]),
  ('杠铃划船',     'accessory',           NULL,       FALSE, ARRAY['back','biceps']::TEXT[],        ARRAY['barbell']::TEXT[],     ARRAY['pull']::TEXT[]),
  ('哑铃肩推',     'accessory',           NULL,       FALSE, ARRAY['shoulder','triceps']::TEXT[],   ARRAY['dumbbell']::TEXT[],    ARRAY['push']::TEXT[]),
  ('臂屈伸',       'accessory',           NULL,       FALSE, ARRAY['triceps','chest']::TEXT[],      ARRAY['bodyweight']::TEXT[],  ARRAY['push']::TEXT[]),
  ('哑铃弯举',     'accessory',           NULL,       FALSE, ARRAY['biceps']::TEXT[],               ARRAY['dumbbell']::TEXT[],    ARRAY['pull']::TEXT[]),
  ('罗马尼亚硬拉', 'accessory',           NULL,       FALSE, ARRAY['hamstring','glute','back']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['pull']::TEXT[]),
  ('腿举',         'accessory',           NULL,       FALSE, ARRAY['quad','glute']::TEXT[],         ARRAY['machine']::TEXT[],     ARRAY[]::TEXT[]),
  ('卷腹',         'accessory',           NULL,       FALSE, ARRAY['core']::TEXT[],                 ARRAY['bodyweight']::TEXT[],  ARRAY[]::TEXT[]);

COMMIT;
