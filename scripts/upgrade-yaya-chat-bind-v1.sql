-- YAYA-DATA-CHAT-BIND1 消息绑定与恢复标记迁移（DATA1）
--
-- 只改 yaya_messages：新增 run 身份、绑定状态、恢复标记三列。
-- 全部幂等（IF NOT EXISTS / 名字守卫），可重复执行；只增列不改写任何既有行，
-- 旧 assistant 消息不回填（binding_state 为 NULL，读侧按 unknown 受限投影）。
-- 业务表形状不变：不触碰任何 yaya_* 之外的表，不删除不修改既有列。
--
-- 列语义与 src/storage/database/shared/schema.ts 保持一致：
-- - run_id：产生该消息的 run 身份（内部通道写入）；user / 旧消息为 NULL
-- - binding_state：'bound' / 'unknown'；NULL 一律读为 unknown
-- - recovery_mark：yaya-recovery-v1 标记 jsonb；无标记为 NULL
--
-- 部署顺序（见交付文档）：本脚本必须在 APP 侧 run 终态写入启用之前执行；
-- yaya_runs 等 APP 运行时表由 APP 域迁移，不在此处创建，run_id 不设外键。

ALTER TABLE yaya_messages ADD COLUMN IF NOT EXISTS run_id varchar(64);
ALTER TABLE yaya_messages ADD COLUMN IF NOT EXISTS binding_state varchar(16);
ALTER TABLE yaya_messages ADD COLUMN IF NOT EXISTS recovery_mark jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'yaya_messages_binding_state_check' AND contype = 'c'
  ) THEN
    ALTER TABLE yaya_messages
      ADD CONSTRAINT yaya_messages_binding_state_check
      CHECK (binding_state IS NULL OR binding_state IN ('bound', 'unknown'));
  END IF;
END $$;
