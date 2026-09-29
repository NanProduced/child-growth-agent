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
    class_name: varchar("class_name", { length: 50 }).notNull().default("向日葵班"),
    avatar_emoji: varchar("avatar_emoji", { length: 16 }),
    note: text("note"),
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
 * 观察记录
 * status 生命周期：draft(原文已保存) -> ai_organized(AI 已整理待确认) -> confirmed(教师已确认)
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
    observed_at: date("observed_at").notNull(),
    context: varchar("context", { length: 200 }),
    raw_text: text("raw_text").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    ai_draft: jsonb("ai_draft"),
    ai_model: varchar("ai_model", { length: 80 }),
    ai_organized_at: timestamp("ai_organized_at", { withTimezone: true }),
    confirmed_content: jsonb("confirmed_content"),
    confirmed_at: timestamp("confirmed_at", { withTimezone: true }),
    is_demo: boolean("is_demo").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => [
    index("observations_child_id_idx").on(t.child_id),
    index("observations_status_idx").on(t.status),
    index("observations_created_at_idx").on(t.created_at),
    index("observations_child_observed_idx").on(t.child_id, t.observed_at),
  ],
);
