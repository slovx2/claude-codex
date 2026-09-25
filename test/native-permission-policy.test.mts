import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  type ApprovalPolicy,
  allowsApproval,
  approvalFlows,
  isApprovalPolicy,
} from '../src/approval-policy.mjs'
import { normalizeDecision } from '../src/server-helpers.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

const granular = (enabled: boolean): ApprovalPolicy => ({
  granular: {
    sandbox_approval: true,
    rules: enabled,
    skill_approval: false,
    request_permissions: false,
    mcp_elicitations: false,
  },
})

test('未提供的策略修订对象和未知审批不能静默升级为会话授权', () => {
  for (const decision of [
    { acceptWithExecpolicyAmendment: {} },
    { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'deny' } } },
    'allow-all',
    null,
  ])
    assert.equal(normalizeDecision({ decision }), 'decline')
  assert.equal(normalizeDecision({ decision: 'acceptForSession' }), 'acceptForSession')
})

test('审批策略严格遵循固定 schema，未知值和旧别名不扩大权限', () => {
  for (const value of ['on-request', 'untrusted', 'never', granular(true)])
    assert.equal(isApprovalPolicy(value), true)
  for (const value of [
    'on-failure',
    'unless-trusted',
    'always',
    [],
    {},
    { granular: { rules: true } },
    { granular: { ...(granular(true) as any).granular, rules: 'true' } },
  ])
    assert.equal(isApprovalPolicy(value), false)
  for (const flow of approvalFlows) assert.equal(allowsApproval('never', flow), false)
  assert.equal(allowsApproval(granular(false), 'rules'), false)
  assert.equal(allowsApproval(granular(true), 'rules'), true)
})

const cases: Array<{
  name: string
  policy: ApprovalPolicy
  sandbox: string
  writes: boolean
  approvals: number
}> = [
  {
    name: 'untrusted 发起用户审批',
    policy: 'untrusted',
    sandbox: 'danger-full-access',
    writes: true,
    approvals: 1,
  },
  {
    name: 'never 加只读禁止写入',
    policy: 'never',
    sandbox: 'read-only',
    writes: false,
    approvals: 0,
  },
  {
    name: '细粒度规则关闭则拒绝',
    policy: granular(false),
    sandbox: 'danger-full-access',
    writes: false,
    approvals: 0,
  },
  {
    name: '细粒度规则开启可审批',
    policy: granular(true),
    sandbox: 'danger-full-access',
    writes: true,
    approvals: 1,
  },
]

for (const scenario of cases) {
  test('PERMISSION-004：' + scenario.name + '，重启后保留相同策略', {
    timeout: 60_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-policy-'))
    const model = new MockLLM()
    const url = await model.start()
    let client = await ProtocolClient.start(home, url)
    try {
      const { thread } = await client.request('thread/start', {
        cwd: home,
        approvalPolicy: scenario.policy,
        sandbox: scenario.sandbox,
      })
      await client.close()
      client = await ProtocolClient.start(home, url)
      const resumed = await client.request('thread/resume', { threadId: thread.id })
      assert.deepEqual(resumed.approvalPolicy, scenario.policy)
      let approvals = 0
      client.onServerRequest = async (method) => {
        assert.equal(method, 'item/fileChange/requestApproval')
        approvals++
        return { decision: 'accept' }
      }
      const target = join(home, 'permission-output.txt')
      model.enqueue(() => [
        {
          type: 'tool_use',
          id: 'toolu_policy_write',
          name: 'Write',
          input: { file_path: target, content: 'policy checked' },
        },
      ])
      model.enqueue((request) => {
        const result = request.messages
          .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
          .find(
            (b: any) => b.type === 'tool_result' && b.tool_use_id === 'toolu_policy_write',
          ) as any
        assert.ok(result, '必须存在真实 CLI 的工具结果')
        assert.equal(result.is_error === true, !scenario.writes)
        return [{ type: 'text', text: '策略验证完成' }]
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '写入验证文件' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      assert.equal(approvals, scenario.approvals)
      if (scenario.writes) assert.equal(await readFile(target, 'utf8'), 'policy checked')
      else await assert.rejects(access(target))
      model.assertConsumed()
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}

for (const enabled of [false, true]) {
  test('PERMISSION-004：MCP 提问开关 ' + enabled + ' 不改变工具审批语义', {
    timeout: 60_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-mcp-policy-'))
    const target = join(home, 'mcp-policy.txt')
    const model = new MockLLM()
    const client = await ProtocolClient.start(home, await model.start())
    try {
      let questions = 0
      let approvals = 0
      client.onServerRequest = async (method) => {
        if (method === 'mcpServer/elicitation/request') {
          questions++
          assert.equal(enabled, true, '关闭时不能向客户端发送 MCP 提问')
          return { action: 'accept', content: { value: 'POLICY_CONFIRMED' } }
        }
        assert.equal(method, 'item/fileChange/requestApproval')
        approvals++
        return { decision: 'accept' }
      }
      model.enqueue(() => [
        {
          type: 'tool_use',
          id: 'toolu_mcp_policy',
          name: 'mcp__fixture__confirm_fixture',
          input: {},
        },
      ])
      model.enqueue((request) => {
        const results = request.messages
          .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
          .filter((block: any) => block.type === 'tool_result')
        assert.match(
          JSON.stringify(results),
          new RegExp('MCP_ACTION_' + (enabled ? 'accept' : 'decline')),
        )
        return [{ type: 'text', text: 'MCP 策略已验证' }]
      })
      const policy = granular(true) as { granular: Record<string, boolean> }
      policy.granular.mcp_elicitations = enabled
      const { thread } = await client.request('thread/start', {
        cwd: home,
        sandbox: 'danger-full-access',
        approvalPolicy: policy,
        config: {
          mcp_servers: {
            fixture: {
              command: process.execPath,
              args: [resolve('test/fixtures/mcp-interactive-server.mjs')],
              env: { FIXTURE_EFFECT_PATH: target },
            },
          },
        },
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '调用需要确认的 MCP 工具' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      assert.equal(approvals, 1, '工具执行授权与表单回答分别处理')
      assert.equal(questions, enabled ? 1 : 0)
      if (enabled) assert.equal(await readFile(target, 'utf8'), 'POLICY_CONFIRMED\n')
      else await assert.rejects(access(target))
      model.assertConsumed()
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}
