import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  timestamp,
  boolean,
  date,
  jsonb,
  index,
  integer,
  bigint,
  unique,
  uniqueIndex,
  serial,
  check,
} from "drizzle-orm/pg-core";

/**
 * 系统表：health_check（保留，勿删）
 */
export const healthCheck = pgTable("health_check", {
  id: serial().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow(),
});

/**
 * 幼儿档案（第一阶段：演示班级虚拟幼儿，合成数据以 is_demo 标记）
 */
export const children = pgTable(
  "children",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: varchar("name", { length: 50 }).notNull(),
    gender: varchar("gender", { length: 10 }).notNull(),
    birth_date: date("birth_date").notNull(),
    /** 兼容字段：冗余保存当前班级名，权威来源是 child_class_enrollments + classes */
    class_name: varchar("class_name", { length: 50 }).notNull().default("向日葵班"),
    avatar_emoji: varchar("avatar_emoji", { length: 16 }),
    note: text("note"),
    growth_profile: jsonb("growth_profile"),
    is_demo: boolean("is_demo").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => [
    index("children_class_name_idx").on(t.class_name),
    index("children_created_at_idx").on(t.created_at),
  ],
);

/**
 * 班级（芽芽观察：小班 small / 中班 middle / 大班 large）
 * 停用用 is_active 表示，不做物理删除，历史观察与分班关系始终保留。
 */
export const classes = pgTable(
  "classes",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: varchar("name", { length: 50 }).notNull(),
    stage: varchar("stage", { length: 10 }).notNull(),
    school_year: varchar("school_year", { length: 20 }).notNull(),
    is_active: boolean("is_active").notNull().default(true),
    is_demo: boolean("is_demo").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => [
    index("classes_stage_idx").on(t.stage),
    index("classes_is_active_idx").on(t.is_active),
    unique("classes_name_school_year_unique").on(t.name, t.school_year),
  ],
);

/**
 * 儿童与班级的归属关系：只新增历史，不回改历史。
 * end_date 为空表示当前在班；同一儿童最多一条 end_date 为空的记录。
 */
export const childClassEnrollments = pgTable(
  "child_class_enrollments",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    child_id: varchar("child_id", { length: 36 })
      .notNull()
      .references(() => children.id, { onDelete: "cascade" }),
    class_id: varchar("class_id", { length: 36 })
      .notNull()
      .references(() => classes.id, { onDelete: "restrict" }),
    start_date: date("start_date").notNull(),
    end_date: date("end_date"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("enrollments_child_id_idx").on(t.child_id),
    index("enrollments_class_id_idx").on(t.class_id),
    uniqueIndex("enrollments_current_child_idx").on(t.child_id).where(sql`end_date IS NULL`),
  ],
);

/**
 * 观察记录
 * status 生命周期：draft(原文已保存) -> needs_input(等待必要补充) -> ai_organized(AI 已整理待确认) -> confirmed(教师已确认)
 * raw_text 为教师原文，确认流程不修改原文；AI 草稿与教师确认稿分列保存，便于追溯。
 */
export const observations = pgTable(
  "observations",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    child_id: varchar("child_id", { length: 36 })
      .notNull()
      .references(() => children.id, { onDelete: "cascade" }),
    /** 发生时班级快照：儿童转班后旧观察仍保留原班级语境 */
    class_id: varchar("class_id", { length: 36 }).references(() => classes.id, {
      onDelete: "restrict",
    }),
    observed_at: date("observed_at").notNull(),
    context: varchar("context", { length: 200 }),
    raw_text: text("raw_text").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    agent_context: jsonb("agent_context"),
    ai_draft: jsonb("ai_draft"),
    ai_model: varchar("ai_model", { length: 80 }),
    ai_organized_at: timestamp("ai_organized_at", { withTimezone: true }),
    confirmed_content: jsonb("confirmed_content"),
    confirmed_at: timestamp("confirmed_at", { withTimezone: true }),
    /** 观察发生时班级快照（ObservationClassContextSnapshot）；旧记录为 NULL=历史未知，禁止用 classes 动态回填 */
    class_context_snapshot: jsonb("class_context_snapshot"),
    /** 指南证据容器（ObservationGuideEvidence，G5 读写）；NULL=正常未关联，损坏值需显式识别 */
    guide_evidence: jsonb("guide_evidence"),
    is_demo: boolean("is_demo").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => [
    index("observations_child_id_idx").on(t.child_id),
    index("observations_class_id_idx").on(t.class_id),
    index("observations_status_idx").on(t.status),
    index("observations_created_at_idx").on(t.created_at),
    index("observations_child_observed_idx").on(t.child_id, t.observed_at),
  ],
);

/**
 * 账号（AUTH1）：role ∈ admin/teacher；status ∈ active/disabled；停用不做物理删除。
 * username 存规范化结果；password_hash 使用固定 scrypt 格式。
 */
export const appAccounts = pgTable(
  "app_accounts",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    username: varchar("username", { length: 64 }).notNull(),
    display_name: varchar("display_name", { length: 50 }).notNull(),
    password_hash: text("password_hash").notNull(),
    role: varchar("role", { length: 10 }).notNull(),
    status: varchar("status", { length: 10 }).notNull().default("active"),
    password_changed_at: timestamp("password_changed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    disabled_at: timestamp("disabled_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("app_accounts_username_unique").on(t.username),
    index("app_accounts_role_idx").on(t.role),
    index("app_accounts_status_idx").on(t.status),
    check("app_accounts_role_check", sql`${t.role} IN ('admin', 'teacher')`),
    check("app_accounts_status_check", sql`${t.status} IN ('active', 'disabled')`),
  ],
);

/**
 * 会话（AUTH1）：数据库只存令牌 SHA-256 哈希；固定绝对期限；撤销只写 revoked 字段，
 * 不做物理删除。GET / 获取 CSRF 一律不续期、不写库。
 */
export const appSessions = pgTable(
  "app_sessions",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    account_id: varchar("account_id", { length: 36 })
      .notNull()
      .references(() => appAccounts.id, { onDelete: "cascade" }),
    token_hash: varchar("token_hash", { length: 64 }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    revoked_reason: varchar("revoked_reason", { length: 30 }),
  },
  (t) => [
    uniqueIndex("app_sessions_token_hash_unique").on(t.token_hash),
    index("app_sessions_account_id_idx").on(t.account_id),
    index("app_sessions_expires_at_idx").on(t.expires_at),
  ],
);

/**
 * 教师任教关系（AUTH1）：与 child_class_enrollments 不同关系，撤销只写 removed_at，
 * 不删除历史、不改变幼儿归属或观察发生时快照。
 * 同一 (account_id, class_id) 至多一条 removed_at IS NULL 的当前关系。
 */
export const teacherClassAssignments = pgTable(
  "teacher_class_assignments",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    account_id: varchar("account_id", { length: 36 })
      .notNull()
      .references(() => appAccounts.id, { onDelete: "cascade" }),
    class_id: varchar("class_id", { length: 36 })
      .notNull()
      .references(() => classes.id, { onDelete: "restrict" }),
    assigned_at: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
    assigned_by_account_id: varchar("assigned_by_account_id", { length: 36 }).references(
      () => appAccounts.id,
      { onDelete: "set null" },
    ),
    removed_at: timestamp("removed_at", { withTimezone: true }),
    removed_by_account_id: varchar("removed_by_account_id", { length: 36 }).references(
      () => appAccounts.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    uniqueIndex("teacher_class_assignments_current_unique")
      .on(t.account_id, t.class_id)
      .where(sql`removed_at IS NULL`),
    index("teacher_class_assignments_account_idx").on(t.account_id),
    index("teacher_class_assignments_class_idx").on(t.class_id),
  ],
);

/* ============================ 芽芽 v1 私有存储（DATA1） ============================
 * 权威 DDL 为 scripts/upgrade-yaya-v1.sql；此处保持形状一致，不改变任何既有表。
 * 会话/消息按账号私有；(conversation_id, owner_account_id) 复合外键防止消息 owner
 * 与会话 owner 脱钩；proposal/batch/operation 身份在 prepare 预分配。
 */

export const yayaConversations = pgTable(
  "yaya_conversations",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    account_id: varchar("account_id", { length: 36 })
      .notNull()
      .references(() => appAccounts.id, { onDelete: "cascade" }),
    title: text("title"),
    title_source_fragments: jsonb("title_source_fragments").notNull().default(sql`'[]'::jsonb`),
    revision: integer("revision").notNull().default(1),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("yaya_conversations_owner_idx")
      .on(t.account_id, t.updated_at.desc())
      .where(sql`deleted_at IS NULL`),
    uniqueIndex("yaya_conversations_owner_id_unique").on(t.id, t.account_id),
    check("yaya_conversations_revision_check", sql`${t.revision} >= 1`),
    check("yaya_conversations_title_refs_check", sql`jsonb_typeof(${t.title_source_fragments}) = 'array'`),
  ],
);

export const yayaMessages = pgTable(
  "yaya_messages",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    conversation_id: varchar("conversation_id", { length: 36 }).notNull(),
    owner_account_id: varchar("owner_account_id", { length: 36 })
      .notNull()
      .references(() => appAccounts.id, { onDelete: "cascade" }),
    client_message_id: varchar("client_message_id", { length: 128 }),
    client_digest: varchar("client_digest", { length: 64 }),
    role: varchar("role", { length: 16 }).notNull(),
    message_kind: varchar("message_kind", { length: 20 }).notNull(),
    fragments: jsonb("fragments").notNull().default(sql`'[]'::jsonb`),
    attachment_ids: jsonb("attachment_ids").notNull().default(sql`'[]'::jsonb`),
    execution_state: varchar("execution_state", { length: 24 }).notNull().default("none"),
    revision: integer("revision").notNull().default(1),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    /** run 终态绑定（CHAT-BIND1）：旧消息 / user 消息为 NULL（读为 unknown） */
    run_id: varchar("run_id", { length: 64 }),
    binding_state: varchar("binding_state", { length: 16 }),
    /** 原身份恢复标记（yaya-recovery-v1），无标记为 NULL */
    recovery_mark: jsonb("recovery_mark"),
  },
  (t) => [
    uniqueIndex("yaya_messages_client_id_unique")
      .on(t.conversation_id, t.client_message_id)
      .where(sql`client_message_id IS NOT NULL`),
    index("yaya_messages_conversation_idx")
      .on(t.conversation_id, t.created_at, t.id)
      .where(sql`deleted_at IS NULL`),
    index("yaya_messages_owner_idx").on(t.owner_account_id),
    check("yaya_messages_role_check", sql`${t.role} IN ('user', 'assistant', 'tool')`),
    check(
      "yaya_messages_kind_check",
      sql`${t.message_kind} IN ('text', 'image', 'tool_result', 'receipt', 'mixed')`,
    ),
    check(
      "yaya_messages_execution_check",
      sql`${t.execution_state} IN ('none', 'pending_approval', 'executed', 'unknown')`,
    ),
    check(
      "yaya_messages_binding_state_check",
      sql`${t.binding_state} IS NULL OR ${t.binding_state} IN ('bound', 'unknown')`,
    ),
  ],
);

export const yayaProposals = pgTable(
  "yaya_proposals",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    batch_id: varchar("batch_id", { length: 36 }).notNull(),
    conversation_id: varchar("conversation_id", { length: 36 }).notNull(),
    owner_account_id: varchar("owner_account_id", { length: 36 })
      .notNull()
      .references(() => appAccounts.id, { onDelete: "cascade" }),
    proposal_origin: varchar("proposal_origin", { length: 24 }).notNull(),
    auth: jsonb("auth").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("open"),
    prepared_at: timestamp("prepared_at", { withTimezone: true }).defaultNow().notNull(),
    closed_at: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    index("yaya_proposals_owner_idx").on(t.owner_account_id, t.prepared_at.desc()),
    index("yaya_proposals_conversation_idx").on(t.conversation_id, t.prepared_at.desc()),
    uniqueIndex("yaya_proposals_batch_unique").on(t.batch_id),
    check(
      "yaya_proposals_origin_check",
      sql`${t.proposal_origin} IN ('teacher_card', 'model_suggestion')`,
    ),
    check("yaya_proposals_status_check", sql`${t.status} IN ('open', 'cancelled', 'closed')`),
  ],
);

export const yayaProposalItems = pgTable(
  "yaya_proposal_items",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    proposal_id: varchar("proposal_id", { length: 36 })
      .notNull()
      .references(() => yayaProposals.id, { onDelete: "cascade" }),
    item_key: varchar("item_key", { length: 128 }).notNull(),
    operation_id: varchar("operation_id", { length: 36 }).notNull(),
    target_id: varchar("target_id", { length: 64 }).notNull(),
    action: varchar("action", { length: 40 }).notNull(),
    resource: varchar("resource", { length: 20 }).notNull(),
    resource_ref: jsonb("resource_ref").notNull(),
    payload: jsonb("payload").notNull(),
    content_digest: varchar("content_digest", { length: 64 }).notNull(),
    attachment_associations: jsonb("attachment_associations").notNull().default(sql`'[]'::jsonb`),
    business_revision: varchar("business_revision", { length: 128 }),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("yaya_proposal_items_key_unique").on(t.proposal_id, t.item_key),
    unique("yaya_proposal_items_operation_unique").on(t.operation_id),
    index("yaya_proposal_items_proposal_idx").on(t.proposal_id),
    check(
      "yaya_proposal_items_status_check",
      sql`${t.status} IN ('pending', 'approved', 'rejected', 'superseded')`,
    ),
  ],
);

export const yayaApprovals = pgTable(
  "yaya_approvals",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    proposal_id: varchar("proposal_id", { length: 36 })
      .notNull()
      .references(() => yayaProposals.id, { onDelete: "restrict" }),
    batch_id: varchar("batch_id", { length: 36 }).notNull(),
    actor_account_id: varchar("actor_account_id", { length: 36 })
      .notNull()
      .references(() => appAccounts.id, { onDelete: "cascade" }),
    session_id: varchar("session_id", { length: 36 }).notNull(),
    approval_source: varchar("approval_source", { length: 24 }).notNull(),
    items: jsonb("items").notNull(),
    approved_at: timestamp("approved_at", { withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    cancelled_at: timestamp("cancelled_at", { withTimezone: true }),
    consumed_at: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    index("yaya_approvals_proposal_idx").on(t.proposal_id),
    index("yaya_approvals_actor_idx").on(t.actor_account_id, t.approved_at.desc()),
    uniqueIndex("yaya_approvals_pending_unique")
      .on(t.proposal_id)
      .where(sql`cancelled_at IS NULL AND consumed_at IS NULL`),
    check(
      "yaya_approvals_source_check",
      sql`${t.approval_source} IN ('authenticated_entry', 'request_body_claim', 'model_output')`,
    ),
  ],
);

export const yayaOperations = pgTable(
  "yaya_operations",
  {
    operation_id: varchar("operation_id", { length: 36 }).primaryKey(),
    proposal_id: varchar("proposal_id", { length: 36 })
      .notNull()
      .references(() => yayaProposals.id, { onDelete: "restrict" }),
    item_key: varchar("item_key", { length: 128 }).notNull(),
    batch_id: varchar("batch_id", { length: 36 }).notNull(),
    target_id: varchar("target_id", { length: 64 }).notNull(),
    actor_account_id: varchar("actor_account_id", { length: 36 })
      .notNull()
      .references(() => appAccounts.id, { onDelete: "cascade" }),
    approval_id: varchar("approval_id", { length: 36 }).references(() => yayaApprovals.id, {
      onDelete: "restrict",
    }),
    status: varchar("status", { length: 32 }),
    effect: varchar("effect", { length: 16 }),
    business_object_id: varchar("business_object_id", { length: 64 }),
    business_revision: varchar("business_revision", { length: 128 }),
    started_at: timestamp("started_at", { withTimezone: true }),
    recorded_at: timestamp("recorded_at", { withTimezone: true }),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
    superseded_by: varchar("superseded_by", { length: 36 }),
    superseded_at: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => [
    unique("yaya_operations_unique").on(t.proposal_id, t.item_key),
    index("yaya_operations_batch_idx").on(t.actor_account_id, t.batch_id),
    index("yaya_operations_proposal_idx").on(t.proposal_id),
    check(
      "yaya_operations_status_check",
      sql`${t.status} IS NULL OR ${t.status} IN (
        'in_progress', 'saved', 'saved_detail_unavailable', 'unchanged',
        'failed', 'conflict', 'needs_verification'
      )`,
    ),
    check(
      "yaya_operations_effect_check",
      sql`${t.effect} IS NULL OR ${t.effect} IN ('none', 'committed', 'unknown')`,
    ),
  ],
);

export const yayaAttachments = pgTable(
  "yaya_attachments",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    uploader_account_id: varchar("uploader_account_id", { length: 36 })
      .notNull()
      .references(() => appAccounts.id, { onDelete: "cascade" }),
    conversation_id: varchar("conversation_id", { length: 36 }).references(
      () => yayaConversations.id,
      { onDelete: "set null" },
    ),
    object_key: text("object_key").notNull(),
    thumbnail_key: text("thumbnail_key"),
    model_key: text("model_key"),
    media_type: varchar("media_type", { length: 64 }).notNull(),
    byte_size: bigint("byte_size", { mode: "number" }).notNull(),
    checksum_sha256: varchar("checksum_sha256", { length: 128 }).notNull(),
    thumbnail_checksum: varchar("thumbnail_checksum", { length: 128 }),
    model_checksum: varchar("model_checksum", { length: 128 }),
    /** 原始上传字节 SHA-256（与处理后对象 checksum 区分）；缺失/不可核验不得推测或伪造 */
    source_checksum: varchar("source_checksum", { length: 128 }),
    width: integer("width"),
    height: integer("height"),
    client_upload_id: varchar("client_upload_id", { length: 128 }),
    source_kind: varchar("source_kind", { length: 24 }).notNull(),
    derived_from: varchar("derived_from", { length: 64 }),
    metadata: jsonb("metadata"),
    status: varchar("status", { length: 16 }).notNull().default("ready"),
    revision: integer("revision").notNull().default(1),
    delete_result: varchar("delete_result", { length: 16 }),
    deletion_lease_id: varchar("deletion_lease_id", { length: 64 }),
    deleting_started_at: timestamp("deleting_started_at", { withTimezone: true }),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("yaya_attachments_object_key_unique").on(t.object_key),
    uniqueIndex("yaya_attachments_client_upload_unique")
      .on(t.uploader_account_id, t.client_upload_id)
      .where(sql`client_upload_id IS NOT NULL`),
    index("yaya_attachments_uploader_idx").on(t.uploader_account_id, t.created_at.desc()),
    check(
      "yaya_attachments_status_check",
      sql`${t.status} IN ('pending', 'ready', 'deleting', 'deleted')`,
    ),
    check(
      "yaya_attachments_delete_result_check",
      sql`${t.delete_result} IS NULL OR ${t.delete_result} IN ('deleted', 'unknown')`,
    ),
    check("yaya_attachments_size_check", sql`${t.byte_size} >= 0`),
    check(
      "yaya_attachments_dimensions_check",
      sql`(${t.width} IS NULL OR ${t.width} >= 0) AND (${t.height} IS NULL OR ${t.height} >= 0)`,
    ),
  ],
);

export const yayaAttachmentRefs = pgTable(
  "yaya_attachment_refs",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    attachment_id: varchar("attachment_id", { length: 36 })
      .notNull()
      .references(() => yayaAttachments.id, { onDelete: "restrict" }),
    record_kind: varchar("record_kind", { length: 16 }).notNull(),
    record_id: varchar("record_id", { length: 36 }).notNull(),
    linked_at: timestamp("linked_at", { withTimezone: true }).defaultNow().notNull(),
    linked_by_account_id: varchar("linked_by_account_id", { length: 36 }).references(
      () => appAccounts.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    unique("yaya_attachment_refs_unique").on(t.attachment_id, t.record_kind, t.record_id),
    index("yaya_attachment_refs_attachment_idx").on(t.attachment_id),
    index("yaya_attachment_refs_record_idx").on(t.record_kind, t.record_id),
    check(
      "yaya_attachment_refs_kind_check",
      sql`${t.record_kind} IN ('message', 'proposal', 'observation')`,
    ),
  ],
);

export const yayaObservationAttachmentMeta = pgTable(
  "yaya_observation_attachment_meta",
  {
    observation_id: varchar("observation_id", { length: 36 })
      .primaryKey()
      .references(() => observations.id, { onDelete: "restrict" }),
    attachment_revision: integer("attachment_revision").notNull().default(0),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check("yaya_observation_attachment_meta_revision_check", sql`${t.attachment_revision} >= 0`),
  ],
);

export const yayaAttachmentAppends = pgTable(
  "yaya_attachment_appends",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    audit_id: varchar("audit_id", { length: 36 }),
    action: varchar("action", { length: 40 }),
    attachment_id: varchar("attachment_id", { length: 36 }).references(() => yayaAttachments.id, {
      onDelete: "restrict",
    }),
    attachment_ids: jsonb("attachment_ids"),
    observation_id: varchar("observation_id", { length: 36 })
      .notNull()
      .references(() => observations.id, { onDelete: "restrict" }),
    attachment_revision: integer("attachment_revision"),
    appended_by_account_id: varchar("appended_by_account_id", { length: 36 }).references(
      () => appAccounts.id,
      { onDelete: "set null" },
    ),
    approval_id: varchar("approval_id", { length: 36 }).references(() => yayaApprovals.id, {
      onDelete: "set null",
    }),
    source_confirmed_at: timestamp("source_confirmed_at", { withTimezone: true }),
    request_id: varchar("request_id", { length: 128 }),
    note: text("note"),
    appended_at: timestamp("appended_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("yaya_attachment_appends_unique").on(
      t.observation_id,
      t.attachment_id,
      t.attachment_revision,
    ),
    index("yaya_attachment_appends_observation_idx").on(t.observation_id, t.appended_at),
    index("yaya_attachment_appends_audit_idx")
      .on(t.audit_id)
      .where(sql`audit_id IS NOT NULL`),
    check(
      "yaya_attachment_appends_revision_check",
      sql`${t.attachment_revision} IS NULL OR ${t.attachment_revision} >= 1`,
    ),
    check(
      "yaya_attachment_appends_action_check",
      sql`${t.action} IS NULL OR ${t.action} IN ('attach_observation_images', 'create_observation_attachments')`,
    ),
  ],
);

/* ============================ 芽芽运行服务（AGENT-APP1） ============================
 * 权威 DDL 为 scripts/upgrade-yaya-runs-v1.sql；owner + conversation +
 * client_request_id 绑定原请求；dependencies 按 run 累积，只增不覆盖。
 */

export const yayaRuns = pgTable(
  "yaya_runs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    owner_account_id: varchar("owner_account_id", { length: 36 })
      .notNull()
      .references(() => appAccounts.id, { onDelete: "cascade" }),
    conversation_id: varchar("conversation_id", { length: 36 }).notNull(),
    client_request_id: varchar("client_request_id", { length: 128 }).notNull(),
    request_digest: varchar("request_digest", { length: 64 }).notNull(),
    user_text: text("user_text").notNull(),
    attachment_ids: jsonb("attachment_ids").notNull().default(sql`'[]'::jsonb`),
    expected_conversation_revision: integer("expected_conversation_revision").notNull(),
    session_id: varchar("session_id", { length: 36 }).notNull(),
    owner_instance: varchar("owner_instance", { length: 64 }).notNull(),
    state: varchar("state", { length: 16 }).notNull().default("active"),
    outcome: jsonb("outcome"),
    dependencies: jsonb("dependencies").notNull().default(sql`'[]'::jsonb`),
    cancel_requested_at: timestamp("cancel_requested_at", { withTimezone: true }),
    replaced_by: varchar("replaced_by", { length: 36 }),
    deadline_at: timestamp("deadline_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    terminal_at: timestamp("terminal_at", { withTimezone: true }),
  },
  (t) => [
    index("yaya_runs_owner_conversation_idx").on(t.owner_account_id, t.conversation_id, t.created_at.desc()),
    index("yaya_runs_active_instance_idx")
      .on(t.owner_instance)
      .where(sql`state = 'active'`),
    check("yaya_runs_state_check", sql`${t.state} IN ('active', 'terminal', 'interrupted')`),
    check("yaya_runs_revision_check", sql`${t.expected_conversation_revision} >= 1`),
    check("yaya_runs_digest_check", sql`${t.request_digest} ~ '^[0-9a-f]{64}$'`),
    check("yaya_runs_attachments_check", sql`jsonb_typeof(${t.attachment_ids}) = 'array'`),
    check("yaya_runs_dependencies_check", sql`jsonb_typeof(${t.dependencies}) = 'array'`),
  ],
);
