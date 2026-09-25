import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

function result(request: ModelRequest, id: string): any {
  const block = request.messages
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .find((b: any) => b.type === 'tool_result' && b.tool_use_id === id)
  assert.ok(block, `缺少原生工具结果 ${id}`)
  return block
}

const tool = (name: string, id: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id,
  name,
  input,
})

test('PLAN-002：AI 进入计划、原生计划文件、重启恢复和显式退出', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-enter-plan-'))
  const model = new MockLLM()
  const url = await model.start()
  let client = await ProtocolClient.start(home, url)
  try {
    const modes = await client.request('collaborationMode/list')
    assert.deepEqual(
      modes.data.map((x: any) => x.mode),
      ['default', 'plan'],
    )
    model.enqueue(() => [tool('EnterPlanMode', 'toolu_enter', {})])
    model.enqueue((request) => {
      assert.notEqual(result(request, 'toolu_enter').is_error, true)
      return [
        tool('Write', 'toolu_plan_file', {
          file_path: join(home, 'adapter', 'plans', threadId, 'test-plan.md'),
          content: '# 可执行计划\n1. 写入结果\n2. 验证文件',
        }),
      ]
    })
    model.enqueue((request) => {
      assert.notEqual(result(request, 'toolu_plan_file').is_error, true)
      return [{ type: 'text', text: '请确认计划' }]
    })
    const { thread } = await client.request('thread/start', {
      cwd: home,
      permissions: ':danger-full-access',
    })
    const threadId = thread.id
    const first = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: '先进入计划模式' }],
    })
    assert.equal((await client.completed(first.turn.id)).status, 'completed')
    assert.ok(
      client.trace.some(
        (x) =>
          x.method === 'thread/settings/updated' &&
          x.params.threadSettings.collaborationMode.mode === 'plan',
      ),
    )
    const history = await client.request('thread/read', { threadId, includeTurns: true })
    assert.ok(
      history.thread.turns[0].items.some(
        (i: any) => i.type === 'plan' && i.text.includes('可执行计划'),
      ),
    )
    await client.close()
    client = await ProtocolClient.start(home, url)
    await client.request('thread/resume', { threadId })
    model.enqueue(() => [
      tool('Write', 'toolu_blocked', { file_path: join(home, 'blocked.txt'), content: '禁止' }),
    ])
    model.enqueue((request) => {
      assert.equal(result(request, 'toolu_blocked').is_error, true)
      return [{ type: 'text', text: '等待执行确认' }]
    })
    const second = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: '恢复会话' }],
    })
    assert.equal((await client.completed(second.turn.id)).status, 'completed')
    await assert.rejects(access(join(home, 'blocked.txt')))
    model.enqueue(() => [
      tool('Write', 'toolu_after_exit', { file_path: join(home, 'done.txt'), content: '已执行' }),
    ])
    model.enqueue((request) => {
      assert.notEqual(result(request, 'toolu_after_exit').is_error, true)
      return [{ type: 'text', text: '完成' }]
    })
    const third = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: '执行计划' }],
      collaborationMode: {
        mode: 'default',
        settings: {
          model: 'claude-sonnet-4-6',
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    })
    assert.equal((await client.completed(third.turn.id)).status, 'completed')
    assert.equal(await readFile(join(home, 'done.txt'), 'utf8'), '已执行')
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

for (const scenario of [
  { execute: true, readOnly: false },
  { execute: false, readOnly: false },
  { execute: true, readOnly: true },
]) {
  const { execute, readOnly } = scenario
  const canWrite = execute && !readOnly
  test((readOnly ? '只读配置 ' : '') +
    `PLAN-001：计划提问、计划输出、${execute ? '确认退出并执行' : '拒绝退出保持只读'}`, {
    timeout: 60_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-plan-'))
    const model = new MockLLM()
    const client = await ProtocolClient.start(home, await model.start())
    const path = join(home, 'executed.txt')
    const early = join(home, 'premature.txt')
    try {
      let answers = 0
      client.onServerRequest = async (method, params) => {
        assert.equal(method, 'item/tool/requestUserInput')
        answers++
        const q = params.questions[0]
        return {
          answers: {
            [q.id]: { answers: [answers === 1 ? 'Blue' : execute ? '执行计划' : '继续规划'] },
          },
        }
      }
      model.enqueue(() => [
        tool('AskUserQuestion', 'toolu_question', {
          questions: [
            {
              question: 'Which color?',
              header: 'Color',
              multiSelect: false,
              options: [
                { label: 'Blue', description: 'Blue' },
                { label: 'Red', description: 'Red' },
              ],
            },
          ],
        }),
      ])
      model.enqueue((request) => {
        assert.notEqual(result(request, 'toolu_question').is_error, true)
        assert.match(JSON.stringify(result(request, 'toolu_question')), /Blue/)
        return [tool('Write', 'toolu_early', { file_path: early, content: 'forbidden' })]
      })
      model.enqueue((request) => {
        assert.equal(result(request, 'toolu_early').is_error, true)
        return [
          { type: 'text', text: '计划：写入蓝色结果，然后验证文件。' },
          tool('ExitPlanMode', 'toolu_exit', {}),
        ]
      })
      model.enqueue((request) => {
        assert.equal(result(request, 'toolu_exit').is_error === true, !execute)
        return [tool('Write', 'toolu_write', { file_path: path, content: 'Blue' })]
      })
      model.enqueue((request) => {
        assert.equal(result(request, 'toolu_write').is_error === true, !canWrite)
        return [{ type: 'text', text: execute ? '执行完成' : '等待确认' }]
      })
      const { thread } = await client.request('thread/start', {
        cwd: home,
        permissions: readOnly ? ':read-only' : ':danger-full-access',
      })
      await client.request('thread/settings/update', {
        threadId: thread.id,
        collaborationMode: {
          mode: 'plan',
          settings: {
            model: 'claude-sonnet-4-6',
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '制定计划并等待确认' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      assert.equal(answers, 2)
      await assert.rejects(access(early))
      if (canWrite) assert.equal(await readFile(path, 'utf8'), 'Blue')
      else await assert.rejects(access(path))
      const modes = client.trace
        .filter((x) => x.method === 'thread/settings/updated')
        .map((x) => x.params.threadSettings.collaborationMode.mode)
      assert.equal(modes.at(-1), execute ? 'default' : 'plan')
      const history = await client.request('thread/read', {
        threadId: thread.id,
        includeTurns: true,
      })
      assert.ok(
        history.thread.turns[0].items.some(
          (i: any) => i.type === 'plan' && i.text.includes('蓝色'),
        ),
      )
      model.assertConsumed()
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}

for (const decision of ['accept', 'decline', 'cancel', 'full-access']) {
  test(`APPROVAL-004：真实文件审批 ${decision} 验证副作用`, { timeout: 60_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-approval-'))
    const model = new MockLLM()
    const client = await ProtocolClient.start(home, await model.start())
    const path = join(home, 'approved.txt')
    try {
      let approvals = 0
      client.onServerRequest = async (method) => {
        assert.equal(method, 'item/fileChange/requestApproval')
        approvals++
        return { decision }
      }
      model.enqueue(() => [tool('Write', 'toolu_write', { file_path: path, content: 'approved' })])
      model.enqueue((request) => {
        assert.equal(
          result(request, 'toolu_write').is_error === true,
          decision === 'decline' || decision === 'cancel',
        )
        return [{ type: 'text', text: '完成' }]
      })
      const { thread } = await client.request('thread/start', {
        cwd: home,
        sandbox: 'danger-full-access',
        approvalPolicy: decision === 'full-access' ? 'never' : 'on-request',
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '写入文件' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      assert.equal(approvals, decision === 'full-access' ? 0 : 1)
      if (decision === 'accept' || decision === 'full-access')
        assert.equal(await readFile(path, 'utf8'), 'approved')
      else await assert.rejects(access(path))
      model.assertConsumed()
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}
