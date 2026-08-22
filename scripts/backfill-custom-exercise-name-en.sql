UPDATE exercises
SET name_en = v.name_en
FROM (
  VALUES
    ('单手勾放哑铃', 'Single-Arm DB Finger Curl'),
    ('低杆位保加利亚深蹲', 'Low Bar Bulgarian Split Squat'),
    ('高杆节奏蹲310', 'High Bar Tempo Squat 310'),
    ('节奏传统硬拉 500', 'Tempo Conventional Deadlift 500'),
    ('节奏卧推 310', 'Tempo Bench 310'),
    ('节奏无腿卧推530', 'Feet Up Tempo Bench 530'),
    ('节奏窄推 310', 'Close Grip Tempo Bench 310'),
    ('静力两头起', 'V-Sit Hold'),
    ('帕洛夫推', 'Cable Pallof Press'),
    ('平板侧支撑', 'Side Plank'),
    ('绳索对握弯举', 'Rope Cable Hammer Curl'),
    ('长暂停深蹲 2s', '2s Pause Squat'),
    ('长暂停卧推 2s', '2s Pause Bench'),
    ('坐姿哑铃推肩', 'Seated DB Shoulder Press')
) AS v(name, name_en)
WHERE exercises.name = v.name
  AND exercises.created_by_coach_id IS NOT NULL
  AND exercises.name_en IS NULL;

SELECT name, name_en
FROM exercises
WHERE created_by_coach_id IS NOT NULL
ORDER BY name;
