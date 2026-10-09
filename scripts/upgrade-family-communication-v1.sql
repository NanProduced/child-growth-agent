-- Independent private communication drafts. Never modifies observations or profiles.
BEGIN;
CREATE TABLE IF NOT EXISTS family_communications (
  id varchar(36) PRIMARY KEY,
  owner_account_id varchar(36) NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  child_id varchar(36) NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  client_request_id varchar(36) NOT NULL,
  request_digest varchar(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  period jsonb NOT NULL CHECK (jsonb_typeof(period) = 'object'),
  range_from date NOT NULL,
  range_to date NOT NULL CHECK (range_to >= range_from),
  range_label text NOT NULL,
  class_premise varchar(36) NOT NULL,
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) BETWEEN 1 AND 60),
  note text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  author_name text NOT NULL,
  ai_model text,
  state varchar(16) NOT NULL DEFAULT 'generating' CHECK (state IN ('generating','draft','reviewed','failed')),
  deadline_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '5 minutes'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT family_communications_owner_request_unique UNIQUE (owner_account_id, client_request_id)
);
ALTER TABLE family_communications ADD COLUMN IF NOT EXISTS deadline_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '5 minutes');
CREATE INDEX IF NOT EXISTS family_communications_owner_child_idx
  ON family_communications (owner_account_id, child_id, created_at DESC);
COMMIT;
