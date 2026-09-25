import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
    'dist/test/native-history.test.mjs',
    'dist/test/native-session.test.mjs',
    'dist/test/native-goals.test.mjs',
    'dist/test/native-events.test.mjs',
    'dist/test/native-interactions.test.mjs',
    'dist/test/native-mcp.test.mjs',
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
process.exit(result.status ?? 1)
