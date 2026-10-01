import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ProtocolError, submissionHash } from '../../shared/src/protocol-contract.mjs'
import { ensureParent } from '../../shared/src/util.mjs'

export interface PiThread {
  id: string
  path: string | null
  cwd: string
  name: string | null
  preview: string
  createdAt: number
  updatedAt: number
  ephemeral: boolean
  model: string | null
  effort: string | null
  planMode: boolean
  dynamicTools: any[]
  forkedFromId: string | null
  parentThreadId?: string | null
}
export interface PiTurn {
  id: string
  items: any[]
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed'
  error: { message: string; codexErrorInfo: null; additionalDetails: null } | null
  startedAt: number
  completedAt: number | null
  durationMs: number | null
}

// 仅保存协议投影、提交账本和界面元数据；模型上下文始终由 Pi SessionManager 读取。
export class PiStore {
  readonly db: DatabaseSync
  constructor(home: string) {
    const path = join(home, 'adapter.sqlite')
    ensureParent(path)
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, data TEXT NOT NULL,
        updated_at INTEGER NOT NULL, ephemeral INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS turns(id TEXT NOT NULL, thread_id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(thread_id,id));
      CREATE INDEX IF NOT EXISTS turns_thread ON turns(thread_id, position);
      CREATE TABLE IF NOT EXISTS submissions(thread_id TEXT NOT NULL, message_id TEXT NOT NULL,
        hash TEXT NOT NULL, turn_id TEXT NOT NULL, PRIMARY KEY(thread_id,message_id));
      CREATE TABLE IF NOT EXISTS metadata(scope TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope,id));`)
    for (const thread of this.threads()) {
      if (thread.ephemeral) {
        this.delete(thread.id)
        continue
      }
      for (const turn of this.turns(thread.id))
        if (turn.status === 'inProgress') {
          turn.status = 'interrupted'
          turn.completedAt = Date.now()
          turn.durationMs = turn.completedAt - turn.startedAt
          this.saveTurn(thread.id, turn)
        }
    }
  }
  threads(): PiThread[] {
    return this.db
      .prepare('SELECT data FROM threads ORDER BY updated_at,id')
      .all()
      .map((r) => JSON.parse(String(r.data)))
  }
  thread(id: string): PiThread {
    const row = this.db.prepare('SELECT data FROM threads WHERE id=?').get(id)
    if (!row) throw new ProtocolError(-32602, '未知 Pi 会话')
    return JSON.parse(String(row.data))
  }
  saveThread(thread: PiThread): void {
    this.db
      .prepare(`INSERT INTO threads(id,data,updated_at,ephemeral) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,ephemeral=excluded.ephemeral`)
      .run(thread.id, JSON.stringify(thread), thread.updatedAt, Number(thread.ephemeral))
  }
  turns(id: string): PiTurn[] {
    return this.db
      .prepare('SELECT data FROM turns WHERE thread_id=? ORDER BY position,id')
      .all(id)
      .map((r) => JSON.parse(String(r.data)))
  }
  saveTurn(threadId: string, turn: PiTurn): void {
    this.db
      .prepare(`INSERT INTO turns(id,thread_id,position,data)
      SELECT ?,?,COALESCE(MAX(position),0)+1,? FROM turns WHERE thread_id=?
      ON CONFLICT(thread_id,id) DO UPDATE SET data=excluded.data`)
      .run(turn.id, threadId, JSON.stringify(turn), threadId)
  }
  submitted(threadId: string, clientId: string, input: unknown): PiTurn | null {
    const row = this.db
      .prepare('SELECT hash,turn_id FROM submissions WHERE thread_id=? AND message_id=?')
      .get(threadId, clientId)
    if (!row) return null
    if (row.hash !== submissionHash(input))
      throw new ProtocolError(-32009, '消息 ID 已被不同输入使用')
    const turn = this.turns(threadId).find((t) => t.id === row.turn_id)
    if (!turn) throw new ProtocolError(-32009, '此提交属于已回退分支，不能重复执行')
    return turn
  }
  admit(
    threadId: string,
    clientId: string | null,
    input: unknown,
    turn: PiTurn,
    consume?: () => void,
  ): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.saveTurn(threadId, turn)
      if (clientId)
        this.db
          .prepare('INSERT INTO submissions VALUES(?,?,?,?)')
          .run(threadId, clientId, submissionHash(input), turn.id)
      consume?.()
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  replaceTurns(threadId: string, turns: PiTurn[]): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM turns WHERE thread_id=?').run(threadId)
      for (const turn of turns) this.saveTurn(threadId, turn)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  getMeta(scope: string, id: string): any {
    const row = this.db.prepare('SELECT data FROM metadata WHERE scope=? AND id=?').get(scope, id)
    return row ? JSON.parse(String(row.data)) : null
  }
  setMeta(scope: string, id: string, data: unknown): void {
    this.db
      .prepare(
        'INSERT INTO metadata VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET data=excluded.data',
      )
      .run(scope, id, JSON.stringify(data))
  }
  delete(id: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const table of ['turns', 'submissions'])
        this.db.prepare(`DELETE FROM ${table} WHERE thread_id=?`).run(id)
      this.db
        .prepare('DELETE FROM metadata WHERE id=? OR scope=? OR scope=?')
        .run(id, `attachments:${id}`, `steer:${id}`)
      this.db.prepare('DELETE FROM threads WHERE id=?').run(id)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  close(): void {
    this.db.close()
  }
}
