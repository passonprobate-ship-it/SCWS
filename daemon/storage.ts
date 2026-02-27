import { eq, desc, isNotNull, sql as dsql } from "drizzle-orm";
import { db } from "./db.js";
import {
  projects, claudeRuns, activityLog, daemonConfig,
  type Project, type InsertProject,
  type ClaudeRun, type InsertClaudeRun,
  type Activity, type InsertActivity,
  type DaemonConfig,
} from "../shared/schema.js";

export interface IStorage {
  // Projects
  getProjects(): Promise<Project[]>;
  getProject(name: string): Promise<Project | undefined>;
  getProjectById(id: string): Promise<Project | undefined>;
  createProject(data: InsertProject): Promise<Project>;
  updateProject(name: string, data: Partial<InsertProject>): Promise<Project | undefined>;
  deleteProject(name: string): Promise<void>;
  getNextPort(): Promise<number>;

  // Claude Runs
  createClaudeRun(data: InsertClaudeRun): Promise<ClaudeRun>;
  getClaudeRun(id: string): Promise<ClaudeRun | undefined>;
  listClaudeRuns(projectId: string, limit?: number): Promise<ClaudeRun[]>;
  listAllClaudeRuns(limit?: number, offset?: number): Promise<ClaudeRun[]>;
  listClaudeSessions(): Promise<{ sessionId: string; projectName: string | null; turns: number; lastAt: Date }[]>;
  getRunsBySession(sessionId: string): Promise<ClaudeRun[]>;
  updateClaudeRun(id: string, data: Partial<InsertClaudeRun>): Promise<ClaudeRun | undefined>;

  // Activity
  logActivity(data: InsertActivity): Promise<Activity>;
  getActivity(limit?: number): Promise<Activity[]>;
  getProjectActivity(projectId: string, limit?: number): Promise<Activity[]>;

  // Config
  getConfig(key: string): Promise<string | undefined>;
  setConfig(key: string, value: string): Promise<void>;
  getAllConfig(): Promise<DaemonConfig[]>;
}

export class DatabaseStorage implements IStorage {
  // ── Projects ─────────────────────────────────────────────────

  async getProjects(): Promise<Project[]> {
    return db.select().from(projects).orderBy(desc(projects.createdAt));
  }

  async getProject(name: string): Promise<Project | undefined> {
    const [row] = await db.select().from(projects).where(eq(projects.name, name));
    return row;
  }

  async getProjectById(id: string): Promise<Project | undefined> {
    const [row] = await db.select().from(projects).where(eq(projects.id, id));
    return row;
  }

  async createProject(data: InsertProject): Promise<Project> {
    const [row] = await db.insert(projects).values(data).returning();
    return row;
  }

  async updateProject(name: string, data: Partial<InsertProject>): Promise<Project | undefined> {
    const [row] = await db
      .update(projects)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(projects.name, name))
      .returning();
    return row;
  }

  async deleteProject(name: string): Promise<void> {
    await db.delete(projects).where(eq(projects.name, name));
  }

  async getNextPort(): Promise<number> {
    const result = await db
      .select({ maxPort: dsql<number>`COALESCE(MAX(${projects.port}), 5000)` })
      .from(projects);
    return result[0].maxPort + 1;
  }

  // ── Claude Runs ──────────────────────────────────────────────

  async createClaudeRun(data: InsertClaudeRun): Promise<ClaudeRun> {
    const [row] = await db.insert(claudeRuns).values(data).returning();
    return row;
  }

  async getClaudeRun(id: string): Promise<ClaudeRun | undefined> {
    const [row] = await db.select().from(claudeRuns).where(eq(claudeRuns.id, id));
    return row;
  }

  async listClaudeRuns(projectId: string, limit = 20): Promise<ClaudeRun[]> {
    return db
      .select()
      .from(claudeRuns)
      .where(eq(claudeRuns.projectId, projectId))
      .orderBy(desc(claudeRuns.createdAt))
      .limit(limit);
  }

  async listAllClaudeRuns(limit = 50, offset = 0): Promise<ClaudeRun[]> {
    return db
      .select()
      .from(claudeRuns)
      .orderBy(desc(claudeRuns.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async listClaudeSessions(): Promise<{ sessionId: string; projectName: string | null; turns: number; lastAt: Date }[]> {
    const rows = await db
      .select({
        sessionId: claudeRuns.sessionId,
        projectName: claudeRuns.projectName,
        turns: dsql<number>`COUNT(*)::int`,
        lastAt: dsql<Date>`MAX(${claudeRuns.createdAt})`,
      })
      .from(claudeRuns)
      .where(isNotNull(claudeRuns.sessionId))
      .groupBy(claudeRuns.sessionId, claudeRuns.projectName)
      .orderBy(dsql`MAX(${claudeRuns.createdAt}) DESC`)
      .limit(50);
    return rows as { sessionId: string; projectName: string | null; turns: number; lastAt: Date }[];
  }

  async getRunsBySession(sessionId: string): Promise<ClaudeRun[]> {
    return db
      .select()
      .from(claudeRuns)
      .where(eq(claudeRuns.sessionId, sessionId))
      .orderBy(claudeRuns.createdAt);
  }

  async updateClaudeRun(id: string, data: Partial<InsertClaudeRun>): Promise<ClaudeRun | undefined> {
    const [row] = await db.update(claudeRuns).set(data).where(eq(claudeRuns.id, id)).returning();
    return row;
  }

  // ── Activity ─────────────────────────────────────────────────

  async logActivity(data: InsertActivity): Promise<Activity> {
    const [row] = await db.insert(activityLog).values(data).returning();
    return row;
  }

  async getActivity(limit = 50): Promise<Activity[]> {
    return db.select().from(activityLog).orderBy(desc(activityLog.createdAt)).limit(limit);
  }

  async getProjectActivity(projectId: string, limit = 20): Promise<Activity[]> {
    return db
      .select()
      .from(activityLog)
      .where(eq(activityLog.projectId, projectId))
      .orderBy(desc(activityLog.createdAt))
      .limit(limit);
  }

  // ── Config ───────────────────────────────────────────────────

  async getConfig(key: string): Promise<string | undefined> {
    const [row] = await db.select().from(daemonConfig).where(eq(daemonConfig.key, key));
    return row?.value;
  }

  async setConfig(key: string, value: string): Promise<void> {
    await db
      .insert(daemonConfig)
      .values({ key, value })
      .onConflictDoUpdate({ target: daemonConfig.key, set: { value, updatedAt: new Date() } });
  }

  async getAllConfig(): Promise<DaemonConfig[]> {
    return db.select().from(daemonConfig);
  }
}

export const storage = new DatabaseStorage();
