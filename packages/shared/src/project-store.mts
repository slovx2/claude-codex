import type { DatabaseSync } from 'node:sqlite'
import { ProtocolError } from './protocol-contract.mjs'
import { newId, nowSeconds } from './util.mjs'

export type ProjectFields = {
  name: string
  roots: Array<{ path: string }>
  metadata: Record<string, string>
}
export type Project = ProjectFields & {
  id: string
  position: number
  createdAt: number
  updatedAt: number
  recencyAt: number | null
}

export class ProjectStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL, roots_json TEXT NOT NULL, metadata_json TEXT NOT NULL,
        position INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_threads (
        thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_members ON project_threads(project_id);
      CREATE TEMP TABLE IF NOT EXISTS live_project_threads (
        thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL
      );
    `)
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  list(): Project[] {
    return this.db
      .prepare(`
      SELECT p.*, (SELECT MAX(t.updated_at) FROM project_threads m
        JOIN threads t ON t.id=m.thread_id
        WHERE m.project_id=p.id AND t.archived=0 AND t.ephemeral=0) AS recency_at
      FROM projects p ORDER BY p.position, p.id
    `)
      .all()
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        roots: JSON.parse(String(row.roots_json)) as Project['roots'],
        metadata: JSON.parse(String(row.metadata_json)) as Project['metadata'],
        position: Number(row.position),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        recencyAt: row.recency_at === null ? null : Number(row.recency_at),
      }))
  }

  read(id: string): Project {
    const project = this.list().find((entry) => entry.id === id)
    if (!project) throw new ProtocolError(-32602, '未知项目')
    return project
  }

  projectId(threadId: string): string | null {
    const row = this.db
      .prepare(`
      SELECT project_id FROM project_threads WHERE thread_id=?
      UNION ALL SELECT project_id FROM live_project_threads WHERE thread_id=?
    `)
      .get(threadId, threadId)
    return row ? String(row.project_id) : null
  }

  private assign(threadId: string, projectId: string | null): boolean {
    const thread = this.db.prepare('SELECT ephemeral FROM threads WHERE id=?').get(threadId)
    if (!thread) throw new ProtocolError(-32602, '未知会话')
    if (this.projectId(threadId) === projectId) return false
    // 临时会话归属只存在于当前数据库连接，不能在进程重启后恢复。
    const table = thread.ephemeral === 1 ? 'live_project_threads' : 'project_threads'
    if (projectId === null) this.db.prepare(`DELETE FROM ${table} WHERE thread_id=?`).run(threadId)
    else
      this.db
        .prepare(`
      INSERT INTO ${table}(thread_id,project_id) VALUES(?,?)
      ON CONFLICT(thread_id) DO UPDATE SET project_id=excluded.project_id
    `)
        .run(threadId, projectId)
    return true
  }

  assignThread(threadId: string, projectId: string | null): boolean {
    return this.transaction(() => {
      if (projectId !== null) this.read(projectId)
      return this.assign(threadId, projectId)
    })
  }

  create(
    fields: ProjectFields,
    key: string,
    threads: string[],
  ): {
    project: Project
    created: boolean
    assigned: string[]
  } {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM projects WHERE idempotency_key=?').get(key)
      if (existing) return { project: this.read(String(existing.id)), created: false, assigned: [] }
      // 校验全部归属后再写入，非法导入不能留下半个项目或转移部分会话。
      for (const threadId of threads)
        if (!this.db.prepare('SELECT id FROM threads WHERE id=?').get(threadId))
          throw new ProtocolError(-32602, '导入包含未知会话')
      const id = newId(),
        now = nowSeconds()
      const position = Number(
        this.db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS value FROM projects').get()?.value,
      )
      this.db
        .prepare(`
        INSERT INTO projects(id,idempotency_key,name,roots_json,metadata_json,position,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)
      `)
        .run(
          id,
          key,
          fields.name,
          JSON.stringify(fields.roots),
          JSON.stringify(fields.metadata),
          position,
          now,
          now,
        )
      const assigned = [...new Set(threads)].filter((threadId) => this.assign(threadId, id))
      return { project: this.read(id), created: true, assigned }
    })
  }

  update(id: string, patch: Partial<ProjectFields>): Project {
    return this.transaction(() => {
      const project = { ...this.read(id), ...patch, updatedAt: nowSeconds() }
      this.db
        .prepare('UPDATE projects SET name=?,roots_json=?,metadata_json=?,updated_at=? WHERE id=?')
        .run(
          project.name,
          JSON.stringify(project.roots),
          JSON.stringify(project.metadata),
          project.updatedAt,
          id,
        )
      return project
    })
  }

  move(id: string, beforeId: string | null): boolean {
    return this.transaction(() => {
      this.read(id)
      if (beforeId !== null) this.read(beforeId)
      if (beforeId === id) return false
      const old = this.list().map((project) => project.id)
      const reordered = old.filter((projectId) => projectId !== id)
      reordered.splice(beforeId === null ? reordered.length : reordered.indexOf(beforeId), 0, id)
      if (old.every((projectId, index) => projectId === reordered[index])) return false
      const update = this.db.prepare('UPDATE projects SET position=?,updated_at=? WHERE id=?')
      for (const [position, projectId] of reordered.entries())
        update.run(position, nowSeconds(), projectId)
      return true
    })
  }

  delete(id: string): string[] {
    return this.transaction(() => {
      this.read(id)
      const threads = this.db
        .prepare(`
        SELECT thread_id FROM project_threads WHERE project_id=?
        UNION SELECT thread_id FROM live_project_threads WHERE project_id=?
      `)
        .all(id, id)
        .map((row) => String(row.thread_id))
      this.db.prepare('DELETE FROM project_threads WHERE project_id=?').run(id)
      this.db.prepare('DELETE FROM live_project_threads WHERE project_id=?').run(id)
      this.db.prepare('DELETE FROM projects WHERE id=?').run(id)
      return threads
    })
  }
}
