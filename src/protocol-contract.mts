import { createHash } from 'node:crypto'

export class ProtocolError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new ProtocolError(-32602, `${name} 必须是非空字符串`)
  return value
}

// 对象键顺序不影响提交身份；输入数组顺序仍有语义。
export function submissionHash(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      )
    return input
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}

export function pageRecords<T>(
  records: T[],
  params: Record<string, unknown>,
  scope: string,
  identity: (record: T) => string,
) {
  const limit = params.limit ?? 50
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new ProtocolError(-32602, 'limit 必须在 1 到 1000 之间')
  const direction = params.sortDirection ?? 'desc'
  if (direction !== 'asc' && direction !== 'desc')
    throw new ProtocolError(-32602, 'sortDirection 无效')
  const ordered = direction === 'desc' ? [...records].reverse() : records
  let offset = 0
  if (params.cursor != null) {
    try {
      const cursor = JSON.parse(
        Buffer.from(requiredString(params.cursor, 'cursor'), 'base64url').toString(),
      )
      const index = ordered.findIndex((item) => identity(item) === cursor.id)
      if (cursor.scope !== scope || index < 0) throw new Error('游标不属于本次查询')
      offset = index + (cursor.inclusive === true ? 0 : 1)
    } catch {
      throw new ProtocolError(-32602, '历史游标无效或已失效')
    }
  }
  const data = ordered.slice(offset, offset + limit)
  const cursorFor = (record: T, inclusive = false) =>
    Buffer.from(JSON.stringify({ scope, id: identity(record), inclusive })).toString('base64url')
  return {
    data,
    nextCursor:
      offset + limit < ordered.length && data.length ? cursorFor(data[data.length - 1]!) : null,
    backwardsCursor: data.length ? cursorFor(data[0]!, true) : null,
  }
}

export interface ThreadRuntimeSettings {
  historyMode?: 'legacy' | 'paginated'
  dynamicTools?: unknown[]
  config?: Record<string, unknown>
  gitInfo?: { sha: string | null; branch: string | null; originUrl: string | null } | null
}

export function rejectForeignModel(model: unknown): void {
  if (typeof model === 'string' && /^(gpt-|codex|o[134](?:-|$))/.test(model))
    throw new ProtocolError(-32602, 'Claude 入口不支持 Codex 模型或跨引擎会话')
}

export function validateRuntimePermissions(params: Record<string, unknown>): void {
  if (
    params.permissions != null &&
    ![':read-only', ':workspace', ':danger-full-access'].includes(String(params.permissions))
  )
    throw new ProtocolError(-32602, '未知权限配置')
  if (
    params.sandbox != null &&
    !['read-only', 'workspace-write', 'danger-full-access'].includes(String(params.sandbox))
  )
    throw new ProtocolError(-32602, '未知 sandbox 模式')
  if (params.sandboxPolicy != null) {
    const policy = params.sandboxPolicy as { type?: string }
    if (!['readOnly', 'workspaceWrite', 'dangerFullAccess'].includes(String(policy.type)))
      throw new ProtocolError(-32602, '不支持此 sandboxPolicy')
  }
}
