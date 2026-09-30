-- P1-B 必要补充 Agent：为单条观察记录增加最小工作流上下文。
-- 幂等，可在已有 observations 表上执行；不删除、不重命名任何字段。

ALTER TABLE observations
  ADD COLUMN IF NOT EXISTS agent_context jsonb;
