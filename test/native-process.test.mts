import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

const full = { sandboxPolicy: { type: 'dangerFullAccess' } }

test('FILES-003：真实进程的输入、退出、输出上限和终止', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-process-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const result = await client.request('command/exec', {
      ...full,
      cwd: home,
      command: ['/bin/sh', '-c', 'printf abcdef; printf stderr >&2; exit 7'],
      outputBytesCap: 3,
    })
    assert.deepEqual(result, { exitCode: 7, stdout: 'abc', stderr: 'std' })
    const command = client.request('command/exec', {
      ...full,
      processId: 'input',
      cwd: home,
      command: ['/bin/sh', '-c', 'printf READY; cat > input.txt; printf FINISHED'],
      streamStdin: true,
      streamStdoutStderr: true,
      outputBytesCap: 6,
    })
    await client.notification('command/exec/outputDelta', (value) => value.processId === 'input')
    const duplicate = await client.raw('command/exec', {
      ...full,
      processId: 'input',
      cwd: home,
      command: ['true'],
    })
    assert.equal(duplicate.error.code, -32602)
    await client.request('command/exec/write', {
      processId: 'input',
      deltaBase64: Buffer.from('二进制\0输入').toString('base64'),
      closeStdin: true,
    })
    assert.deepEqual(await command, { exitCode: 0, stdout: '', stderr: '' })
    assert.equal(await readFile(join(home, 'input.txt'), 'utf8'), '二进制\0输入')
    const chunks = client.trace.filter(
      (message) =>
        message.method === 'command/exec/outputDelta' && message.params.processId === 'input',
    )
    assert.equal(
      Buffer.concat(
        chunks.map((message) => Buffer.from(message.params.deltaBase64, 'base64')),
      ).toString(),
      'READYF',
    )
    assert.equal(chunks.at(-1).params.capReached, true)
    // 所有输出必须先于 command 最终响应，不能靠补读通知凑齐。
    assert.ok(
      client.trace.indexOf(chunks.at(-1)) <
        client.trace.findIndex((message) => message.result?.exitCode === 0),
    )

    await client.request('process/spawn', {
      processHandle: 'held',
      cwd: home,
      command: ['/bin/sh', '-c', 'printf SPAWNED; read line; printf "%s" "$line"'],
      streamStdin: true,
      streamStdoutStderr: true,
    })
    await client.notification('process/outputDelta', (value) => value.processHandle === 'held')
    await client.request('process/writeStdin', {
      processHandle: 'held',
      deltaBase64: Buffer.from('answer\n').toString('base64'),
    })
    assert.equal(
      (await client.notification('process/exited', (value) => value.processHandle === 'held'))
        .exitCode,
      0,
    )
    await client.request('process/spawn', {
      processHandle: 'stop',
      cwd: home,
      command: ['/bin/sh', '-c', 'printf RUNNING; sleep 30; touch must-not-exist'],
      streamStdoutStderr: true,
    })
    await client.notification('process/outputDelta', (value) => value.processHandle === 'stop')
    await client.request('process/kill', { processHandle: 'stop' })
    assert.notEqual(
      (await client.notification('process/exited', (value) => value.processHandle === 'stop'))
        .exitCode,
      0,
    )
    await assert.rejects(access(join(home, 'must-not-exist')))
    const missing = await client.raw('process/spawn', {
      processHandle: 'missing',
      cwd: home,
      command: ['/nonexistent/test-command'],
    })
    assert.equal(missing.error.code, -32000)
    assert.equal(model.requests.length, 0)
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('FILES-004：PTY 初始尺寸、resize 和真实退出码', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-pty-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    for (const kind of ['command', 'process']) {
      const id = `pty-${kind}`
      const field = kind === 'command' ? 'processId' : 'processHandle'
      const prefix = kind === 'command' ? 'command/exec' : 'process'
      const started = client.request(kind === 'command' ? 'command/exec' : 'process/spawn', {
        ...(kind === 'command' ? full : {}),
        [field]: id,
        cwd: home,
        tty: true,
        size: { rows: 23, cols: 71 },
        command: ['/bin/sh', '-c', 'stty -echo; stty size; read line; stty size; exit 7'],
      })
      if (kind === 'process') await started
      const initial = await client.notification(
        `${prefix}/outputDelta`,
        (value) =>
          value[field] === id &&
          Buffer.from(value.deltaBase64, 'base64').toString().includes('23 71'),
      )
      assert.equal(initial.stream, 'stdout')
      await client.request(kind === 'command' ? 'command/exec/resize' : 'process/resizePty', {
        [field]: id,
        size: { rows: 39, cols: 107 },
      })
      await client.request(kind === 'command' ? 'command/exec/write' : 'process/writeStdin', {
        [field]: id,
        deltaBase64: Buffer.from('continue\n').toString('base64'),
      })
      const ended =
        kind === 'command'
          ? await started
          : await client.notification('process/exited', (value) => value[field] === id)
      assert.equal(ended.exitCode, 7)
      const output = client.trace
        .filter(
          (message) => message.method === `${prefix}/outputDelta` && message.params[field] === id,
        )
        .map((message) => Buffer.from(message.params.deltaBase64, 'base64').toString())
        .join('')
      assert.match(output, /39 107/)
    }
    assert.equal(model.requests.length, 0)
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('FILES-005：关闭适配器后不遗留忽略 TERM 的后台孙进程', { timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-process-cleanup-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  let closed = false
  try {
    const result = await client.request('command/exec', {
      ...full,
      cwd: home,
      command: [
        '/bin/sh',
        '-c',
        '(trap "" TERM; touch ready; sleep 2; touch escaped) >/dev/null 2>&1 & while [ ! -e ready ]; do sleep 0.01; done; printf finished',
      ],
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'finished')
    await client.close()
    closed = true
    await new Promise((resolve) => setTimeout(resolve, 2200))
    await assert.rejects(access(join(home, 'escaped')))
    assert.equal(model.requests.length, 0)
  } finally {
    if (!closed) await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})
