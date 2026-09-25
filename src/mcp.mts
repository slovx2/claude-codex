import { readFileSync } from 'node:fs'
import { sdkMcpServers } from './mcp-config.mjs'
import { ProtocolError } from './protocol-contract.mjs'

// 环境变量允许内联 JSON 或配置文件；重新读取文件以支持显式重载。
export function readMcpConfig(): Record<string, unknown> {
  const raw = process.env.CLAUDE_CODEX_MCP_SERVERS?.trim()
  if (!raw) return {}
  try {
    const value = JSON.parse(raw.startsWith('{') ? raw : readFileSync(raw, 'utf8'))
    sdkMcpServers(value)
    return value
  } catch (error) {
    throw new ProtocolError(-32602, 'MCP 配置读取失败: ' + String(error))
  }
}
