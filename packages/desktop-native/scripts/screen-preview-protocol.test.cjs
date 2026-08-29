const assert = require('node:assert/strict')
const test = require('node:test')

const {
  parseExternalPreviewLine,
  parseExternalPreviewRecords,
} = require('./screen-preview-protocol.cjs')

test('parses the timestamped external preview wire record', () => {
  const line = 'EXTERNAL_PREVIEW nt_handle=3516 sequence=5 ' +
    'timestamp_us=1985410377 width=1280 height=720'
  assert.deepEqual(parseExternalPreviewLine(line), {
    ntHandle: '3516',
    sequence: 5,
    timestampUs: 1_985_410_377,
    width: 1280,
    height: 720,
  })
})

test('extracts complete records from accumulated child output', () => {
  const records = parseExternalPreviewRecords([
    'RESULT path=real_screen_gpu_capture frames=1',
    'EXTERNAL_PREVIEW nt_handle=10 sequence=11 timestamp_us=12 width=13 height=14',
    'RELEASE_ACK sequence=11',
    'EXTERNAL_PREVIEW nt_handle=20 sequence=21 timestamp_us=22 width=23 height=24',
  ].join('\n'))
  assert.deepEqual(records.map(({ sequence }) => sequence), [11, 21])
})
