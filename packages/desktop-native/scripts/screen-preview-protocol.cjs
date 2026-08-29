const externalPreviewPattern =
  /^EXTERNAL_PREVIEW nt_handle=(\d+) sequence=(\d+) timestamp_us=(\d+) width=(\d+) height=(\d+)/

function parseExternalPreviewLine(line) {
  const match = String(line).match(externalPreviewPattern)
  if (!match) return null
  return {
    ntHandle: match[1],
    sequence: Number(match[2]),
    timestampUs: Number(match[3]),
    width: Number(match[4]),
    height: Number(match[5]),
  }
}

function parseExternalPreviewRecords(text) {
  return String(text)
    .split(/\r?\n/)
    .map(parseExternalPreviewLine)
    .filter(Boolean)
}

module.exports = {
  parseExternalPreviewLine,
  parseExternalPreviewRecords,
}
