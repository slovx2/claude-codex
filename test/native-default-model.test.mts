import assert from 'node:assert/strict'
import test from 'node:test'
import { allSelectableModelOptions, defaultSelectableModelId } from '../src/server-helpers.mjs'
import { resolveClaudeModel } from '../src/util.mjs'

test('未指定模型时，选择器与普通及标题请求都沿用原生 Claude 配置', () => {
  const keys = ['CLAUDE_CODEX_MODELS', 'CLAUDE_CODEX_DEFAULT_MODEL']
  const previous = keys.map((key) => process.env[key])
  try {
    for (const key of keys) delete process.env[key]
    assert.equal(defaultSelectableModelId(), 'claude-default')
    const options = allSelectableModelOptions()
    assert.deepEqual(
      options.filter((option) => option.isDefault).map((option) => option.id),
      ['claude-default'],
    )
    assert.equal(resolveClaudeModel('claude-default'), null)
    assert.equal(resolveClaudeModel('claude-default', 'summary'), null)
    assert.equal(resolveClaudeModel('opus'), 'opus')
    process.env.CLAUDE_CODEX_MODELS = 'custom-a,custom-b'
    assert.equal(defaultSelectableModelId(), 'custom-a')
    assert.deepEqual(
      allSelectableModelOptions().map((option) => option.id),
      ['custom-a', 'custom-b'],
    )
  } finally {
    for (const [index, key] of keys.entries()) {
      if (previous[index] == null) delete process.env[key]
      else process.env[key] = previous[index]
    }
  }
})
