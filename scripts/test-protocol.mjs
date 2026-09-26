import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const artifacts = resolve(process.env.PROTOCOL_ARTIFACT_DIR ?? '.artifacts/protocol')
mkdirSync(artifacts, { recursive: true })
const runId = process.env.PROTOCOL_RUN_ID ?? randomUUID()
writeFileSync(
  resolve(artifacts, 'run.json'),
  JSON.stringify({ runId, startedAt: new Date().toISOString() }),
)
let schema =
  process.env.CODEX_SCHEMA_DIR ??
  resolve('../tyrs-hand/protocol/codex-app-server/0.147.0/json-schema')
if (!existsSync(schema)) {
  const cli = process.env.CODEX_TEST_BIN ?? 'codex'
  const version = execFileSync(cli, ['--version'], { encoding: 'utf8' }).trim()
  if (version !== 'codex-cli 0.147.0') throw new Error(`测试 CLI 版本错误: ${version}`)
  schema = resolve(artifacts, 'schema')
  execFileSync(cli, ['app-server', 'generate-json-schema', '--experimental', '--out', schema])
}
const info = execFileSync(process.execPath, ['dist/src/adapter.mjs', '--runtime-info'], {
  encoding: 'utf8',
})
writeFileSync(resolve(artifacts, 'versions.json'), info)
const command = process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : 'unshare'
const isolation =
  process.platform === 'darwin'
    ? [
        '-p',
        '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))',
        process.execPath,
      ]
    : [
        '--user',
        '--map-root-user',
        '--net',
        '/bin/sh',
        '-ec',
        'ip link set lo up; exec "$@"',
        'protocol-test',
        process.execPath,
      ]
const result = spawnSync(
  command,
  [
    ...isolation,
    '--test',
    '--test-reporter=spec',
    '--test-reporter=junit',
    `--test-reporter=${resolve('scripts/protocol-reporter.mjs')}`,
    '--test-reporter-destination=stdout',
    `--test-reporter-destination=${resolve(artifacts, 'junit.xml')}`,
    `--test-reporter-destination=${resolve(artifacts, 'executions.jsonl')}`,
    'dist/test/native-protocol.test.mjs',
    'dist/test/native-catalog.test.mjs',
    'dist/test/native-experimental-features.test.mjs',
    'dist/test/native-thread-shell.test.mjs',
    'dist/test/native-skills.test.mjs',
    'dist/test/native-skills-management.test.mjs',
    'dist/test/native-hooks.test.mjs',
    'dist/test/native-config.test.mjs',
    'dist/test/native-history.test.mjs',
    'dist/test/native-session.test.mjs',
    'dist/test/native-sections.test.mjs',
    'dist/test/native-rollback-failure.test.mjs',
    'dist/test/native-submit-failure.test.mjs',
    'dist/test/native-goals.test.mjs',
    'dist/test/native-goal-execution.test.mjs',
    'dist/test/native-events.test.mjs',
    'dist/test/native-event-deletion.test.mjs',
    'dist/test/native-turn-control.test.mjs',
    'dist/test/native-interactions.test.mjs',
    'dist/test/native-interaction-timeout.test.mjs',
    'dist/test/native-plan.test.mjs',
    'dist/test/native-permission-policy.test.mjs',
    'dist/test/native-sandbox-policy.test.mjs',
    ...(process.platform === 'darwin'
      ? []
      : [
          'dist/test/native-bash-sandbox.test.mjs',
          'dist/test/native-request-permissions.test.mjs',
        ]),
    'dist/test/native-cli-failure.test.mjs',
    'dist/test/native-mcp.test.mjs',
    'dist/test/native-mcp-management.test.mjs',
    'dist/test/native-mcp-oauth.test.mjs',
    'dist/test/native-mcp-elicitation.test.mjs',
    'dist/test/native-process.test.mjs',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      CODEX_SCHEMA_DIR: schema,
      PROTOCOL_ARTIFACT_DIR: artifacts,
      PROTOCOL_RUN_ID: runId,
    },
  },
)
if (result.error) throw result.error
let status = result.status ?? 1
if (process.platform === 'darwin') {
  // macOS 不支持嵌套 Seatbelt。此用例验证真正的工具级 OS 沙箱，单独运行。
  // ProtocolClient 仍使用临时 HOME、虚拟凭据和固定回环 Mock URL。
  writeFileSync(
    resolve(artifacts, 'sandbox-isolation.json'),
    JSON.stringify({
      platform: process.platform,
      outerNetworkIsolation: false,
      toolIsolation: 'sandbox-exec',
      modelEndpoint: 'loopback-only',
      reason: 'macOS 不支持嵌套 Seatbelt；Linux 在网络 namespace 内执行同一用例',
    }),
  )
  const sandbox = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=spec',
      '--test-reporter=junit',
      `--test-reporter=${resolve('scripts/protocol-reporter.mjs')}`,
      '--test-reporter-destination=stdout',
      `--test-reporter-destination=${resolve(artifacts, 'junit-sandbox.xml')}`,
      `--test-reporter-destination=${resolve(artifacts, 'executions-sandbox.jsonl')}`,
      'dist/test/native-bash-sandbox.test.mjs',
      'dist/test/native-request-permissions.test.mjs',
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        CODEX_SCHEMA_DIR: schema,
        PROTOCOL_ARTIFACT_DIR: artifacts,
        PROTOCOL_RUN_ID: runId,
      },
    },
  )
  if (sandbox.error) throw sandbox.error
  const executions = resolve(artifacts, 'executions-sandbox.jsonl')
  if (!existsSync(executions)) throw new Error('缺少真实 Bash 沙箱执行证据')
  appendFileSync(resolve(artifacts, 'executions.jsonl'), readFileSync(executions))
  status ||= sandbox.status ?? 1
}
process.exit(status)
