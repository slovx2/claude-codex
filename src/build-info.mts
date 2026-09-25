import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { validateSandboxDependencies } from './sandbox-dependencies.mjs'

const require = createRequire(import.meta.url)
let cached: ReturnType<typeof collectBuildInfo> | undefined

function collectBuildInfo() {
  validateSandboxDependencies()
  const sdkRoot = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'))
  const sdk = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'))
  const cliPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  const cliRoot = dirname(require.resolve(`${cliPackage}/package.json`))
  const cli = join(cliRoot, process.platform === 'win32' ? 'claude.exe' : 'claude')
  return {
    engine: 'claude-code',
    protocolVersion: '0.147.0',
    nodeVersion: process.versions.node,
    sdkVersion: sdk.version as string,
    cliBuild: execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim(),
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
