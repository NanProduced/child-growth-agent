-- ============================ YAYA-AGENT-APP1：run 持久化 ============================
-- 唯一 owner：AGENT-APP1。只新增 run 所需表/索引，不改既有业务或 yaya 表。
-- owner + conversation + client_request_id 绑定原请求；同键同内容不再次派发，异内容 409。
-- 状态：active（本进程派发中）/ terminal（终态已落库）/ interrupted（不可核验的中断恢复标记）。
-- dependencies 按 run 累积（引用、图片 id、历史片段快照），只增不覆盖，供跨进程查询重核。

CREATE TABLE IF NOT EXISTS yaya_runs (
  id varchar(36) PRIMARY KEY,
  owner_account_id varchar(36) NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  conversation_id varchar(36) NOT NULL,
  client_request_id varchar(128) NOT NULL,
  request_digest varchar(64) NOT NULL,
  user_text text NOT NULL,
  attachment_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  expected_conversation_revision integer NOT NULL,
  session_id varchar(36) NOT NULL,
  owner_instance varchar(64) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'active',
  outcome jsonb,
  dependencies jsonb NOT NULL DEFAULT '[]'::jsonb,
  cancel_requested_at timestamptz,
  replaced_by varchar(36),
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  terminal_at timestamptz,
  CONSTRAINT yaya_runs_conversation_owner_fk
    FOREIGN KEY (conversation_id, owner_account_id)
    REFERENCES yaya_conversations(id, account_id) ON DELETE CASCADE,
  CONSTRAINT yaya_runs_client_request_unique
    UNIQUE (owner_account_id, conversation_id, client_request_id),
  CONSTRAINT yaya_runs_state_check CHECK (state IN ('active', 'terminal', 'interrupted')),
  CONSTRAINT yaya_runs_revision_check CHECK (expected_conversation_revision >= 1),
  CONSTRAINT yaya_runs_digest_check CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT yaya_runs_attachments_check CHECK (jsonb_typeof(attachment_ids) = 'array'),
  CONSTRAINT yaya_runs_dependencies_check CHECK (jsonb_typeof(dependencies) = 'array')
);

CREATE INDEX IF NOT EXISTS yaya_runs_owner_conversation_idx
  ON yaya_runs (owner_account_id, conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS yaya_runs_active_instance_idx
  ON yaya_runs (owner_instance) WHERE state = 'active';
