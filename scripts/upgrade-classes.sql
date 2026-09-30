-- P2-B 幼儿园班级领域模型迁移（幂等，可在已有库上重复执行）
-- 变更范围：
--   1) 新增 classes、child_class_enrollments；
--   2) observations 增加发生时班级快照 class_id；
--   3) 现有演示儿童迁移到真实班级与分班历史。
-- 不删除 children / observations 任何数据；
-- 不修改 raw_text、ai_draft、confirmed_content；
-- 保留 children.class_name 作为兼容字段（仅按分班关系同步显示值）；
-- 不新增 teacher_id、学校 / 园区 / 多租户层级。

-- 1) 班级表（停用用 is_active 表示，不做物理删除）
CREATE TABLE IF NOT EXISTS classes (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(50) NOT NULL,
  stage varchar(10) NOT NULL,
  school_year varchar(20) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  CONSTRAINT classes_name_school_year_unique UNIQUE (name, school_year),
  CONSTRAINT classes_stage_check CHECK (stage IN ('small', 'middle', 'large'))
);

-- 2) 儿童班级归属历史：end_date 为空表示当前在班，历史关系只新增不回改
CREATE TABLE IF NOT EXISTS child_class_enrollments (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id varchar(36) NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  class_id varchar(36) NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
  start_date date NOT NULL,
  end_date date,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 3) 观察发生时班级快照：儿童转班后旧观察仍保留原班级语境
ALTER TABLE observations
  ADD COLUMN IF NOT EXISTS class_id varchar(36);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'observations_class_id_fkey'
       AND conrelid = 'observations'::regclass
  ) THEN
    ALTER TABLE observations
      ADD CONSTRAINT observations_class_id_fkey
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- 4) 索引
CREATE INDEX IF NOT EXISTS classes_stage_idx ON classes(stage);
CREATE INDEX IF NOT EXISTS classes_is_active_idx ON classes(is_active);
CREATE INDEX IF NOT EXISTS enrollments_child_id_idx ON child_class_enrollments(child_id);
CREATE INDEX IF NOT EXISTS enrollments_class_id_idx ON child_class_enrollments(class_id);
-- 一个儿童同一时间只能有一个未结束的班级归属
CREATE UNIQUE INDEX IF NOT EXISTS enrollments_current_child_idx
  ON child_class_enrollments(child_id)
  WHERE end_date IS NULL;
CREATE INDEX IF NOT EXISTS observations_class_id_idx ON observations(class_id);

-- 5) 演示班级（三个学段）：只新增 / 更新 is_demo 行，不触碰任何非演示数据
INSERT INTO classes (id, name, stage, school_year, is_active, is_demo, created_at)
VALUES
  ('c3c30000-0000-4000-8000-000000000001', '向日葵班', 'middle', '2026-2027', true, true, '2026-09-01T08:00:00+08:00'),
  ('c3c30000-0000-4000-8000-000000000002', '彩虹班', 'small', '2026-2027', true, true, '2026-09-01T08:00:00+08:00'),
  ('c3c30000-0000-4000-8000-000000000003', '蒲公英班', 'large', '2026-2027', true, true, '2026-09-01T08:00:00+08:00')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  stage = EXCLUDED.stage,
  school_year = EXCLUDED.school_year,
  is_active = EXCLUDED.is_active,
  is_demo = EXCLUDED.is_demo
WHERE classes.is_demo = true;

-- 6) 演示儿童分班：只新增合成数据的班级关系，不修改出生日期与观察原文。
--    最终映射见本文件末尾说明；石头保留一条已结束的向日葵班历史（转班语境）。
INSERT INTO child_class_enrollments (id, child_id, class_id, start_date, end_date)
SELECT v.id, v.child_id, v.class_id, v.start_date, v.end_date
FROM (VALUES
  ('d4d40000-0000-4000-8000-000000000001', 'a1c10000-0000-4000-8000-000000000001', 'c3c30000-0000-4000-8000-000000000001', '2026-09-01'::date, NULL::date),
  ('d4d40000-0000-4000-8000-000000000002', 'a1c10000-0000-4000-8000-000000000002', 'c3c30000-0000-4000-8000-000000000002', '2026-09-01'::date, NULL::date),
  ('d4d40000-0000-4000-8000-000000000003', 'a1c10000-0000-4000-8000-000000000003', 'c3c30000-0000-4000-8000-000000000001', '2026-09-01'::date, NULL::date),
  ('d4d40000-0000-4000-8000-000000000004', 'a1c10000-0000-4000-8000-000000000004', 'c3c30000-0000-4000-8000-000000000001', '2026-09-01'::date, NULL::date),
  ('d4d40000-0000-4000-8000-000000000005', 'a1c10000-0000-4000-8000-000000000005', 'c3c30000-0000-4000-8000-000000000002', '2026-09-01'::date, NULL::date),
  ('d4d40000-0000-4000-8000-000000000006', 'a1c10000-0000-4000-8000-000000000006', 'c3c30000-0000-4000-8000-000000000001', '2026-09-01'::date, '2026-09-20'::date),
  ('d4d40000-0000-4000-8000-000000000007', 'a1c10000-0000-4000-8000-000000000006', 'c3c30000-0000-4000-8000-000000000003', '2026-09-21'::date, NULL::date)
) AS v(id, child_id, class_id, start_date, end_date)
WHERE EXISTS (SELECT 1 FROM children c WHERE c.id = v.child_id)
  AND EXISTS (SELECT 1 FROM classes k WHERE k.id = v.class_id)
ON CONFLICT (id) DO NOTHING;

-- 7) 回填观察发生时班级快照：按观察日期落在哪段归属决定，只填 class_id 为空的行
UPDATE observations o
   SET class_id = (
     SELECT e.class_id
       FROM child_class_enrollments e
      WHERE e.child_id = o.child_id
        AND e.start_date <= o.observed_at
        AND (e.end_date IS NULL OR e.end_date >= o.observed_at)
      ORDER BY e.start_date DESC
      LIMIT 1
   )
 WHERE o.class_id IS NULL
   AND EXISTS (
     SELECT 1 FROM child_class_enrollments e WHERE e.child_id = o.child_id
   );

-- 8) 同步兼容字段 children.class_name = 当前班级名（只在不一致时更新）
UPDATE children c
   SET class_name = k.name,
       updated_at = now()
  FROM child_class_enrollments e
  JOIN classes k ON k.id = e.class_id
 WHERE e.child_id = c.id
   AND e.end_date IS NULL
   AND c.class_name IS DISTINCT FROM k.name;

-- 演示班级与儿童最终映射：
--   向日葵班（middle 中班，2026-2027）：糖糖、朵朵、乐乐；石头（2026-09-01 ~ 2026-09-20 历史）
--   彩虹班（small 小班，2026-2027）：果果、悠悠
--   蒲公英班（large 大班，2026-2027）：石头（2026-09-21 至今）
