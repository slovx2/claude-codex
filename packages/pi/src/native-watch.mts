import { existsSync, readFileSync } from 'node:fs'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { fileStamp } from './native-files.mjs'

// Pi 实例只能交替使用；执行中发现另一写入者后停止模型，要求显式重新加载。
export function watchNativeSession(session: AgentSession, onConflict: () => void): () => void {
  let conflict = false
  let persisted = Boolean(session.sessionFile && existsSync(session.sessionFile))
  let stamp: string | null = null
  const timer = setInterval(() => {
    if (conflict || !session.sessionFile) return
    const next = fileStamp(session.sessionFile)
    if (next === stamp && next !== null) return
    stamp = next
    if (!existsSync(session.sessionFile)) {
      if (persisted) {
        conflict = true
        onConflict()
      }
      return
    }
    persisted = true
    try {
      const disk = readFileSync(session.sessionFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .slice(1)
      const memory = session.sessionManager.getEntries()
      if (
        disk.length === memory.length &&
        disk.every((entry, index) => JSON.stringify(entry) === JSON.stringify(memory[index]))
      )
        return
    } catch {
      /* 部分写入也属于外部并发修改，不能继续提交。 */
    }
    conflict = true
    onConflict()
  }, 25)
  timer.unref()
  return () => clearInterval(timer)
}
