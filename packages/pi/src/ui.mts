import { randomUUID } from 'node:crypto'
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'

export type ReverseCall = (method: string, params: any, signal?: AbortSignal) => Promise<any>
// 终端专属接口遵循官方 RPC 的空操作约定；可交互对话必须由客户端回答。
export function createUi(
  call: ReverseCall,
  notify: (method: string, params: any) => void,
): ExtensionUIContext {
  const noop = () => {}
  const question = async (
    title: string,
    options?: string[],
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    const id = randomUUID()
    const reply = await call(
      'item/tool/requestUserInput',
      {
        isBlocking: true,
        questions: [
          {
            id,
            header: title.slice(0, 12),
            question: title,
            isOther: !options,
            isSecret: false,
            options: options?.map((label) => ({ label, description: '' })) ?? null,
          },
        ],
      },
      signal,
    )
    return reply?.answers?.[id]?.answers?.[0]
  }
  return {
    select: (title, options, opts) => question(title, options, opts?.signal),
    confirm: async (title, message, opts) =>
      (await question(`${title}\n${message}`, ['确认', '取消'], opts?.signal)) === '确认',
    input: (title, placeholder, opts) =>
      question(placeholder ? `${title}\n${placeholder}` : title, undefined, opts?.signal),
    editor: (title, prefill) => question(prefill ? `${title}\n${prefill}` : title),
    notify: (message, type) => notify('warning', { message, severity: type ?? 'info' }),
    onTerminalInput: () => noop,
    setStatus: noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setWidget: noop,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    custom: async () => undefined as any,
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText: () => '',
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: () => undefined,
    theme: {
      fg: (_c: string, s: string) => s,
      bg: (_c: string, s: string) => s,
      bold: (s: string) => s,
    } as any,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'RPC 不支持主题切换' }),
    getToolsExpanded: () => false,
    setToolsExpanded: noop,
  }
}
