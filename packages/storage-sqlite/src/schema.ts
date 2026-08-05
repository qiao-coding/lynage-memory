// ---------------------------------------------------------------------------
// Drizzle ORM schema for Lynage Memory
// Single source of truth — all data lives in SQLite tables.
// ---------------------------------------------------------------------------

import { sqliteTable, text, integer, blob } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// messages — immutable append-only conversation records
// ---------------------------------------------------------------------------

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  userId: text("user_id"),
  role: text("role", { enum: ["user", "assistant", "tool", "system"] }).notNull(),
  content: text("content").notNull().default(""),
  toolCallId: text("tool_call_id"),
  toolName: text("tool_name"),
  tokenCount: integer("token_count"),
  createdAt: integer("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// message_embeddings — precomputed per-message vectors (message-level semantic
// index). Written at archive time; read at search time so retrieval embeds the
// query once and scores messages individually instead of pooled chunk vectors.
// ---------------------------------------------------------------------------

export const messageEmbeddings = sqliteTable("message_embeddings", {
  messageId: text("message_id").primaryKey(),
  sessionId: text("session_id").notNull(),
  vector: blob("vector", { mode: "buffer" }).notNull(),
  dim: integer("dim").notNull(),
});

// ---------------------------------------------------------------------------
// context_chunks — archived conversation segments
// ---------------------------------------------------------------------------

export const contextChunks = sqliteTable("context_chunks", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  timeRangeStart: integer("time_range_start").notNull(),
  timeRangeEnd: integer("time_range_end").notNull(),
  summary: text("summary").notNull().default(""),
  progress: text("progress").notNull().default(""),
  keywords: text("keywords", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  conclusions: text("conclusions", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  goals: text("goals", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  sourceFromId: text("source_from_id").notNull(),
  sourceToId: text("source_to_id").notNull(),
  directoryId: text("directory_id"),
  createdAt: integer("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// directories — generational directory tree nodes
// ---------------------------------------------------------------------------

export const directories = sqliteTable("directories", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  parentId: text("parent_id"),
  generation: integer("generation").notNull().default(0),
  timeRangeStart: integer("time_range_start").notNull(),
  timeRangeEnd: integer("time_range_end").notNull(),
  overallContent: text("overall_content").notNull().default(""),
  progress: text("progress").notNull().default(""),
  mainConclusions: text("main_conclusions", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  importantChanges: text("important_changes", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  goals: text("goals", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  createdAt: integer("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// directory_children — many-to-many links between directories and their contents
// ---------------------------------------------------------------------------

export const directoryChildren = sqliteTable("directory_children", {
  id: text("id").primaryKey(),
  directoryId: text("directory_id").notNull(),
  childType: text("child_type", { enum: ["chunk", "directory"] }).notNull(),
  childId: text("child_id").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

// ---------------------------------------------------------------------------
// working_memory — current task/progress state per session
// ---------------------------------------------------------------------------

export const workingMemory = sqliteTable("working_memory", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().unique(),
  currentTask: text("current_task"),
  confirmed: text("confirmed", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  progress: text("progress", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  unresolved: text("unresolved", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  recentChanges: text("recent_changes", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  updatedAt: integer("updated_at").notNull(),
});

export const userMemory = sqliteTable("user_memory", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  preferences: text("preferences", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  longTermGoals: text("long_term_goals", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  constraints: text("constraints", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  background: text("background"),
  updatedAt: integer("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// search_tasks — persistent fuzzy search state
// ---------------------------------------------------------------------------

export const searchTasks = sqliteTable("search_tasks", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  query: text("query").notNull(),
  understanding: text("understanding"),
  strategy: text("strategy"),
  checkedDirectories: text("checked_directories", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  candidates: text("candidates", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  nextBatch: text("next_batch"),
  status: text("status", { enum: ["pending", "in_progress", "completed", "not_found"] }).notNull().default("pending"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// search_messages — FTS5 virtual table (created via raw SQL, not Drizzle)
// ---------------------------------------------------------------------------
// CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
//   content, content_rowid='rowid'
// );
