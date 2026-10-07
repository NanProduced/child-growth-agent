-- G2 / 指南证据链 v1：观察发生时班级快照 + 指南证据容器（幂等，只新增列）
-- 执行顺序：在 initialize-demo-db.sql（或 upgrade-classes.sql）之后执行；依赖 observations 表。
-- 旧记录保持 NULL：历史班级未知，不用 classes.stage 动态回填，也不伪造 legacy_import 历史。
-- 不执行任何 UPDATE / DELETE，不改写 raw_text / ai_draft / confirmed_content。

ALTER TABLE observations
  ADD COLUMN IF NOT EXISTS class_context_snapshot jsonb;

ALTER TABLE observations
  ADD COLUMN IF NOT EXISTS guide_evidence jsonb;

COMMENT ON COLUMN observations.class_context_snapshot IS
  '观察发生时班级快照（ObservationClassContextSnapshot）；NULL=历史未知，不回填';
COMMENT ON COLUMN observations.guide_evidence IS
  '指南证据容器（ObservationGuideEvidence）；NULL=正常未关联，损坏值由读取方显式识别';
