-- YAYA v1 私有存储增量迁移（DATA1）
--
-- 幂等：全部使用 IF NOT EXISTS；表/索引/约束先建后回填，可重复执行。
-- 只新增 yaya_* 表，不修改任何现有业务表形状；yaya_attachment_appends 与
-- yaya_observation_attachment_meta 通过外键引用 observations，仅附加只读关系。
--
-- 语义要点：
-- - 会话/消息按账号私有：yaya_messages.(conversation_id, owner_account_id) 复合外键
--   绑定 yaya_conversations.(id, account_id)，消息 owner 不可能与会话 owner 脱钩。
-- - client_message_id 幂等：同一会话内唯一（仅对非 NULL 建部分唯一索引）。
-- - 预分配身份：proposal / batch / operation_id 在 prepare 时写库，操作行先于执行存在。
-- - 回执账本与业务写同事务提交：status 为 NULL 表示尚未产生回执（planning 态）。
-- - 附件删除租约：status ∈ ready/deleting/deleted + revision CAS；
--   delete_result=unknown 表示外部删除结果未知，不得恢复 ready。
-- - 附件引用唯一 (attachment_id, record_kind, record_id)，删除会话只解除本会话消息引用。

-- ------------------------------ 会话 ------------------------------
CREATE TABLE IF NOT EXISTS yaya_conversations (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id varchar(36) NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  title text,
  title_source_fragments jsonb NOT NULL DEFAULT '[]'::jsonb,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT yaya_conversations_revision_check CHECK (revision >= 1),
  CONSTRAINT yaya_conversations_title_refs_check CHECK (jsonb_typeof(title_source_fragments) = 'array')
);
CREATE INDEX IF NOT EXISTS yaya_conversations_owner_idx
  ON yaya_conversations (account_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS yaya_conversations_owner_id_unique
  ON yaya_conversations (id, account_id);

-- ------------------------------ 消息 ------------------------------
CREATE TABLE IF NOT EXISTS yaya_messages (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id varchar(36) NOT NULL,
  owner_account_id varchar(36) NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  client_message_id varchar(128),
  client_digest varchar(64),
  role varchar(16) NOT NULL,
  message_kind varchar(20) NOT NULL,
  fragments jsonb NOT NULL DEFAULT '[]'::jsonb,
  attachment_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  execution_state varchar(24) NOT NULL DEFAULT 'none',
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT yaya_messages_role_check CHECK (role IN ('user', 'assistant', 'tool')),
  CONSTRAINT yaya_messages_kind_check CHECK (message_kind IN ('text', 'image', 'tool_result', 'receipt', 'mixed')),
  CONSTRAINT yaya_messages_execution_check CHECK (execution_state IN ('none', 'pending_approval', 'executed', 'unknown')),
  CONSTRAINT yaya_messages_fragments_check CHECK (jsonb_typeof(fragments) = 'array'),
  CONSTRAINT yaya_messages_attachments_check CHECK (jsonb_typeof(attachment_ids) = 'array'),
  CONSTRAINT yaya_messages_conversation_owner_fk
    FOREIGN KEY (conversation_id, owner_account_id)
    REFERENCES yaya_conversations (id, account_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS yaya_messages_client_id_unique
  ON yaya_messages (conversation_id, client_message_id) WHERE client_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS yaya_messages_conversation_idx
  ON yaya_messages (conversation_id, created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS yaya_messages_owner_idx ON yaya_messages (owner_account_id);

-- ------------------------------ 提案与逐项身份 ------------------------------
CREATE TABLE IF NOT EXISTS yaya_proposals (
  id varchar(36) PRIMARY KEY,
  batch_id varchar(36) NOT NULL,
  conversation_id varchar(36) NOT NULL,
  owner_account_id varchar(36) NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  proposal_origin varchar(24) NOT NULL,
  auth jsonb NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'open',
  prepared_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT yaya_proposals_origin_check CHECK (proposal_origin IN ('teacher_card', 'model_suggestion')),
  CONSTRAINT yaya_proposals_status_check CHECK (status IN ('open', 'cancelled', 'closed')),
  CONSTRAINT yaya_proposals_auth_check CHECK (jsonb_typeof(auth) = 'object'),
  CONSTRAINT yaya_proposals_conversation_owner_fk
    FOREIGN KEY (conversation_id, owner_account_id)
    REFERENCES yaya_conversations (id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS yaya_proposals_owner_idx ON yaya_proposals (owner_account_id, prepared_at DESC);
CREATE INDEX IF NOT EXISTS yaya_proposals_conversation_idx ON yaya_proposals (conversation_id, prepared_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS yaya_proposals_batch_unique ON yaya_proposals (batch_id);

CREATE TABLE IF NOT EXISTS yaya_proposal_items (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id varchar(36) NOT NULL REFERENCES yaya_proposals(id) ON DELETE CASCADE,
  item_key varchar(128) NOT NULL,
  operation_id varchar(36) NOT NULL,
  target_id varchar(64) NOT NULL,
  action varchar(40) NOT NULL,
  resource varchar(20) NOT NULL,
  resource_ref jsonb NOT NULL,
  payload jsonb NOT NULL,
  content_digest varchar(64) NOT NULL,
  attachment_associations jsonb NOT NULL DEFAULT '[]'::jsonb,
  business_revision varchar(128),
  status varchar(16) NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT yaya_proposal_items_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  CONSTRAINT yaya_proposal_items_target_check CHECK (length(btrim(target_id)) > 0),
  CONSTRAINT yaya_proposal_items_key_unique UNIQUE (proposal_id, item_key),
  CONSTRAINT yaya_proposal_items_operation_unique UNIQUE (operation_id)
);
CREATE INDEX IF NOT EXISTS yaya_proposal_items_proposal_idx ON yaya_proposal_items (proposal_id);

-- ------------------------------ 批准 ------------------------------
CREATE TABLE IF NOT EXISTS yaya_approvals (
  id varchar(36) PRIMARY KEY,
  proposal_id varchar(36) NOT NULL REFERENCES yaya_proposals(id) ON DELETE RESTRICT,
  batch_id varchar(36) NOT NULL,
  actor_account_id varchar(36) NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  session_id varchar(36) NOT NULL,
  approval_source varchar(24) NOT NULL,
  items jsonb NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  cancelled_at timestamptz,
  consumed_at timestamptz,
  CONSTRAINT yaya_approvals_source_check CHECK (
    approval_source IN ('authenticated_entry', 'request_body_claim', 'model_output')
  ),
  CONSTRAINT yaya_approvals_items_check CHECK (jsonb_typeof(items) = 'array')
);
CREATE INDEX IF NOT EXISTS yaya_approvals_proposal_idx ON yaya_approvals (proposal_id);
CREATE INDEX IF NOT EXISTS yaya_approvals_actor_idx ON yaya_approvals (actor_account_id, approved_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS yaya_approvals_pending_unique
  ON yaya_approvals (proposal_id) WHERE cancelled_at IS NULL AND consumed_at IS NULL;

-- ------------------------------ 操作账本 ------------------------------
CREATE TABLE IF NOT EXISTS yaya_operations (
  operation_id varchar(36) PRIMARY KEY,
  proposal_id varchar(36) NOT NULL REFERENCES yaya_proposals(id) ON DELETE RESTRICT,
  item_key varchar(128) NOT NULL,
  batch_id varchar(36) NOT NULL,
  target_id varchar(64) NOT NULL,
  actor_account_id varchar(36) NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  approval_id varchar(36) REFERENCES yaya_approvals(id) ON DELETE RESTRICT,
  status varchar(32),
  effect varchar(16),
  business_object_id varchar(64),
  business_revision varchar(128),
  started_at timestamptz,
  recorded_at timestamptz,
  resolved_at timestamptz,
  superseded_by varchar(36) REFERENCES yaya_operations(operation_id) ON DELETE RESTRICT,
  superseded_at timestamptz,
  CONSTRAINT yaya_operations_status_check CHECK (
    status IS NULL OR status IN (
      'in_progress', 'saved', 'saved_detail_unavailable', 'unchanged',
      'failed', 'conflict', 'needs_verification'
    )
  ),
  CONSTRAINT yaya_operations_effect_check CHECK (effect IS NULL OR effect IN ('none', 'committed', 'unknown')),
  CONSTRAINT yaya_operations_unique UNIQUE (proposal_id, item_key)
);
CREATE INDEX IF NOT EXISTS yaya_operations_batch_idx ON yaya_operations (actor_account_id, batch_id);
CREATE INDEX IF NOT EXISTS yaya_operations_proposal_idx ON yaya_operations (proposal_id);
CREATE INDEX IF NOT EXISTS yaya_operations_superseded_idx ON yaya_operations (superseded_by) WHERE superseded_by IS NOT NULL;

-- ------------------------------ 附件元数据与引用 ------------------------------
CREATE TABLE IF NOT EXISTS yaya_attachments (
  id varchar(36) PRIMARY KEY,
  uploader_account_id varchar(36) NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  conversation_id varchar(36) REFERENCES yaya_conversations(id) ON DELETE SET NULL,
  object_key text NOT NULL,
  media_type varchar(64) NOT NULL,
  byte_size bigint NOT NULL,
  checksum varchar(128) NOT NULL,
  source_kind varchar(24) NOT NULL,
  derived_from varchar(64),
  metadata jsonb,
  status varchar(16) NOT NULL DEFAULT 'ready',
  revision integer NOT NULL DEFAULT 1,
  delete_result varchar(16),
  deleting_started_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT yaya_attachments_status_check CHECK (status IN ('ready', 'deleting', 'deleted')),
  CONSTRAINT yaya_attachments_delete_result_check CHECK (delete_result IS NULL OR delete_result IN ('deleted', 'unknown')),
  CONSTRAINT yaya_attachments_size_check CHECK (byte_size >= 0),
  CONSTRAINT yaya_attachments_checksum_check CHECK (length(btrim(checksum)) > 0),
  CONSTRAINT yaya_attachments_object_key_unique UNIQUE (object_key)
);
CREATE INDEX IF NOT EXISTS yaya_attachments_uploader_idx ON yaya_attachments (uploader_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS yaya_attachments_conversation_idx ON yaya_attachments (conversation_id) WHERE conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS yaya_attachment_refs (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id varchar(36) NOT NULL REFERENCES yaya_attachments(id) ON DELETE RESTRICT,
  record_kind varchar(16) NOT NULL,
  record_id varchar(36) NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  linked_by_account_id varchar(36) REFERENCES app_accounts(id) ON DELETE SET NULL,
  CONSTRAINT yaya_attachment_refs_kind_check CHECK (record_kind IN ('message', 'proposal', 'observation')),
  CONSTRAINT yaya_attachment_refs_unique UNIQUE (attachment_id, record_kind, record_id)
);
CREATE INDEX IF NOT EXISTS yaya_attachment_refs_attachment_idx ON yaya_attachment_refs (attachment_id);
CREATE INDEX IF NOT EXISTS yaya_attachment_refs_record_idx ON yaya_attachment_refs (record_kind, record_id);

-- 归档后资料附件的观察级修订号（CAS 前提）与独立追加审计。
CREATE TABLE IF NOT EXISTS yaya_observation_attachment_meta (
  observation_id varchar(36) PRIMARY KEY REFERENCES observations(id) ON DELETE RESTRICT,
  attachment_revision integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT yaya_observation_attachment_meta_revision_check CHECK (attachment_revision >= 0)
);

CREATE TABLE IF NOT EXISTS yaya_attachment_appends (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id varchar(36) NOT NULL REFERENCES yaya_attachments(id) ON DELETE RESTRICT,
  observation_id varchar(36) NOT NULL REFERENCES observations(id) ON DELETE RESTRICT,
  attachment_revision integer NOT NULL,
  appended_by_account_id varchar(36) REFERENCES app_accounts(id) ON DELETE SET NULL,
  approval_id varchar(36) REFERENCES yaya_approvals(id) ON DELETE SET NULL,
  note text,
  appended_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT yaya_attachment_appends_revision_check CHECK (attachment_revision >= 1),
  CONSTRAINT yaya_attachment_appends_unique UNIQUE (observation_id, attachment_id, attachment_revision)
);
CREATE INDEX IF NOT EXISTS yaya_attachment_appends_observation_idx
  ON yaya_attachment_appends (observation_id, appended_at);

-- ============================ R1：媒体附件存储接口增量 ============================
-- 与 docs/yaya-v1/media-storage-interface-r1.md 对应；幂等可重复执行。
-- 1) 三个派生对象、尺寸、原始类型、client_upload_id 幂等、删除租约令牌。
ALTER TABLE yaya_attachments ADD COLUMN IF NOT EXISTS client_upload_id varchar(128);
ALTER TABLE yaya_attachments ADD COLUMN IF NOT EXISTS thumbnail_key text;
ALTER TABLE yaya_attachments ADD COLUMN IF NOT EXISTS model_key text;
ALTER TABLE yaya_attachments ADD COLUMN IF NOT EXISTS thumbnail_checksum varchar(128);
ALTER TABLE yaya_attachments ADD COLUMN IF NOT EXISTS model_checksum varchar(128);
ALTER TABLE yaya_attachments ADD COLUMN IF NOT EXISTS width integer;
ALTER TABLE yaya_attachments ADD COLUMN IF NOT EXISTS height integer;
ALTER TABLE yaya_attachments ADD COLUMN IF NOT EXISTS deletion_lease_id varchar(64);

DO $$
BEGIN
  IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'yaya_attachments' AND column_name = 'checksum')
     AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'yaya_attachments' AND column_name = 'checksum_sha256')
  THEN
    ALTER TABLE yaya_attachments RENAME COLUMN checksum TO checksum_sha256;
  END IF;
END $$;

ALTER TABLE yaya_attachments DROP CONSTRAINT IF EXISTS yaya_attachments_status_check;
ALTER TABLE yaya_attachments ADD CONSTRAINT yaya_attachments_status_check
  CHECK (status IN ('pending', 'ready', 'deleting', 'deleted'));
ALTER TABLE yaya_attachments DROP CONSTRAINT IF EXISTS yaya_attachments_dimensions_check;
ALTER TABLE yaya_attachments ADD CONSTRAINT yaya_attachments_dimensions_check
  CHECK ((width IS NULL OR width >= 0) AND (height IS NULL OR height >= 0));
DROP INDEX IF EXISTS yaya_attachments_client_upload_unique;
CREATE UNIQUE INDEX yaya_attachments_client_upload_unique
  ON yaya_attachments (uploader_account_id, client_upload_id)
  WHERE client_upload_id IS NOT NULL;

-- 2) 聚合追加审计（MEDIA AttachmentAuditEntry）；原逐附件 revision 审计行保留。
ALTER TABLE yaya_attachment_appends ADD COLUMN IF NOT EXISTS audit_id varchar(36);
ALTER TABLE yaya_attachment_appends ADD COLUMN IF NOT EXISTS action varchar(40);
ALTER TABLE yaya_attachment_appends ADD COLUMN IF NOT EXISTS source_confirmed_at timestamptz;
ALTER TABLE yaya_attachment_appends ADD COLUMN IF NOT EXISTS request_id varchar(128);
ALTER TABLE yaya_attachment_appends ADD COLUMN IF NOT EXISTS attachment_ids jsonb;
ALTER TABLE yaya_attachment_appends ALTER COLUMN attachment_id DROP NOT NULL;
ALTER TABLE yaya_attachment_appends ALTER COLUMN attachment_revision DROP NOT NULL;
ALTER TABLE yaya_attachment_appends DROP CONSTRAINT IF EXISTS yaya_attachment_appends_revision_check;
ALTER TABLE yaya_attachment_appends ADD CONSTRAINT yaya_attachment_appends_revision_check
  CHECK (attachment_revision IS NULL OR attachment_revision >= 1);
ALTER TABLE yaya_attachment_appends DROP CONSTRAINT IF EXISTS yaya_attachment_appends_action_check;
ALTER TABLE yaya_attachment_appends ADD CONSTRAINT yaya_attachment_appends_action_check
  CHECK (action IS NULL OR action IN ('attach_observation_images', 'create_observation_attachments'));
CREATE INDEX IF NOT EXISTS yaya_attachment_appends_audit_idx
  ON yaya_attachment_appends (audit_id) WHERE audit_id IS NOT NULL;
