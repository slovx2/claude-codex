import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { clientTools } from './dynamic-tools.mjs'
import { NativeFiles, nativeBranch } from './native-files.mjs'
import type { PiThread, PiTurn } from './store.mjs'

export function textContent(content: any): string {
  return typeof content === 'string'
    ? content
    : (content ?? [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n')
}
export function messageItems(message: any): any[] {
  const id = `${message.role}:${message.timestamp}`
  if (message.role === 'user')
    return [
      {
        type: 'userMessage',
        id,
        content:
          typeof message.content === 'string'
            ? [{ type: 'text', text: message.content, text_elements: [] }]
            : message.content.map((c: any) =>
                c.type === 'image'
                  ? { type: 'image', url: `data:${c.mimeType};base64,${c.data}` }
                  : { type: 'text', text: c.text ?? '', text_elements: [] },
              ),
      },
    ]
  if (message.role !== 'assistant') return []
  return (message.content ?? []).flatMap((c: any, i: number) => {
    if (c.type === 'text')
      return [
        {
          type: 'agentMessage',
          id: `${id}:${i}`,
          text: c.text,
          phase: message.stopReason === 'toolUse' ? 'commentary' : 'final_answer',
          memoryCitation: null,
        },
      ]
    if (c.type === 'thinking')
      return [{ type: 'reasoning', id: `${id}:${i}`, summary: [c.thinking ?? ''], content: [] }]
    return []
  })
}
export function toolItem(
  id: string,
  name: string,
  args: any,
  cwd: string,
  threadId: string,
  dynamicTools: any[] = [],
): any {
  const client = clientTools(dynamicTools).find((tool) => tool.piName === name)
  if (client)
    return {
      type: 'dynamicToolCall',
      id,
      namespace: client.namespace,
      tool: client.name,
      arguments: args,
      status: 'inProgress',
      contentItems: null,
      success: null,
      durationMs: null,
    }
  if (name === 'bash')
    return {
      type: 'commandExecution',
      id,
      command: args.command ?? '',
      cwd,
      processId: null,
      source: 'agent',
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    }
  if (name === 'write' || name === 'edit')
    return { type: 'fileChange', id, status: 'inProgress', changes: [] }
  if (name === 'subagent')
    return {
      type: 'collabAgentToolCall',
      id,
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: threadId,
      receiverThreadIds: [],
      prompt: args.prompt ?? null,
      model: args.model ?? null,
      reasoningEffort: args.thinking ?? null,
      agentsStates: {},
    }
  return {
    type: 'mcpToolCall',
    id,
    server: name.startsWith('mcp__') ? name.split('__')[1] : 'pi',
    tool: name,
    status: 'inProgress',
    arguments: args,
    result: null,
    error: null,
    durationMs: null,
  }
}
export function finishTool(item: any, result: any, isError: boolean, args: any): void {
  item.status = isError ? 'failed' : 'completed'
  const text = textContent(result?.content)
  if (item.type === 'dynamicToolCall') {
    item.success = !isError
    item.contentItems = result?.details?.contentItems ?? [{ type: 'inputText', text }]
    return
  }
  if (item.type === 'commandExecution') {
    item.aggregatedOutput = text
    item.exitCode = result?.details?.exitCode ?? (isError ? 1 : 0)
  } else if (item.type === 'fileChange') {
    if (!isError && !item.changes.length)
      item.changes = [
        {
          path: args.path ?? '',
          kind: { type: 'update', move_path: null },
          diff: result?.details?.patch ?? '',
        },
      ]
  } else if (item.type === 'mcpToolCall') {
    item.result = {
      content: result?.content ?? [],
      structuredContent: result?.details ?? null,
      _meta: null,
    }
    item.error = isError ? { message: text } : null
  } else if (item.type === 'collabAgentToolCall' && result?.details?.agentId) {
    const id = result.details.agentId
    item.receiverThreadIds = [id]
    const status = result.details.status
    item.agentsStates = {
      [id]: {
        status:
          isError || ['failed', 'error'].includes(status)
            ? 'errored'
            : ['background', 'running', 'queued'].includes(status)
              ? 'running'
              : status === 'stopped'
                ? 'shutdown'
                : 'completed',
        message: text || null,
      },
    }
  }
}
export function projectHistory(entries: any[], thread: PiThread): PiTurn[] {
  const turns: PiTurn[] = []
  let turn: PiTurn | undefined
  let ended = false
  const pendingClientIds: string[] = []
  const calls = new Map<string, { item: any; args: any }>()
  for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === 'tyrs-file-change') {
      const call = calls.get(entry.data.id)
      if (call) call.item.changes = entry.data.changes
    }
    if (entry.type === 'custom' && entry.customType === 'subagents:record') {
      for (const previous of turns)
        for (const item of previous.items)
          if (item.type === 'collabAgentToolCall' && item.receiverThreadIds.includes(entry.data.id))
            item.agentsStates = {
              [entry.data.id]: {
                status: entry.data.error
                  ? 'errored'
                  : entry.data.status === 'stopped'
                    ? 'shutdown'
                    : 'completed',
                message: entry.data.error ?? entry.data.result ?? null,
              },
            }
    }
    if (entry.type === 'custom' && entry.customType === 'tyrs-turn') {
      turn = {
        ...entry.data,
        items: [],
        status: 'interrupted',
        error: null,
        completedAt: null,
        durationMs: null,
      }
      turns.push(turn!)
      ended = false
      pendingClientIds.length = 0
      if (entry.data.clientId) pendingClientIds.push(entry.data.clientId)
    }
    if (entry.type === 'custom' && entry.customType === 'tyrs-steer' && entry.data.clientId)
      pendingClientIds.push(entry.data.clientId)
    if (
      entry.type === 'custom' &&
      entry.customType === 'tyrs-turn-end' &&
      turn &&
      turn.id === entry.data?.id
    ) {
      Object.assign(turn, entry.data)
      ended = true
    }
    if (entry.type === 'compaction') {
      if (!turn || ended) {
        const at = Date.parse(entry.timestamp)
        turn = {
          id: `native:${entry.id}`,
          items: [],
          status: 'completed',
          error: null,
          startedAt: at,
          completedAt: at,
          durationMs: 0,
        }
        turns.push(turn)
      }
      turn.items.push({ type: 'contextCompaction', id: `compact:${entry.id}` })
    }
    if (entry.type !== 'message') continue
    const msg = entry.message
    if (
      !turn ||
      ended ||
      (msg.role === 'user' && turn.items.length && (ended || !turn.id.startsWith('tyrs:')))
    ) {
      turn = {
        id: `native:${entry.id}`,
        items: [],
        status: 'completed',
        error: null,
        startedAt: msg.timestamp ?? Date.parse(entry.timestamp),
        completedAt: null,
        durationMs: null,
      }
      turns.push(turn)
      ended = false
    }
    for (const item of messageItems(msg)) {
      if (item.type === 'userMessage') item.clientId = pendingClientIds.shift() ?? null
      turn.items.push(item)
    }
    if (msg.role === 'assistant')
      for (const c of msg.content ?? [])
        if (c.type === 'toolCall') {
          const item = toolItem(
            c.id,
            c.name,
            c.arguments,
            thread.cwd,
            thread.id,
            thread.dynamicTools,
          )
          calls.set(c.id, { item, args: c.arguments })
          turn.items.push(item)
        }
    if (msg.role === 'toolResult') {
      const call = calls.get(msg.toolCallId)
      if (call) finishTool(call.item, msg, msg.isError, call.args)
      if (msg.details?.source === 'plan_mode_complete')
        turn.items.push({ type: 'plan', id: `plan:${msg.toolCallId}`, text: msg.details.plan })
    }
    turn.completedAt = msg.timestamp ?? Date.parse(entry.timestamp)
    turn.durationMs = turn.completedAt! - turn.startedAt
  }
  return turns
}

// 索引只读取 JSONL；禁止调用可能迁移/修复会话文件的 SessionManager.open。
export async function discoverSessions(
  directory: string,
  files = new NativeFiles(),
): Promise<Array<{ thread: PiThread; entries: any[] }>> {
  const found: Array<{ thread: PiThread; entries: any[] }> = []
  const walk = async (dir: string): Promise<void> => {
    let names: import('node:fs').Dirent[]
    try {
      names = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const name of names) {
      const path = join(dir, name.name)
      if (name.isDirectory()) {
        await walk(path)
        continue
      }
      if (!name.name.endsWith('.jsonl') || !name.isFile()) continue
      try {
        const entries = files.read(path)
        const header = entries[0]
        if (
          header?.type !== 'session' ||
          typeof header.id !== 'string' ||
          typeof header.cwd !== 'string'
        )
          continue
        const nameEntry = entries.filter((e) => e.type === 'session_info').at(-1)
        const first = entries.find((e) => e.type === 'message' && e.message.role === 'user')
        const branch = nativeBranch(entries)
        const model = branch.filter((e) => e.type === 'model_change').at(-1)
        const effort = branch
          .filter((e) => e.type === 'thinking_level_change')
          .at(-1)?.thinkingLevel
        const plan = branch
          .filter((e) => e.type === 'custom' && e.customType === 'plan-mode-state')
          .at(-1)?.data
        found.push({
          thread: {
            id: header.id,
            path,
            cwd: header.cwd,
            name: nameEntry?.name ?? null,
            preview: textContent(first?.message?.content).slice(0, 200),
            createdAt: Math.floor(Date.parse(header.timestamp) / 1000),
            updatedAt: Math.floor(Date.parse(entries.at(-1).timestamp ?? header.timestamp) / 1000),
            ephemeral: false,
            model: model ? `${model.provider}/${model.modelId}` : null,
            effort: effort ?? null,
            planMode: plan?.enabled ?? false,
            dynamicTools: [],
            forkedFromId: null,
            // gotgenes 使用原生父会话 ID；Pi fork 使用文件路径，不能混为子代理。
            parentThreadId:
              typeof header.parentSession === 'string' &&
              /^[0-9a-f-]{36}$/i.test(header.parentSession)
                ? header.parentSession
                : null,
          },
          entries,
        })
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
    }
  }
  await walk(directory)
  return found
}
