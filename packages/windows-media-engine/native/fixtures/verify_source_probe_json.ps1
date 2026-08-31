param([Parameter(Mandatory = $true)][string]$Probe)

function Require-Property($object, [string]$name) {
  if (-not ($object.PSObject.Properties.Name -contains $name)) {
    throw "missing required JSON property: $name"
  }
}

foreach ($kind in @('all', 'monitor', 'window')) {
  $json = & $Probe enumerate-sources --kind $kind
  if ($LASTEXITCODE -ne 0) { throw "media_probe failed for $kind" }
  $value = $json | ConvertFrom-Json
  if (-not $value.ok -or $value.command -ne 'enumerate-sources') {
    throw "probe envelope is invalid for $kind"
  }
  foreach ($name in @('ok', 'complete', 'completeness', 'sources', 'addedIds', 'updatedIds',
                       'removed', 'truncated', 'diagnostics')) {
    Require-Property $value.last $name
  }
  if ($value.last.sources.Count -gt 264) { throw "source count exceeded hard limit" }
  if ($value.last.diagnostics.Count -gt 64) { throw "diagnostic count exceeded hard limit" }
  foreach ($diagnostic in $value.last.diagnostics) {
    foreach ($name in @('code', 'detail')) { Require-Property $diagnostic $name }
    if ([Text.Encoding]::UTF8.GetByteCount($diagnostic.code) -gt 256 -or
        [Text.Encoding]::UTF8.GetByteCount($diagnostic.detail) -gt 256) {
      throw "diagnostic string exceeded UTF-8 byte limit"
    }
  }
  foreach ($removed in $value.last.removed) {
    foreach ($name in @('id', 'kind', 'availability')) {
      Require-Property $removed $name
    }
  }
  foreach ($source in $value.last.sources) {
  foreach ($name in @('id', 'kind', 'title', 'label', 'availability', 'flags',
                       'captureSupport', 'exclusions', 'monitor')) {
    Require-Property $source $name
  }
  if ([Text.Encoding]::UTF8.GetByteCount($source.id) -gt 256 -or
      [Text.Encoding]::UTF8.GetByteCount($source.title) -gt 256 -or
      [Text.Encoding]::UTF8.GetByteCount($source.label) -gt 256) {
    throw "public source string exceeded UTF-8 byte limit"
  }
  foreach ($name in @('available', 'visible', 'minimized', 'primary', 'ownProcess')) {
    Require-Property $source.flags $name
  }
    if ($kind -ne 'all' -and $source.kind -ne $kind) {
      throw "kind filter returned $($source.kind) for $kind"
    }
    if ($source.kind -eq 'monitor') {
    if ($null -eq $source.monitor) { throw "monitor metadata is null" }
    foreach ($name in @('logicalBounds', 'physicalBounds', 'dpi')) {
      Require-Property $source.monitor $name
    }
    foreach ($name in @('x', 'y', 'width', 'height')) {
      Require-Property $source.monitor.logicalBounds $name
    }
    foreach ($name in @('x', 'y', 'scale')) {
      Require-Property $source.monitor.dpi $name
    }
    } elseif ($null -ne $source.monitor) {
      throw "window unexpectedly exposed monitor metadata"
    }
  }
}

$sanitizedJson = & $Probe enumerate-sources --repeat 2 --diff --sanitized
if ($LASTEXITCODE -ne 0) { throw 'sanitized media_probe failed' }
$sanitized = $sanitizedJson | ConvertFrom-Json
if (-not $sanitized.ok -or -not $sanitized.sanitized) {
  throw 'sanitized report envelope is invalid'
}
foreach ($snapshot in @($sanitized.first, $sanitized.last)) {
  foreach ($name in @('ok', 'complete', 'completeness', 'counts', 'changes', 'truncated',
                       'diagnosticCodes')) {
    Require-Property $snapshot $name
  }
  foreach ($privateName in @('sources', 'title', 'label', 'addedIds', 'updatedIds')) {
    if ($snapshot.PSObject.Properties.Name -contains $privateName) {
      throw "sanitized report exposed $privateName"
    }
  }
}
