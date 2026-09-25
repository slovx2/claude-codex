import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { RuntimeTurnContext } from './types.mjs'

const readTools = new Set([
  'Read',
  'Glob',
  'Grep',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'TodoWrite',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
])
const fileTools = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

export function planDirectory(context: RuntimeTurnContext): string {
  return join(
    process.env.CLAUDE_CODEX_HOME ?? join(homedir(), '.claude-codex'),
    'plans',
    context.threadId,
  )
}

export function isPlanFile(
  context: RuntimeTurnContext,
  name: string,
  input: Record<string, unknown>,
): boolean {
  if (!context.planMode || !fileTools.has(name) || typeof input.file_path !== 'string') return false
  const child = relative(
    resolvedTarget(planDirectory(context)),
    resolvedTarget(resolve(context.cwd, input.file_path)),
  )
  return child.length > 0 && child !== '..' && !child.startsWith('../') && !isAbsolute(child)
}

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
  // 原生计划文件保存在会话专属目录，只豁免此文件，不豁免项目源码或符号链接外逃。
  if (isPlanFile(context, name, input)) return null
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
  // 计划模式用每次工具调用的动态 hook 限制；退出计划不能解除用户选择的沙箱。
  const constrained = context.sandboxMode !== 'danger-full-access'
  return {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (event: Record<string, unknown>) => {
              const reason =
                event.agent_id &&
                ['EnterPlanMode', 'ExitPlanMode'].includes(String(event.tool_name))
                  ? '子代理不能修改父会话的计划模式'
                  : deniedTool(
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
                : context.approvalPolicy === 'untrusted' &&
                    !readTools.has(String(event.tool_name)) &&
                    !isPlanFile(
                      context,
                      String(event.tool_name),
                      (event.tool_input ?? {}) as Record<string, unknown>,
                    )
                  ? {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'ask',
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
              allowWrite: context.sandboxMode === 'read-only' ? [] : [context.cwd],
            },
            network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false },
          },
        }
      : {}),
  }
}
