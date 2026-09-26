import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { saveArtifact } from './fixtures/artifacts.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

type InputTool = 'AskUserQuestion' | 'ExitPlanMode'

async function verifyNaturalTimeout(toolName: InputTool): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'native-input-timeout-'))
  const target = join(home, 'must-not-write.txt')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  let release!: () => void, answered!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const replied = new Promise<void>((resolve) => {
    answered = resolve
  })
  let requestedAt = 0
  const inputID = 'toolu_natural_input_timeout'
  try {
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/tool/requestUserInput')
      requestedAt = Date.now()
      await held
      answered()
      return {
        answers: {
          [params.questions[0].id]: {
            answers: [toolName === 'ExitPlanMode' ? '执行计划' : 'LATE_TIMEOUT_ANSWER'],
          },
        },
      }
    }
    if (toolName === 'ExitPlanMode')
      model.enqueue(() => [
        {
          type: 'tool_use',
          id: 'toolu_enter_timeout_plan',
          name: 'EnterPlanMode',
          input: {},
        },
      ])
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: inputID,
        name: toolName,
        input:
          toolName === 'ExitPlanMode'
            ? {}
            : {
                questions: [
                  {
                    question: 'Which color?',
                    header: 'Color',
                    multiSelect: false,
                    options: [
                      { label: 'Blue', description: 'Use blue' },
                      { label: 'Red', description: 'Use red' },
                    ],
                  },
                ],
              },
      },
    ])
    model.enqueue((request) => {
      const results = request.messages
        .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
        .filter((block: any) => block.type === 'tool_result' && block.tool_use_id === inputID)
      assert.equal(results.length, 1, '真实 CLI 必须收到唯一超时工具结果')
      assert.equal(results[0].is_error, true, '没有用户答案时不得假成功')
      assert.doesNotMatch(JSON.stringify(request.messages), /LATE_TIMEOUT_ANSWER/)
      if (toolName === 'ExitPlanMode')
        return [
          {
            type: 'tool_use',
            id: 'toolu_after_timeout_write',
            name: 'Write',
            input: { file_path: target, content: '禁止未确认计划产生副作用' },
          },
        ]
      return [{ type: 'text', text: 'NATURAL_TIMEOUT_HANDLED' }]
    })
    if (toolName === 'ExitPlanMode')
      model.enqueue((request) => {
        const results = request.messages
          .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
          .filter(
            (block: any) =>
              block.type === 'tool_result' && block.tool_use_id === 'toolu_after_timeout_write',
          )
        assert.equal(results.length, 1)
        assert.equal(results[0].is_error, true, '退出确认超时后真实 Write 必须继续被计划权限拒绝')
        return [{ type: 'text', text: 'PLAN_TIMEOUT_HANDLED' }]
      })
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '等待真实用户回答，不得猜测或自动确认' }],
    })
    // 正式 PendingInteractions 的默认期限为120秒；不得缩短timer替代这条验收。
    const deadline = Date.now() + 160_000
    let terminal: any
    while (Date.now() < deadline) {
      terminal = client.trace.find(
        (event) => event.method === 'turn/completed' && event.params.turn.id === turn.id,
      )
      if (terminal) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.ok(terminal, '自然超时后必须有回合终态')
    const elapsedMs = Date.now() - requestedAt
    assert.ok(requestedAt > 0 && elapsedMs >= 119_500, '必须真正经过默认120秒等待')
    assert.ok(elapsedMs < 150_000, '超时之后必须有界完成')
    assert.equal((await client.completed(turn.id)).status, 'completed')
    release()
    await replied
    await new Promise((resolve) => setTimeout(resolve, 100))
    const history = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    const stored = history.thread.turns[0]
    const input = stored.items.find(
      (item: any) => item.type === 'dynamicToolCall' && item.tool === toolName,
    )
    const request = client.trace.find((event) => event.method === 'item/tool/requestUserInput')
    const resolved = client.trace.filter(
      (event) => event.method === 'serverRequest/resolved' && event.params.requestId === request.id,
    )
    const starts = client.trace.filter(
      (event) => event.method === 'item/started' && event.params.turnId === turn.id,
    )
    const ends = client.trace.filter(
      (event) => event.method === 'item/completed' && event.params.turnId === turn.id,
    )
    await saveArtifact('natural-input-timeout', {
      toolName,
      elapsedMs,
      threadId: thread.id,
      turnId: turn.id,
      requestId: request.id,
      modelRequests: model.requests.length,
      status: stored.status,
      items: stored.items.map((item: any) => ({
        id: item.id,
        type: item.type,
        tool: item.tool,
        status: item.status,
        success: item.success,
      })),
      startedIDs: starts.map((event) => event.params.item.id),
      completedIDs: ends.map((event) => event.params.item.id),
    })
    assert.equal(history.thread.status.type, 'idle')
    assert.equal(input.status, 'failed', '自然超时不能留下进行中的提问条目')
    assert.equal(input.success, false)
    assert.match(JSON.stringify(input.contentItems), /超时/)
    assert.ok(stored.items.every((item: any) => item.status !== 'inProgress'))
    assert.equal(resolved.length, 1)
    const terminalIndex = client.trace.indexOf(terminal)
    const inputEnd = ends.filter((event) => event.params.item.id === input.id)
    assert.equal(inputEnd.length, 1)
    assert.ok(client.trace.indexOf(resolved[0]) < client.trace.indexOf(inputEnd[0]))
    assert.ok(client.trace.indexOf(inputEnd[0]) < terminalIndex)
    assert.equal(new Set(starts.map((event) => event.params.item.id)).size, starts.length)
    assert.equal(new Set(ends.map((event) => event.params.item.id)).size, ends.length)
    assert.deepEqual(
      starts.map((event) => event.params.item.id).sort(),
      ends.map((event) => event.params.item.id).sort(),
    )
    assert.ok(ends.every((event) => client.trace.indexOf(event) < terminalIndex))
    assert.equal(
      client.trace.filter(
        (event) => event.method === 'turn/completed' && event.params.turn.id === turn.id,
      ).length,
      1,
    )
    await assert.rejects(access(target), { code: 'ENOENT' })
    assert.equal(
      model.requests.length,
      toolName === 'ExitPlanMode' ? 4 : 2,
      '迟到回答不能唤醒模型或执行工具',
    )
    if (toolName === 'ExitPlanMode') {
      await client.request('thread/resume', { threadId: thread.id })
      const settings = client.trace
        .filter((event) => event.method === 'thread/settings/updated')
        .at(-1)
      assert.equal(settings.params.threadSettings.collaborationMode.mode, 'plan')
    }
    model.assertConsumed()
  } finally {
    release()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('APPROVAL-007 / EVENTS-006：真实提问与退出计划自然超时，迟到回答不执行且事件历史闭合', {
  timeout: 180_000,
}, async () => {
  // 两个独立 HOME/模型/适配器并发等待，既保留真实期限也避免串行叠加四分钟。
  const results = await Promise.allSettled([
    verifyNaturalTimeout('AskUserQuestion'),
    verifyNaturalTimeout('ExitPlanMode'),
  ])
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  )
  if (failures.length) throw new AggregateError(failures, '真实交互自然超时验收失败')
})
