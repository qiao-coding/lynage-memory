// ---------------------------------------------------------------------------
// SqliteStore — LynageStore implementation backed by SQLite + Drizzle ORM
// ---------------------------------------------------------------------------

import { eq, and, gte, lte, desc, asc, count } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type Database from "better-sqlite3";
import type {
  LynageStore,
  CreateChunkInput,
  CreateDirectoryInput,
  WorkingMemoryInput,
  UserMemoryInput,
  SearchTaskInput,
} from "@lynage/core";
import type {
  Message,
  ContextChunk,
  DirectoryNode,
  DirectoryChild,
  WorkingMemory,
  UserMemory,
  SearchTask,
  Scope,
  MessageInput,
} from "@lynage/core";
import { estimateMessagesTokenCount, estimateTokenCount } from "@lynage/core";
import * as schema from "./schema.js";

export class SqliteStore implements LynageStore {
  private db: BetterSQLite3Database<typeof schema>;
  private raw: Database.Database;

  constructor(
    db: BetterSQLite3Database<typeof schema>,
    raw: Database.Database,
  ) {
    this.db = db;
    this.raw = raw;
  }

  // -----------------------------------------------------------------------
  // Messages
  // -----------------------------------------------------------------------

  async appendMessage(input: MessageInput): Promise<Message> {
    const id = randomUUID();
    const now = Date.now();

    await this.db.insert(schema.messages).values({
      id,
      sessionId: input.sessionId,
      userId: input.userId ?? null,
      role: input.role,
      content: input.content,
      toolCallId: input.toolCallId ?? null,
      toolName: input.toolName ?? null,
      tokenCount: input.tokenCount ?? estimateTokenCount(input.content),
      createdAt: now,
    });

    return { id, ...input, createdAt: now };
  }

  async getMessage(id: string): Promise<Message | null> {
    const rows = await this.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, id))
      .limit(1);
    return rows[0] ? this.toMessage(rows[0]) : null;
  }

  async getRecent(scope: Scope): Promise<Message[]> {
    const limit = scope.limit ?? 100;
    const query = this.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.sessionId, scope.sessionId))
      .orderBy(desc(schema.messages.createdAt))
      .limit(limit);

    const rows = await query;
    // Re-sort chronologically for consumption
    return rows.reverse().map((r) => this.toMessage(r));
  }

  async getMessageRange(fromId: string, toId: string): Promise<Message[]> {
    const fromMsg = await this.getMessage(fromId);
    const toMsg = await this.getMessage(toId);
    if (!fromMsg || !toMsg) return [];

    const rows = await this.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.sessionId, fromMsg.sessionId),
          gte(schema.messages.createdAt, fromMsg.createdAt),
          lte(schema.messages.createdAt, toMsg.createdAt),
        ),
      )
      .orderBy(asc(schema.messages.createdAt));

    return rows.map((r) => this.toMessage(r));
  }

  async getMessageCount(sessionId: string): Promise<number> {
    const result = await this.db
      .select({ cnt: count() })
      .from(schema.messages)
      .where(eq(schema.messages.sessionId, sessionId));
    return result[0]?.cnt ?? 0;
  }

  async getEstimatedTokenCount(
    sessionId: string,
    sinceId?: string,
  ): Promise<number> {
    const messages = await this.getRecent({ sessionId });
    if (sinceId) {
      const idx = messages.findIndex((m) => m.id === sinceId);
      if (idx >= 0) {
        return estimateMessagesTokenCount(messages.slice(idx));
      }
    }
    return estimateMessagesTokenCount(messages);
  }

  // -----------------------------------------------------------------------
  // Context Chunks
  // -----------------------------------------------------------------------

  async createChunk(input: CreateChunkInput): Promise<ContextChunk> {
    const id = randomUUID();
    const now = Date.now();

    await this.db.insert(schema.contextChunks).values({
      id,
      sessionId: input.sessionId,
      timeRangeStart: input.timeRangeStart,
      timeRangeEnd: input.timeRangeEnd,
      summary: input.summary,
      progress: input.progress,
      keywords: input.keywords,
      sourceFromId: input.sourceFromId,
      sourceToId: input.sourceToId,
      directoryId: input.directoryId ?? null,
      createdAt: now,
    });

    return { id, ...input, createdAt: now };
  }

  async getChunk(id: string): Promise<ContextChunk | null> {
    const rows = await this.db
      .select()
      .from(schema.contextChunks)
      .where(eq(schema.contextChunks.id, id))
      .limit(1);
    return rows[0] ? this.toChunk(rows[0]) : null;
  }

  async getChunksByDirectory(directoryId: string): Promise<ContextChunk[]> {
    const rows = await this.db
      .select()
      .from(schema.contextChunks)
      .where(eq(schema.contextChunks.directoryId, directoryId))
      .orderBy(asc(schema.contextChunks.createdAt));
    return rows.map((r) => this.toChunk(r));
  }

  async listChunks(sessionId: string): Promise<ContextChunk[]> {
    const rows = await this.db
      .select()
      .from(schema.contextChunks)
      .where(eq(schema.contextChunks.sessionId, sessionId))
      .orderBy(desc(schema.contextChunks.createdAt));
    return rows.map((r) => this.toChunk(r));
  }

  // -----------------------------------------------------------------------
  // Directories
  // -----------------------------------------------------------------------

  async createDirectory(input: CreateDirectoryInput): Promise<DirectoryNode> {
    const id = randomUUID();
    const now = Date.now();

    await this.db.insert(schema.directories).values({
      id,
      sessionId: input.sessionId,
      parentId: input.parentId ?? null,
      generation: input.generation,
      timeRangeStart: input.timeRangeStart,
      timeRangeEnd: input.timeRangeEnd,
      overallContent: input.overallContent,
      progress: input.progress,
      mainConclusions: input.mainConclusions,
      importantChanges: input.importantChanges,
      createdAt: now,
    });

    return { id, ...input, createdAt: now };
  }

  async getDirectory(id: string): Promise<DirectoryNode | null> {
    const rows = await this.db
      .select()
      .from(schema.directories)
      .where(eq(schema.directories.id, id))
      .limit(1);
    return rows[0] ? this.toDirectory(rows[0]) : null;
  }

  async updateDirectory(
    id: string,
    updates: Partial<CreateDirectoryInput>,
  ): Promise<DirectoryNode> {
    const setData: Record<string, unknown> = {};
    if (updates.sessionId !== undefined) setData.sessionId = updates.sessionId;
    if (updates.parentId !== undefined) setData.parent_id = updates.parentId;
    if (updates.generation !== undefined) setData.generation = updates.generation;
    if (updates.timeRangeStart !== undefined) setData.time_range_start = updates.timeRangeStart;
    if (updates.timeRangeEnd !== undefined) setData.time_range_end = updates.timeRangeEnd;
    if (updates.overallContent !== undefined) setData.overall_content = updates.overallContent;
    if (updates.progress !== undefined) setData.progress = updates.progress;
    if (updates.mainConclusions !== undefined) setData.main_conclusions = updates.mainConclusions;
    if (updates.importantChanges !== undefined) setData.important_changes = updates.importantChanges;

    if (Object.keys(setData).length > 0) {
      await this.db
        .update(schema.directories)
        .set(setData)
        .where(eq(schema.directories.id, id));
    }

    return (await this.getDirectory(id))!;
  }

  /** Update a chunk's directory association (persisted to DB) */
  async updateChunkDirectory(chunkId: string, directoryId: string): Promise<void> {
    await this.db
      .update(schema.contextChunks)
      .set({ directoryId })
      .where(eq(schema.contextChunks.id, chunkId));
  }

  async getRootDirectories(sessionId: string): Promise<DirectoryNode[]> {
    const rows = await this.db
      .select()
      .from(schema.directories)
      .where(
        and(
          eq(schema.directories.sessionId, sessionId),
          eq(schema.directories.generation, 0),
        ),
      )
      .orderBy(asc(schema.directories.createdAt));
    return rows.map((r) => this.toDirectory(r));
  }

  async getChildDirectories(parentId: string): Promise<DirectoryNode[]> {
    const rows = await this.db
      .select()
      .from(schema.directories)
      .where(eq(schema.directories.parentId, parentId))
      .orderBy(asc(schema.directories.createdAt));
    return rows.map((r) => this.toDirectory(r));
  }

  async addChildToDirectory(child: DirectoryChild): Promise<void> {
    await this.db.insert(schema.directoryChildren).values({
      id: child.id || randomUUID(),
      directoryId: child.directoryId,
      childType: child.childType,
      childId: child.childId,
      sortOrder: child.sortOrder,
    });
  }

  async getDirectoryChildren(directoryId: string): Promise<DirectoryChild[]> {
    const rows = await this.db
      .select()
      .from(schema.directoryChildren)
      .where(eq(schema.directoryChildren.directoryId, directoryId))
      .orderBy(asc(schema.directoryChildren.sortOrder));
    return rows.map((r) => ({
      id: r.id,
      directoryId: r.directoryId,
      childType: r.childType as "chunk" | "directory",
      childId: r.childId,
      sortOrder: r.sortOrder,
    }));
  }

  // -----------------------------------------------------------------------
  // Working Memory
  // -----------------------------------------------------------------------

  async getWorkingMemory(sessionId: string): Promise<WorkingMemory | null> {
    const rows = await this.db
      .select()
      .from(schema.workingMemory)
      .where(eq(schema.workingMemory.sessionId, sessionId))
      .limit(1);
    return rows[0] ? this.toWorkingMemory(rows[0]) : null;
  }

  async upsertWorkingMemory(input: WorkingMemoryInput): Promise<WorkingMemory> {
    const existing = await this.getWorkingMemory(input.sessionId);
    const now = Date.now();

    if (existing) {
      await this.db
        .update(schema.workingMemory)
        .set({
          currentTask: input.currentTask ?? existing.currentTask,
          confirmed: input.confirmed ?? existing.confirmed,
          progress: input.progress ?? existing.progress,
          unresolved: input.unresolved ?? existing.unresolved,
          recentChanges: input.recentChanges ?? existing.recentChanges,
          updatedAt: now,
        })
        .where(eq(schema.workingMemory.sessionId, input.sessionId));
    } else {
      const id = randomUUID();
      await this.db.insert(schema.workingMemory).values({
        id,
        sessionId: input.sessionId,
        currentTask: input.currentTask ?? null,
        confirmed: input.confirmed ?? [],
        progress: input.progress ?? [],
        unresolved: input.unresolved ?? [],
        recentChanges: input.recentChanges ?? [],
        updatedAt: now,
      });
    }

    return (await this.getWorkingMemory(input.sessionId))!;
  }

  // -----------------------------------------------------------------------
  // User Memory (cross-task stable preferences)
  // -----------------------------------------------------------------------

  async getUserMemory(userId: string): Promise<UserMemory | null> {
    const rows = await this.db
      .select()
      .from(schema.userMemory)
      .where(eq(schema.userMemory.userId, userId))
      .limit(1);
    return rows[0] ? this.toUserMemory(rows[0]) : null;
  }

  async upsertUserMemory(input: UserMemoryInput): Promise<UserMemory> {
    const existing = await this.getUserMemory(input.userId);
    const now = Date.now();

    if (existing) {
      await this.db
        .update(schema.userMemory)
        .set({
          preferences: input.preferences ?? existing.preferences,
          longTermGoals: input.longTermGoals ?? existing.longTermGoals,
          constraints: input.constraints ?? existing.constraints,
          background: input.background ?? existing.background,
          updatedAt: now,
        })
        .where(eq(schema.userMemory.userId, input.userId));
    } else {
      await this.db.insert(schema.userMemory).values({
        id: randomUUID(),
        userId: input.userId,
        preferences: input.preferences ?? [],
        longTermGoals: input.longTermGoals ?? [],
        constraints: input.constraints ?? [],
        background: input.background ?? null,
        updatedAt: now,
      });
    }

    return (await this.getUserMemory(input.userId))!;
  }

  // -----------------------------------------------------------------------
  // Search Tasks
  // -----------------------------------------------------------------------

  async createSearchTask(input: SearchTaskInput): Promise<SearchTask> {
    const id = randomUUID();
    const now = Date.now();

    await this.db.insert(schema.searchTasks).values({
      id,
      sessionId: input.sessionId,
      query: input.query,
      understanding: input.understanding ?? null,
      strategy: input.strategy ?? null,
      checkedDirectories: [],
      candidates: [],
      nextBatch: null,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    return (await this.getSearchTask(id))!;
  }

  async updateSearchTask(
    id: string,
    updates: Partial<SearchTask>,
  ): Promise<SearchTask> {
    const setData: Record<string, unknown> = {};
    if (updates.understanding !== undefined) setData.understanding = updates.understanding;
    if (updates.strategy !== undefined) setData.strategy = updates.strategy;
    if (updates.checkedDirectories !== undefined) setData.checkedDirectories = updates.checkedDirectories;
    if (updates.candidates !== undefined) setData.candidates = updates.candidates;
    if (updates.nextBatch !== undefined) setData.nextBatch = updates.nextBatch;
    if (updates.status !== undefined) setData.status = updates.status;
    setData.updatedAt = Date.now();

    await this.db
      .update(schema.searchTasks)
      .set(setData)
      .where(eq(schema.searchTasks.id, id));

    return (await this.getSearchTask(id))!;
  }

  async getSearchTask(id: string): Promise<SearchTask | null> {
    const rows = await this.db
      .select()
      .from(schema.searchTasks)
      .where(eq(schema.searchTasks.id, id))
      .limit(1);
    return rows[0] ? this.toSearchTask(rows[0]) : null;
  }

  // -----------------------------------------------------------------------
  // FTS Search
  // -----------------------------------------------------------------------

  async searchMessages(
    query: string,
    sessionId?: string,
  ): Promise<Message[]> {
    // Use FTS5 to find matching message rowids
    const stmt = this.raw.prepare(`
      SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?
    `);
    const ftsRows = stmt.all(query) as Array<{ rowid: number }>;
    const rowids = ftsRows.map((r) => r.rowid);

    if (rowids.length === 0) return [];

    // Fetch actual messages by rowid
    let dbQuery = this.db
      .select()
      .from(schema.messages);

    // SQLite rowid lookup
    const placeholders = rowids.map(() => "?").join(",");
    const rawRows = this.raw
      .prepare(
        `SELECT * FROM messages WHERE rowid IN (${placeholders})${sessionId ? " AND session_id = ?" : ""} ORDER BY created_at ASC`,
      )
      .all(...rowids, ...(sessionId ? [sessionId] : [])) as Array<typeof schema.messages.$inferSelect>;

    return rawRows.map((r) => this.toMessage(r));
  }

  // -----------------------------------------------------------------------
  // Type converters (DB row → domain type)
  // -----------------------------------------------------------------------

  private toMessage(
    r: typeof schema.messages.$inferSelect,
  ): Message {
    return {
      id: r.id,
      sessionId: r.sessionId,
      userId: r.userId ?? undefined,
      role: r.role as Message["role"],
      content: r.content,
      toolCallId: r.toolCallId ?? undefined,
      toolName: r.toolName ?? undefined,
      tokenCount: r.tokenCount ?? undefined,
      createdAt: r.createdAt,
    };
  }

  private toChunk(
    r: typeof schema.contextChunks.$inferSelect,
  ): ContextChunk {
    return {
      id: r.id,
      sessionId: r.sessionId,
      timeRangeStart: r.timeRangeStart,
      timeRangeEnd: r.timeRangeEnd,
      summary: r.summary,
      progress: r.progress,
      keywords: r.keywords as string[],
      sourceFromId: r.sourceFromId,
      sourceToId: r.sourceToId,
      directoryId: r.directoryId ?? undefined,
      createdAt: r.createdAt,
    };
  }

  private toDirectory(
    r: typeof schema.directories.$inferSelect,
  ): DirectoryNode {
    return {
      id: r.id,
      sessionId: r.sessionId,
      parentId: r.parentId ?? undefined,
      generation: r.generation,
      timeRangeStart: r.timeRangeStart,
      timeRangeEnd: r.timeRangeEnd,
      overallContent: r.overallContent,
      progress: r.progress,
      mainConclusions: r.mainConclusions as string[],
      importantChanges: r.importantChanges as string[],
      createdAt: r.createdAt,
    };
  }

  private toWorkingMemory(
    r: typeof schema.workingMemory.$inferSelect,
  ): WorkingMemory {
    return {
      id: r.id,
      sessionId: r.sessionId,
      currentTask: r.currentTask ?? undefined,
      confirmed: r.confirmed as string[],
      progress: r.progress as string[],
      unresolved: r.unresolved as string[],
      recentChanges: r.recentChanges as string[],
      updatedAt: r.updatedAt,
    };
  }

  private toUserMemory(
    r: typeof schema.userMemory.$inferSelect,
  ): UserMemory {
    return {
      id: r.id,
      userId: r.userId,
      preferences: r.preferences as string[],
      longTermGoals: r.longTermGoals as string[],
      constraints: r.constraints as string[],
      background: r.background ?? undefined,
      updatedAt: r.updatedAt,
    };
  }

  private toSearchTask(
    r: typeof schema.searchTasks.$inferSelect,
  ): SearchTask {
    return {
      id: r.id,
      sessionId: r.sessionId,
      query: r.query,
      understanding: r.understanding ?? undefined,
      strategy: r.strategy ?? undefined,
      checkedDirectories: r.checkedDirectories as string[],
      candidates: r.candidates as string[],
      nextBatch: r.nextBatch ?? undefined,
      status: r.status as SearchTask["status"],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}
