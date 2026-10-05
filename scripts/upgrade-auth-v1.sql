-- AUTH1 单园所账号与授权 v1：账号、会话、教师任教关系（追加式迁移）
-- 幂等：可重复执行；不删除、不改写既有业务表与数据。
-- 与 src/storage/database/shared/schema.ts 的三个新表保持一致。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) 账号
CREATE TABLE IF NOT EXISTS app_accounts (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  username varchar(64) NOT NULL,
  display_name varchar(50) NOT NULL,
  password_hash text NOT NULL,
  role varchar(10) NOT NULL,
  status varchar(10) NOT NULL DEFAULT 'active',
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS app_accounts_username_unique ON app_accounts (username);
CREATE INDEX IF NOT EXISTS app_accounts_role_idx ON app_accounts (role);
CREATE INDEX IF NOT EXISTS app_accounts_status_idx ON app_accounts (status);

-- 旧表也必须验证；遇到脏数据直接失败，禁止默认化、改写或删除账号。
-- 同一 DO 内添加并验证，任一失败即回滚本块；重复执行不重复添加约束。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'app_accounts'::regclass AND conname = 'app_accounts_role_check'
  ) THEN
    ALTER TABLE app_accounts ADD CONSTRAINT app_accounts_role_check
      CHECK (role IN ('admin', 'teacher')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'app_accounts'::regclass AND conname = 'app_accounts_status_check'
  ) THEN
    ALTER TABLE app_accounts ADD CONSTRAINT app_accounts_status_check
      CHECK (status IN ('active', 'disabled')) NOT VALID;
  END IF;
  ALTER TABLE app_accounts VALIDATE CONSTRAINT app_accounts_role_check;
  ALTER TABLE app_accounts VALIDATE CONSTRAINT app_accounts_status_check;
END $$;

-- 2) 会话：只存令牌 SHA-256 哈希；撤销只写 revoked_at/revoked_reason
CREATE TABLE IF NOT EXISTS app_sessions (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id varchar(36) NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  token_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason varchar(30)
);

CREATE UNIQUE INDEX IF NOT EXISTS app_sessions_token_hash_unique ON app_sessions (token_hash);
CREATE INDEX IF NOT EXISTS app_sessions_account_id_idx ON app_sessions (account_id);
CREATE INDEX IF NOT EXISTS app_sessions_expires_at_idx ON app_sessions (expires_at);

-- 3) 教师任教关系：撤销只写 removed_at；同一 (账号, 班级) 至多一条当前关系
CREATE TABLE IF NOT EXISTS teacher_class_assignments (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id varchar(36) NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  class_id varchar(36) NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by_account_id varchar(36) REFERENCES app_accounts(id) ON DELETE SET NULL,
  removed_at timestamptz,
  removed_by_account_id varchar(36) REFERENCES app_accounts(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS teacher_class_assignments_current_unique
  ON teacher_class_assignments (account_id, class_id)
  WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS teacher_class_assignments_account_idx ON teacher_class_assignments (account_id);
CREATE INDEX IF NOT EXISTS teacher_class_assignments_class_idx ON teacher_class_assignments (class_id);
