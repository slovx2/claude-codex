import type { ElicitationRequest, ElicitationResult } from '@anthropic-ai/claude-agent-sdk'
import { ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { Ajv } from 'ajv'
import { ProtocolError } from './protocol-contract.mjs'

export function elicitationParams(
  request: ElicitationRequest & { _meta?: Record<string, unknown> },
  threadId: string,
  turnId: string | null,
): Record<string, unknown> {
  const common = {
    threadId,
    turnId,
    serverName: request.serverName,
    message: request.message,
    ...(request._meta === undefined ? {} : { _meta: request._meta }),
  }
  if (request.mode === 'url') {
    if (!request.url || !request.elicitationId)
      throw new ProtocolError(-32602, 'URL 交互缺少地址或标识')
    return { ...common, mode: 'url', url: request.url, elicitationId: request.elicitationId }
  }
  if (!request.requestedSchema) throw new ProtocolError(-32602, '表单交互缺少 schema')
  return { ...common, mode: 'form', requestedSchema: request.requestedSchema }
}

export function elicitationResponse(
  request: ElicitationRequest,
  value: unknown,
): ElicitationResult {
  const parsed = ElicitResultSchema.safeParse(value)
  if (!parsed.success) throw new ProtocolError(-32602, '交互回答不符合 MCP 响应结构')
  const result = parsed.data
  if (result.action !== 'accept') return result
  // schema 随请求变化，不让全局编译缓存持续持有历史表单。
  const ajv = new Ajv({ strict: false, validateFormats: false })
  if (
    request.mode !== 'url' &&
    (!request.requestedSchema || !ajv.validate(request.requestedSchema, result.content))
  )
    throw new ProtocolError(-32602, '交互回答不符合表单 schema')
  return result
}
