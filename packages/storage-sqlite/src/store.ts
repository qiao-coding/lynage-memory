// ---------------------------------------------------------------------------
// SqliteStore — LynageStore implementation backed by SQLite + Drizzle ORM
// ---------------------------------------------------------------------------

import { eq, and, gte, lte, gt, desc, asc, count, isNull, inArray } from "drizzle-orm";
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
    const conditions: any[] = [eq(schema.messages.sessionId, scope.sessionId)];
    if (scope.since) {
      conditions.push(gt(schema.messages.createdAt, scope.since));
    }

    // asc=true: oldest-first from `since` (archive cursor traversal).
    // asc=false (default): most-recent-first, then re-sorted chronologically.
    const rows = await this.db
      .select()
      .from(schema.messages)
      .where(and(...conditions))
      .orderBy(scope.asc ? asc(schema.messages.createdAt) : desc(schema.messages.createdAt))
      .limit(limit);

    return rows.map((r) => this.toMessage(r));
  }

  async getMessageRange(fromId: string, toId: string): Promise<Message[]> {
    // Use rowid range (monotonic, no timestamp collisions)
    const stmt = this.raw.prepare(`
      SELECT * FROM messages
      WHERE session_id = (
        SELECT session_id FROM messages WHERE id = ? LIMIT 1
      )
      AND rowid BETWEEN
        (SELECT rowid FROM messages WHERE id = ? LIMIT 1)
        AND (SELECT rowid FROM messages WHERE id = ? LIMIT 1)
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(fromId, fromId, toId) as Array<typeof schema.messages.$inferSelect>;
    return rows.map((r) => this.toMessage(r));
  }

  async getMessagesAround(messageId: string, window = 3): Promise<Message[]> {
    const anchor = this.raw.prepare(
      "SELECT rowid, session_id FROM messages WHERE id = ? LIMIT 1",
    ).get(messageId) as { rowid: number; session_id: string } | undefined;
    if (!anchor) return [];
    const rows = this.raw.prepare(
      `SELECT * FROM messages WHERE session_id = ? AND rowid BETWEEN ? AND ? ORDER BY rowid ASC`,
    ).all(anchor.session_id, anchor.rowid - window, anchor.rowid + window) as Array<typeof schema.messages.$inferSelect>;
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
      conclusions: Array.isArray(input.conclusions) ? input.conclusions : [],
      goals: Array.isArray(input.goals) ? input.goals : [],
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

  async getChunksByIds(ids: string[]): Promise<ContextChunk[]> {
    if (ids.length === 0) return [];
    // Chunk into batches of 500 to avoid SQLite's 999-param limit
    const results: Array<typeof schema.contextChunks.$inferSelect> = [];
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      const rows = await this.db
        .select()
        .from(schema.contextChunks)
        .where(inArray(schema.contextChunks.id, batch));
      results.push(...rows);
    }
    return results.map((r) => this.toChunk(r));
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

  async getLastArchiveTime(sessionId: string): Promise<number> {
    const row = this.raw.prepare(
      "SELECT MAX(time_range_end) AS last FROM context_chunks WHERE session_id = ?",
    ).get(sessionId) as { last: number | null } | undefined;
    return row?.last ?? 0;
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
      mainConclusions: Array.isArray(input.mainConclusions) ? input.mainConclusions : [],
      importantChanges: Array.isArray(input.importantChanges) ? input.importantChanges : [],
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
    // Use Drizzle (not raw spread) — better-sqlite3 spreads nested arrays,
    // breaking empty [] json fields with "Too few parameter values".
    const setData: Record<string, unknown> = {};
    if (updates.sessionId !== undefined) setData.sessionId = updates.sessionId;
    if (updates.parentId !== undefined) setData.parentId = updates.parentId;
    if (updates.generation !== undefined) setData.generation = updates.generation;
    if (updates.timeRangeStart !== undefined) setData.timeRangeStart = updates.timeRangeStart;
    if (updates.timeRangeEnd !== undefined) setData.timeRangeEnd = updates.timeRangeEnd;
    if (updates.overallContent !== undefined) setData.overallContent = updates.overallContent;
    if (updates.progress !== undefined) setData.progress = updates.progress;
    if (updates.mainConclusions !== undefined) setData.mainConclusions = Array.isArray(updates.mainConclusions) ? updates.mainConclusions : [];
    if (updates.importantChanges !== undefined) setData.importantChanges = Array.isArray(updates.importantChanges) ? updates.importantChanges : [];

    if (Object.keys(setData).length > 0) {
      await this.db
        .update(schema.directories)
        .set(setData as any)
        .where(eq(schema.directories.id, id));
    }

    return (await this.getDirectory(id))!;
  }

  /** Update a chunk's directory association (persisted to DB) */
  async updateChunkDirectory(chunkId: string, dirId: string): Promise<void> {
    this.raw.prepare("UPDATE context_chunks SET directory_id = ? WHERE id = ?").run(dirId, chunkId);
  }

  async getRootDirectories(sessionId: string): Promise<DirectoryNode[]> {
    // Roots are identified by parentId IS NULL — NOT generation === 0.
    // After G0→G1 compaction the new root has generation 1; a generation
    // filter would return [] and kill tree navigation entirely.
    const rows = await this.db
      .select()
      .from(schema.directories)
      .where(
        and(
          eq(schema.directories.sessionId, sessionId),
          isNull(schema.directories.parentId),
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

  async removeChildFromDirectory(directoryId: string, childId: string): Promise<void> {
    this.raw.prepare(
      "DELETE FROM directory_children WHERE directory_id = ? AND child_id = ?",
    ).run(directoryId, childId);
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
    // Sanitize FTS5 query: strip special characters that break FTS5 syntax
    const sanitized = query.replace(/[^\w\s一-鿿぀-ゟ゠-ヿ]/g, " ").replace(/\s+/g, " ").trim();
    if (!sanitized) return [];

    // Use FTS5 trigram search. For very short queries (< 3 chars), trigram
    // can't form proper n-grams — fall back to SQL LIKE.
    const queryTerms = sanitized.split(/\s+/).filter((t) => t.length > 0);
    const needLikeFallback = queryTerms.some((t) => t.length < 3);

    let rawRows: Array<typeof schema.messages.$inferSelect>;

    if (needLikeFallback) {
      // LIKE fallback for short queries (< 3 chars): return messages directly
      const conditions = queryTerms.map(() => "content LIKE ?").join(" AND ");
      const params = queryTerms.map((t) => `%${t}%`);
      const sql = `SELECT * FROM messages WHERE ${conditions}${sessionId ? " AND session_id = ?" : ""} ORDER BY created_at ASC`;
      rawRows = this.raw.prepare(sql).all(
        ...params,
        ...(sessionId ? [sessionId] : []),
      ) as Array<typeof schema.messages.$inferSelect>;
    } else {
      // FTS5 trigram search: get rowids then fetch full messages
      const stmt = this.raw.prepare(
        `SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`,
      );
      const ftsRows = stmt.all(sanitized) as Array<{ rowid: number }>;
      const rowids = [...new Set(ftsRows.map((r) => r.rowid))].slice(0, 999);
      if (rowids.length === 0) return [];

      const placeholders = rowids.map(() => "?").join(",");
      rawRows = this.raw
        .prepare(
          `SELECT * FROM messages WHERE rowid IN (${placeholders})${sessionId ? " AND session_id = ?" : ""} ORDER BY created_at ASC`,
        )
        .all(...rowids, ...(sessionId ? [sessionId] : [])) as Array<typeof schema.messages.$inferSelect>;
    }

    return rawRows.map((r) => this.toMessage(r));
  }

  /**
   * FTS5 search over chunk structured summaries (summary/keywords/
   * conclusions/goals). Returns chunk ids ordered by bm25 relevance.
   * This is the CHEAP retrieval path (~6ms) — no LLM involved.
   */
  async searchChunks(query: string, sessionId?: string): Promise<string[]> {
    const sanitized = query.replace(/[^\w\s一-鿿぀-ゟ゠-ヿ]/g, " ").replace(/\s+/g, " ").trim();
    if (!sanitized) return [];

    const queryTerms = sanitized.split(/\s+/).filter((t) => t.length > 0);
    const needLikeFallback = queryTerms.some((t) => t.length < 3);

    if (needLikeFallback) {
      // Short query (< 3 chars): trigram can't form n-grams → SQL LIKE
      const cond = queryTerms
        .map(() => "(summary LIKE ? OR keywords LIKE ? OR conclusions LIKE ? OR goals LIKE ?)")
        .join(" AND ");
      const params = queryTerms.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`]);
      const sql = `SELECT id FROM context_chunks WHERE ${cond}${sessionId ? " AND session_id = ?" : ""}`;
      const rows = this.raw.prepare(sql).all(...params, ...(sessionId ? [sessionId] : [])) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    }

    // FTS5 trigram over chunk summaries, joined back to filter by session.
    const rows = this.raw
      .prepare(
        `SELECT c.id FROM context_chunks c
         JOIN chunks_fts f ON f.rowid = c.rowid
         WHERE chunks_fts MATCH ?${sessionId ? " AND c.session_id = ?" : ""}
         ORDER BY bm25(chunks_fts)`,
      )
      .all(sanitized, ...(sessionId ? [sessionId] : [])) as Array<{ id: string }>;
    return rows.slice(0, 100).map((r) => r.id);
  }

  // -----------------------------------------------------------------------
  // Type converters (DB row → domain type)
  // -----------------------------------------------------------------------

  private toMessage(
    r: typeof schema.messages.$inferSelect,
  ): Message {
    // Raw SQL queries return snake_case, Drizzle returns camelCase. Handle both.
    const raw = r as Record<string, unknown>;
    return {
      id: (raw.id ?? raw.ID) as string,
      sessionId: (raw.sessionId ?? raw.session_id) as string,
      userId: (raw.userId ?? raw.user_id ?? undefined) as string | undefined,
      role: (raw.role ?? raw.ROLE) as Message["role"],
      content: (raw.content ?? raw.CONTENT) as string,
      toolCallId: (raw.toolCallId ?? raw.tool_call_id ?? undefined) as string | undefined,
      toolName: (raw.toolName ?? raw.tool_name ?? undefined) as string | undefined,
      tokenCount: (raw.tokenCount ?? raw.token_count ?? undefined) as number | undefined,
      createdAt: (raw.createdAt ?? raw.created_at ?? 0) as number,
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
      conclusions: (r.conclusions as string[]) ?? [],
      goals: (r.goals as string[]) ?? [],
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
      goals: (r.goals as string[]) ?? [],
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
