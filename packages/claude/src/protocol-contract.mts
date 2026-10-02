import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import { isApprovalPolicy } from './approval-policy.mjs'
import { parseSandboxPolicy, type RuntimeSandboxPolicy } from './sandbox-policy.mjs'

export {
  ProtocolError,
  pageRecords,
  requiredString,
  submissionHash,
} from '../../shared/src/protocol-contract.mjs'

export interface ThreadRuntimeSettings {
  sandboxPolicy?: RuntimeSandboxPolicy
  planMode?: boolean
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
  if (params.permissions != null && (params.sandbox != null || params.sandboxPolicy != null))
    throw new ProtocolError(-32602, '权限档位不能与沙箱策略同时设置')
  if (params.sandbox != null && params.sandboxPolicy != null)
    throw new ProtocolError(-32602, 'sandbox 与 sandboxPolicy 不能同时设置')
  if (params.approvalPolicy != null && !isApprovalPolicy(params.approvalPolicy))
    throw new ProtocolError(-32602, '未知审批策略')
  const mode = (params.collaborationMode as { mode?: unknown } | undefined)?.mode
  if (mode != null && mode !== 'plan' && mode !== 'default')
    throw new ProtocolError(-32602, '未知协作模式')
  if (
    params.permissions != null &&
    (typeof params.permissions !== 'string' ||
      ![':read-only', ':workspace', ':danger-full-access'].includes(params.permissions))
  )
    throw new ProtocolError(-32602, '未知权限配置')
  if (
    params.sandbox != null &&
    (typeof params.sandbox !== 'string' ||
      !['read-only', 'workspace-write', 'danger-full-access'].includes(params.sandbox))
  )
    throw new ProtocolError(-32602, '未知 sandbox 模式')
  if (params.sandboxPolicy != null) parseSandboxPolicy(params.sandboxPolicy)
}
