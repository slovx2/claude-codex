import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { hostClaudeExecutable, hostClaudeVersion } from './host-claude.mjs'
import { validateSandboxDependencies } from './sandbox-dependencies.mjs'

const require = createRequire(import.meta.url)
let cached: ReturnType<typeof collectBuildInfo> | undefined

function collectBuildInfo() {
  validateSandboxDependencies()
  const sdkRoot = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'))
  const sdk = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'))
  const cli = hostClaudeExecutable()
  return {
    engine: 'claude-code',
    protocolVersion: '0.157.1',
    nodeVersion: process.versions.node,
    sdkVersion: sdk.version as string,
    cliBuild: hostClaudeVersion(cli, sdk.claudeCodeVersion),
    cliSha256: createHash('sha256').update(readFileSync(cli)).digest('hex'),
    capabilities: [
      'history.pagination',
      'submission.idempotency',
      'dynamicTools',
      'nativeSession.rollback',
    ],
    releaseReady: false,
  }
}

export function buildInfo() {
  cached ??= collectBuildInfo()
  return cached
}
