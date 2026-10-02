import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// 只裁剪 package.json 明确排除目标平台的包。不能 omit optional：codemode 需要 esbuild。
function matches(values, target) {
  if (!Array.isArray(values) || values.length === 0) return true
  if (values.includes(`!${target}`)) return false
  const positive = values.filter((value) => !value.startsWith('!'))
  return positive.length === 0 || positive.includes(target) || positive.includes('any')
}

function packageDirectories(root) {
  const paths = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const path = join(root, entry.name)
    if (entry.name.startsWith('@')) {
      for (const child of readdirSync(path, { withFileTypes: true }))
        if (child.isDirectory()) paths.push(join(path, child.name))
    } else paths.push(path)
  }
  return paths
}

export function platformPackages(root, { prune = false, smoke = false } = {}) {
  const removed = []
  let esbuildCount = 0
  function walk(modules) {
    for (const path of packageDirectories(modules)) {
      const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
      if (!matches(pkg.os, 'linux') || !matches(pkg.cpu, 'x64') || !matches(pkg.libc, 'glibc')) {
        if (!prune) throw new Error(`Pi Linux amd64 制品含其他平台包: ${path}`)
        removed.push({ name: pkg.name, version: pkg.version })
        rmSync(path, { recursive: true })
        continue
      }
      if (pkg.name === 'esbuild') {
        esbuildCount++
        if (smoke) {
          const require = createRequire(join(path, 'package.json'))
          const result = require(path).transformSync('const answer: number = 42', { loader: 'ts' })
          if (!result.code.includes('42')) throw new Error(`esbuild 自检失败: ${path}`)
        }
      }
      if (readdirSync(path).includes('node_modules')) walk(join(path, 'node_modules'))
    }
  }
  walk(root)
  if (smoke && esbuildCount === 0) throw new Error('缺少 Pi codemode 所需的 esbuild')
  return { removed, esbuildCount }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2]
  if (!['prune', 'check'].includes(mode)) throw new Error('需要 prune 或 check')
  console.log(
    JSON.stringify(
      platformPackages(resolve(process.argv[3]), {
        prune: mode === 'prune',
        smoke: mode === 'check',
      }),
    ),
  )
}
