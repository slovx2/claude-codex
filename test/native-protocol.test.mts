import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('CONTEXT-002：原生压缩后重启恢复使用压缩上下文', { timeout: 90_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-compaction-'))
  const model = new MockLLM()
  const url = await model.start()
  let client = await ProtocolClient.start(home, url)
  try {
    model.enqueue(() => [{ type: 'text', text: 'BEFORE_COMPACT_RESPONSE' }])
    const { thread } = await client.request('thread/start', { cwd: home })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'COMPACT_ORIGINAL_INPUT' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages), /COMPACT_ORIGINAL_INPUT/)
      return [{ type: 'text', text: 'NATIVE_COMPACT_SUMMARY: Continue the fixture task.' }]
    })
    await client.request('thread/compact/start', { threadId: thread.id })
    const started = await client.notification(
      'turn/started',
      (params) => params.turn.id !== turn.id,
    )
    const completed = await client.completed(started.turn.id)
    assert.equal(completed.status, 'completed', JSON.stringify(completed))
    await client.notification('thread/compacted')
    await client.close()
    client = await ProtocolClient.start(home, url)
    model.enqueue((request) => {
      const context = JSON.stringify(request.messages)
      assert.match(context, /NATIVE_COMPACT_SUMMARY/)
      assert.doesNotMatch(context, /COMPACT_ORIGINAL_INPUT/)
      return [{ type: 'text', text: 'AFTER_COMPACTION' }]
    })
    const next = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '继续压缩后的任务' }],
    })
    assert.equal((await client.completed(next.turn.id)).status, 'completed')
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

for (const status of [429, 500, 503]) {
  test(`FAILURE-${status}：失败终结，重复提交不触发模型重放`, { timeout: 60_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), `native-failure-${status}-`))
    const model = new MockLLM()
    const client = await ProtocolClient.start(home, await model.start())
    try {
      model.enqueue(() => ({ status, message: `MOCK_ERROR_${status}` }))
      const { thread } = await client.request('thread/start', { cwd: home })
      const params = {
        threadId: thread.id,
        clientUserMessageId: `failure-${status}`,
        input: [{ type: 'text', text: '不能重放失败提交' }],
      }
      const { turn } = await client.request('turn/start', params)
      assert.equal((await client.completed(turn.id)).status, 'failed')
      assert.equal((await client.request('turn/start', params)).turn.id, turn.id)
      assert.equal(model.requests.length, 1)
      assert.equal(client.trace.filter((item) => item.method === 'turn/completed').length, 1)
      model.assertConsumed()
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}

test('FAILURE-SSE：半断流不得成功终结或自动重放', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-disconnect-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    model.enqueue(() => ({ disconnect: true }))
    const { thread } = await client.request('thread/start', { cwd: home })
    const params = {
      threadId: thread.id,
      clientUserMessageId: 'uncertain-stream',
      input: [{ type: 'text', text: '半断流测试' }],
    }
    const { turn } = await client.request('turn/start', params)
    assert.equal((await client.completed(turn.id)).status, 'failed')
    assert.equal((await client.request('turn/start', params)).turn.id, turn.id)
    assert.equal(model.requests.length, 1)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('FAILURE-401：真实 SDK 认证错误失败终结且不自动重放', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-failure-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    model.enqueue(() => ({ status: 401, message: 'MOCK_INVALID_KEY' }))
    const { thread } = await client.request('thread/start', { cwd: home })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '认证失败测试' }],
    })
    const completed = await client.completed(turn.id)
    assert.equal(completed.status, 'failed')
    assert.ok(completed.error)
    assert.equal(model.requests.length, 1, '模型失败不得自动重放')
    assert.equal(client.trace.filter((item) => item.method === 'turn/completed').length, 1)
    assert.equal(client.trace.filter((item) => item.method === 'item/tool/call').length, 0)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('CONTEXT-001 / SUBMIT-001 / HISTORY-001：真实 SDK 恢复、回退、重试与分页', {
  timeout: 180_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-contract-'))
  const model = new MockLLM()
  const url = await model.start()
  let client = await ProtocolClient.start(home, url)
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      historyMode: 'paginated',
      model: 'claude-sonnet-4-6',
    })
    assert.equal(thread.historyMode, 'paginated')
    const start = async (text: string, messageId: string) => {
      const params = {
        threadId: thread.id,
        clientUserMessageId: messageId,
        input: [{ type: 'text', text }],
      }
      const { turn } = await client.request('turn/start', params)
      const end = await client.completed(turn.id)
      assert.equal(end.status, 'completed', JSON.stringify(end))
      return { params, turn }
    }
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages), /KEEP_ALPHA/)
      return [{ type: 'text', text: 'ANSWER_ALPHA' }]
    })
    const first = await start('KEEP_ALPHA', 'msg-a')
    assert.equal((await client.request('turn/start', first.params)).turn.id, first.turn.id)
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages), /ANSWER_ALPHA/)
      assert.match(JSON.stringify(request.messages), /DROP_BETA/)
      return [{ type: 'text', text: 'ANSWER_BETA' }]
    })
    const second = await start('DROP_BETA', 'msg-b')
    const page = await client.request('thread/turns/list', {
      threadId: thread.id,
      limit: 1,
      sortDirection: 'asc',
      itemsView: 'summary',
    })
    assert.equal(page.data.length, 1)
    assert.equal(page.data[0].id, first.turn.id)
    const next = await client.request('thread/turns/list', {
      threadId: thread.id,
      limit: 1,
      sortDirection: 'asc',
      cursor: page.nextCursor,
    })
    assert.equal(next.data[0].id, second.turn.id)
    const backwards = await client.request('thread/turns/list', {
      threadId: thread.id,
      sortDirection: 'desc',
      cursor: next.backwardsCursor,
    })
    assert.equal(backwards.data[0].id, second.turn.id)
    const items = await client.request('thread/items/list', {
      threadId: thread.id,
      turnId: first.turn.id,
    })
    assert.equal(items.data[0].item.clientId, 'msg-a')
    assert.ok(items.data.every((item: any) => item.turnId === first.turn.id))
    const resume = await client.request('thread/resume', {
      threadId: thread.id,
      excludeTurns: true,
      initialTurnsPage: { limit: 1, itemsView: 'notLoaded' },
    })
    assert.equal(resume.initialTurnsPage.data.length, 1)
    assert.equal(model.requests.length, 2, '读历史不能调用模型')
    const fork = await client.request('thread/fork', { threadId: thread.id })
    assert.notEqual(fork.thread.sessionId, thread.sessionId)
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages), /KEEP_ALPHA/)
      assert.match(JSON.stringify(request.messages), /ANSWER_BETA/)
      return [{ type: 'text', text: 'ONLY_ON_FORK' }]
    })
    const branch = await client.request('turn/start', {
      threadId: fork.thread.id,
      input: [{ type: 'text', text: 'FORK_INPUT' }],
    })
    assert.equal((await client.completed(branch.turn.id)).status, 'completed')
    await client.close()
    client = await ProtocolClient.start(home, url)
    assert.equal((await client.request('turn/start', first.params)).turn.id, first.turn.id)
    assert.equal(
      (await client.raw('turn/start', { ...first.params, input: [{ type: 'text', text: '冲突' }] }))
        .error.code,
      -32009,
    )
    await client.request('thread/rollback', { threadId: thread.id, numTurns: 1 })
    model.enqueue((request) => {
      const history = JSON.stringify(request.messages)
      assert.match(history, /KEEP_ALPHA/)
      assert.doesNotMatch(history, /DROP_BETA|ANSWER_BETA/)
      assert.doesNotMatch(history, /FORK_INPUT|ONLY_ON_FORK/)
      return [{ type: 'text', text: 'AFTER_ROLLBACK' }]
    })
    await start('CONTINUE_GAMMA', 'msg-c')
    assert.equal((await client.raw('unknown/protocol')).error.code, -32601)
    assert.equal((await client.raw('thread/start', { model: 'gpt-5.6' })).error.code, -32602)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

for (const mode of ['read-only', 'plan']) {
  test(`PERMISSION-${mode}：真实 CLI 不得写入文件`, { timeout: 60_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-permission-'))
    const model = new MockLLM()
    const client = await ProtocolClient.start(home, await model.start())
    try {
      const file = join(home, 'forbidden.txt')
      model.enqueue(() => [
        {
          type: 'tool_use',
          id: 'toolu_denied',
          name: 'Write',
          input: { file_path: file, content: 'FORBIDDEN' },
        },
      ])
      model.enqueue((request) => {
        const history = JSON.stringify(request.messages)
        assert.match(history, /tool_result/)
        assert.match(history, /只允许读取|permission|denied|not allowed/i)
        return [{ type: 'text', text: 'DENIED' }]
      })
      const { thread } = await client.request('thread/start', {
        cwd: home,
        sandbox: mode === 'plan' ? 'danger-full-access' : 'read-only',
        approvalPolicy: 'never',
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '尝试写入' }],
        planMode: mode === 'plan',
      })
      const completed = await client.completed(turn.id)
      assert.equal(completed.status, 'completed', JSON.stringify(completed))
      await assert.rejects(access(file))
      model.assertConsumed()
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}

test('TOOLS-001：真实 SDK 动态工具声明、回调、文件副作用和模型 tool_result', {
  timeout: 100_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-tools-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    let calls = 0
    const artifact = join(home, 'tool-result.txt')
    client.onTool = async (params) => {
      calls++
      assert.equal(params.callId, 'toolu_fixture')
      assert.equal(params.namespace, 'test_files')
      assert.equal(params.tool, 'write_fixture')
      assert.deepEqual(params.arguments, { text: 'SIDE_EFFECT' })
      await writeFile(artifact, params.arguments.text)
      return { success: true, contentItems: [{ type: 'inputText', text: 'FILE_WRITTEN' }] }
    }
    model.enqueue((request) => {
      const tool = request.tools.find((entry: any) => entry.name.startsWith('mcp__tyrs_hand__'))
      assert.ok(
        tool,
        `动态工具必须真正进入模型请求: ${JSON.stringify(request.tools.map((entry: any) => ({ name: entry.name, description: entry.description?.slice(0, 60) })))}`,
      )
      assert.equal(tool.input_schema.properties.text.type, 'string')
      return [
        { type: 'tool_use', id: 'toolu_fixture', name: tool.name, input: { text: 'SIDE_EFFECT' } },
      ]
    })
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages), /FILE_WRITTEN/)
      return [{ type: 'text', text: 'DONE' }]
    })
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      dynamicTools: [
        {
          type: 'namespace',
          name: 'test_files',
          description: '文件工具',
          tools: [
            {
              type: 'function',
              name: 'write_fixture',
              description: '测试：写入临时文件',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
                additionalProperties: false,
              },
            },
          ],
        },
      ],
    })
    const params = {
      threadId: thread.id,
      clientUserMessageId: 'tool-msg',
      input: [{ type: 'text', text: '执行测试工具' }],
    }
    const { turn } = await client.request('turn/start', params)
    const completed = await client.completed(turn.id)
    assert.equal(
      completed.status,
      'completed',
      JSON.stringify({ completed, unexpected: model.unexpected, stderr: client.stderr }),
    )
    await client.request('turn/start', params)
    assert.equal(calls, 1)
    assert.equal(await readFile(artifact, 'utf8'), 'SIDE_EFFECT')
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
