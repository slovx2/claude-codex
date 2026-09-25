import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { RuntimeTurnContext } from './types.mjs'

const readTools = new Set([
  'Read',
  'Glob',
  'Grep',
  'AskUserQuestion',
  'TodoWrite',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
])
const fileTools = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

function resolvedTarget(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    if (parent === path) return path
    return resolve(resolvedTarget(parent), relative(parent, path))
  }
}

// 放在 PreToolUse，避免 SDK 自带 allow 规则或 acceptEdits 绕过 canUseTool。
export function deniedTool(
  context: RuntimeTurnContext,
  name: string,
  input: Record<string, unknown>,
): string | null {
  if (context.planMode || context.sandboxMode === 'read-only')
    return readTools.has(name) ? null : '当前会话只允许读取，不允许有副作用的工具'
  if (context.sandboxMode !== 'danger-full-access' && context.sandboxMode !== 'workspace-write')
    return '未知权限模式，拒绝执行'
  if (context.sandboxMode === 'workspace-write' && fileTools.has(name)) {
    const target = input.file_path ?? input.notebook_path
    if (typeof target !== 'string') return '文件工具缺少目标路径'
    const root = resolvedTarget(context.cwd)
    const path = resolvedTarget(resolve(root, target))
    const child = relative(root, path)
    if (child === '..' || child.startsWith('../') || isAbsolute(child)) return '文件路径超出工作区'
  }
  return null
}

export function runtimePermissionOptions(context: RuntimeTurnContext): Record<string, unknown> {
  const constrained = context.planMode || context.sandboxMode !== 'danger-full-access'
  return {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (event: Record<string, unknown>) => {
              const reason = deniedTool(
                context,
                String(event.tool_name),
                (event.tool_input ?? {}) as Record<string, unknown>,
              )
              return reason
                ? {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'deny',
                      permissionDecisionReason: reason,
                    },
                  }
                : {}
            },
          ],
        },
      ],
    },
    ...(constrained
      ? {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            filesystem: {
              allowWrite:
                context.planMode || context.sandboxMode === 'read-only' ? [] : [context.cwd],
            },
            network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false },
          },
        }
      : {}),
  }
}
