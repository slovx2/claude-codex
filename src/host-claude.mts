import { execFileSync } from 'node:child_process'
import { accessSync, constants, realpathSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

// 解析真实文件，保留 npm CLI 的 .js 后缀，让 SDK 使用其官方 Node 启动方式。
export function hostClaudeExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const command = env.CLAUDE_CODEX_CLI?.trim() || 'claude'
  const candidates =
    isAbsolute(command) || command.includes('/') || command.includes('\\')
      ? [resolve(command)]
      : (env.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, command))
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK)
      return realpathSync(path)
    } catch {}
  }
  throw new Error(
    `宿主 Claude CLI 不可执行或未找到: ${command}；请配置 TYRS_HAND_WORKER_CLAUDE_CLI 或 Worker 用户 PATH`,
  )
}

export function hostClaudeVersion(cli: string, expected: string): string {
  let actual: string
  try {
    actual = execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    throw new Error(`无法读取宿主 Claude CLI 版本: ${cli}`)
  }
  if (actual !== `${expected} (Claude Code)`)
    throw new Error(`宿主 Claude CLI 版本不符: 需要 ${expected} (Claude Code)，实际 ${actual}`)
  return actual
}
