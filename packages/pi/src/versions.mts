import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isVersionAtLeast } from '../../shared/src/min-version.mjs'
import { CODEX_PROTOCOL_VERSION } from '../../shared/src/runtime-version.mjs'

export const versions = {
  protocol: CODEX_PROTOCOL_VERSION,
  node: '24.14.0',
  sdk: '0.99.1',
  cli: '0.99.1',
  plan: '0.58.3',
  tuiKit: '0.59.0',
  subagents: '21.8.1',
} as const

export function runtimeInfo() {
  const installed = installedVersions()
  validateInstalledVersions(installed)
  return {
    engine: 'pi',
    protocolVersion: versions.protocol,
    nodeVersion: process.versions.node,
    sdkVersion: installed['@earendil-works/pi-coding-agent'],
    cliBuild: versions.cli,
    pluginVersions: {
      '@narumitw/pi-plan-mode': installed['@narumitw/pi-plan-mode'],
      '@gotgenes/pi-subagents': installed['@gotgenes/pi-subagents'],
      '@narumitw/pi-tui-kit': installed['@narumitw/pi-tui-kit'],
    },
    capabilities: [
      'history.pagination',
      'submission.idempotency',
      'dynamicTools',
      'nativeSession.rollback',
      'nativeSession.revert.paginated',
      'nativeSession.rollback.paginated',
    ],
    releaseReady: false,
  }
}

const expectedPackages: Record<string, string> = {
  '@earendil-works/pi-coding-agent': versions.sdk,
  '@narumitw/pi-plan-mode': versions.plan,
  '@narumitw/pi-tui-kit': versions.tuiKit,
  '@gotgenes/pi-subagents': versions.subagents,
}

export function installedVersions(): Record<string, string> {
  return Object.fromEntries(
    Object.keys(expectedPackages).map((name) => {
      const entry = name === '@narumitw/pi-plan-mode' ? `${name}/package.json` : name
      let directory = dirname(fileURLToPath(import.meta.resolve(entry)))
      while (directory !== dirname(directory)) {
        const path = join(directory, 'package.json')
        if (existsSync(path)) {
          const pkg = JSON.parse(readFileSync(path, 'utf8'))
          if (pkg.name === name) return [name, pkg.version]
        }
        directory = dirname(directory)
      }
      throw new Error(`找不到已安装包的版本: ${name}`)
    }),
  )
}

export function validateInstalledVersions(installed = installedVersions()): void {
  for (const [name, minimum] of Object.entries(expectedPackages))
    if (!isVersionAtLeast(installed[name], minimum))
      throw new Error(`${name} 版本不符: 需要 >= ${minimum}，实际 ${installed[name] ?? '缺失'}`)
}
