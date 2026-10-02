import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeWirePaths } from '../../shared/src/native-path.mjs'

test('Windows SFTP 路径转换仅处理路径字段，保留提示文本与 Unix 路径', () => {
  const message = {
    params: {
      cwd: '/C:/project with spaces',
      path: '/D:/资料/a.txt',
      input: [{ type: 'text', text: '/C:/do not edit prompt' }],
      sandboxPolicy: { writableRoots: ['/E:/extra'] },
    },
  }
  const result = nativeWirePaths(message, 'win32')
  assert.equal(result.params.cwd, 'C:/project with spaces')
  assert.equal(result.params.path, 'D:/资料/a.txt')
  assert.equal(result.params.input[0]?.text, '/C:/do not edit prompt')
  assert.deepEqual(result.params.sandboxPolicy.writableRoots, ['E:/extra'])
  assert.deepEqual(nativeWirePaths(message, 'linux'), message)
})
