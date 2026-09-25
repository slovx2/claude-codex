import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openAIOnlyRequests } from './fixtures/capability-cases.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'
import { validatePayload } from './fixtures/schema-contract.mjs'

test('CAPABILITY-001：OpenAI 专属能力明确拒绝且不触发模型', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-capability-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    for (const [method, params] of openAIOnlyRequests) {
      validatePayload(method, 'Params', params)
      const response = await client.raw(method, params)
      assert.equal(response.error.code, -32004, method)
      assert.equal(response.result, undefined)
    }
    assert.deepEqual(await client.request('account/read', {}), {
      account: null,
      requiresOpenaiAuth: false,
    })
    const catalog = await client.request('model/list', { limit: 100 })
    validatePayload('model/list', 'Response', catalog)
    assert.ok(catalog.data.length > 0)
    for (const option of catalog.data) {
      // 手机参数面板依赖完整的 0.147.0 模型字段；Claude 不伪装 OpenAI 服务等级。
      assert.deepEqual(option.serviceTiers, [])
      assert.equal(option.defaultServiceTier, null)
      assert.equal(option.modelSpecialty, null)
      assert.ok(option.supportedReasoningEfforts.length > 0)
    }
    assert.equal((await client.raw('unknown/protocol')).error.code, -32601)
    assert.equal(
      (await client.raw('thread/start', { cwd: home, model: 'gpt-5.6' })).error.code,
      -32602,
    )
    assert.equal(model.requests.length, 0)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('APPROVAL-003：真实 AskUserQuestion 回调答案进入下一轮模型上下文', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-question-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    let answers = 0
    client.onServerRequest = async (method, params) => {
      assert.equal(method, 'item/tool/requestUserInput')
      assert.equal(params.questions.length, 1)
      answers++
      return { answers: { [params.questions[0].id]: { answers: ['Blue'] } } }
    }
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: 'toolu_question',
        name: 'AskUserQuestion',
        input: {
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
        .filter((block: any) => block.type === 'tool_result')
      assert.match(JSON.stringify(results), /Blue/)
      return [{ type: 'text', text: 'SELECTED_BLUE' }]
    })
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'on-request',
      sandbox: 'danger-full-access',
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'Ask the color' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    assert.equal(answers, 1)
    assert.equal(client.trace.filter((item) => item.method === 'serverRequest/resolved').length, 1)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
