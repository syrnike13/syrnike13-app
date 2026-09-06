import { test } from 'vitest'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { qualityWarningText, renderQualityWarning } = createRequire(import.meta.url)(
  '../../../apps/desktop/scripts/preview-lab/quality-warning.cjs')

test('one generic state, deduplicated until explicit recovery or stop', () => {
  let writes = 0, text = ''
  const element = { hidden: true, set textContent(value) { ++writes; text = value } }
  renderQualityWarning(element, true)
  for (let sample = 0; sample < 2400; ++sample) renderQualityWarning(element, true)
  assert.equal(writes, 1)
  assert.equal(text, qualityWarningText)
  assert.equal(element.hidden, false)
  assert.equal(text, 'Демонстрация может идти с задержками. Попробуйте снизить качество вручную')
  renderQualityWarning(element, false)
  assert.equal(element.hidden, true)
  assert.equal(text, '')
  assert.throws(() => renderQualityWarning(element, 'MFT HRESULT error'), TypeError)
})
