const qualityWarningText = 'Демонстрация может идти с задержками. Попробуйте снизить качество вручную'

function renderQualityWarning(element, active) {
  if (typeof active !== 'boolean') throw new TypeError('Expected a quality warning state')
  if (element.hidden === !active) return
  element.textContent = active ? qualityWarningText : ''
  element.hidden = !active
}

module.exports = { qualityWarningText, renderQualityWarning }
