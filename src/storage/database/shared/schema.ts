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
  unique,
  uniqueIndex,
  serial,
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
