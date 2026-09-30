-- P1-D：为幼儿档案增加成长档案 JSONB 字段。
-- 幂等，可在已有 children 表上重复执行；不删除、不重命名任何字段。

ALTER TABLE children
  ADD COLUMN IF NOT EXISTS growth_profile jsonb;
