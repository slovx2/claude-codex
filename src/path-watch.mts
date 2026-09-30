import { existsSync, type FSWatcher, statSync, watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { debugLog } from './util.mjs'

const changeDebounceMs = 200

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// 与 Codex 0.157.1 的 fs/watch 相同：只做非递归监视；目标不存在时监视最近的已存在
// 祖先目录，路径出现后再移近目标；监视失败只记录不报错；200ms 内的变更合并为一次通知。
export class PathWatch {
  private watcher: FSWatcher | null = null
  private watchedPath: string | null = null
  private readonly pending = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private closed = false
  private lastExists: boolean
  private readonly path: string
  private readonly notify: (changedPaths: string[]) => void

  constructor(path: string, notify: (changedPaths: string[]) => void) {
    this.path = path
    this.notify = notify
    this.lastExists = existsSync(path)
    this.arm()
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.watcher?.close()
    this.watcher = null
  }

  private target(): string | null {
    if (existsSync(this.path)) return this.path
    for (let directory = dirname(this.path); ; directory = dirname(directory)) {
      if (isDirectory(directory)) return directory
      if (dirname(directory) === directory) return null
    }
  }

  private arm(): void {
    const target = this.target()
    if (this.closed || (target === this.watchedPath && this.watcher)) return
    this.watcher?.close()
    this.watcher = null
    this.watchedPath = target
    if (!target) return
    try {
      const watcher = watch(target, { persistent: false }, (_, filename) =>
        this.onEvent(target, filename),
      )
      watcher.on('error', (error) => {
        watcher.close()
        if (this.watcher === watcher) this.watcher = null
        debugLog('fs.watch.failed', { path: this.path, target, error: String(error) })
      })
      this.watcher = watcher
    } catch (error) {
      debugLog('fs.watch.failed', { path: this.path, target, error: String(error) })
    }
  }

  private onEvent(target: string, filename: string | Buffer | null): void {
    if (this.closed) return
    const exists = existsSync(this.path)
    if (target === this.path)
      this.queue(filename && isDirectory(this.path) ? join(this.path, String(filename)) : this.path)
    // 监视的是祖先目录时，只在目标出现或消失时通知目标本身。
    else if (exists !== this.lastExists) this.queue(this.path)
    this.lastExists = exists
    this.arm()
  }

  private queue(changedPath: string): void {
    this.pending.add(changedPath)
    this.timer ??= setTimeout(() => {
      this.timer = null
      const changedPaths = [...this.pending].sort()
      this.pending.clear()
      if (!this.closed && changedPaths.length) this.notify(changedPaths)
    }, changeDebounceMs)
  }
}
