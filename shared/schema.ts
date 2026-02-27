import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── Projects ─────────────────────────────────────────────────────

export const projects = pgTable("projects", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description").notNull().default(""),
  port: integer("port").notNull().unique(),
  status: text("status").notNull().default("stopped"),
  framework: text("framework").notNull().default("express"),
  gitRepo: text("git_repo"),
  gitBranch: text("git_branch").notNull().default("main"),
  dbName: text("db_name"),
  entryFile: text("entry_file").notNull().default("dist/index.js"),
  buildCommand: text("build_command"),
  startCommand: text("start_command"),
  envVars: text("env_vars").notNull().default("{}"),
  deployTargets: text("deploy_targets").notNull().default("[]"),
  lastBuildAt: timestamp("last_build_at"),
  lastDeployAt: timestamp("last_deploy_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertProjectSchema = createInsertSchema(projects).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Project = typeof projects.$inferSelect;
export type InsertProject = z.infer<typeof insertProjectSchema>;

// ── Claude Runs ──────────────────────────────────────────────────

export const claudeRuns = pgTable("claude_runs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: varchar("project_id").notNull(),
  projectName: text("project_name"),
  prompt: text("prompt").notNull(),
  output: text("output"),
  status: text("status").notNull().default("running"),
  mode: text("mode").notNull().default("build"),
  sessionId: text("session_id"),
  turnNumber: integer("turn_number").notNull().default(1),
  parentRunId: varchar("parent_run_id"),
  duration: integer("duration"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertClaudeRunSchema = createInsertSchema(claudeRuns).omit({
  id: true,
  createdAt: true,
});
export type ClaudeRun = typeof claudeRuns.$inferSelect;
export type InsertClaudeRun = z.infer<typeof insertClaudeRunSchema>;

// ── Activity Log ─────────────────────────────────────────────────

export const activityLog = pgTable("activity_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: varchar("project_id"),
  action: text("action").notNull(),
  details: text("details").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertActivitySchema = createInsertSchema(activityLog).omit({
  id: true,
  createdAt: true,
});
export type Activity = typeof activityLog.$inferSelect;
export type InsertActivity = z.infer<typeof insertActivitySchema>;

// ── Daemon Config ────────────────────────────────────────────────

export const daemonConfig = pgTable("daemon_config", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type DaemonConfig = typeof daemonConfig.$inferSelect;
