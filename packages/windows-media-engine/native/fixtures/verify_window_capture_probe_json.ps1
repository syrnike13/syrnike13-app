param([Parameter(Mandatory = $true)][string]$Probe)

$ErrorActionPreference = 'Stop'

function Require([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Invoke-CaptureProbe([string[]]$Arguments) {
  $line = & $Probe @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "media_probe failed: $($Arguments -join ' ')`n$line"
  }
  try {
    return $line | ConvertFrom-Json
  } catch {
    throw "media_probe returned invalid JSON: $line"
  }
}

function Require-Resources($Report, [string]$Mode) {
  Require ($Report.resources.delta.handles -le $Report.resources.budget.handles -and
           $Report.resources.delta.threads -le $Report.resources.budget.threads) "$Mode resources exceeded the process budget"
  Require ($Report.queue.maximumDepth -le $Report.queue.capacity -and
           $Report.queue.capacity -le 3) "$Mode queue exceeded capacity"
  Require ($Report.metadataMatchesTransitions) "$Mode frame metadata did not match generation transitions"
  Require ($Report.d3dDebug.cleanupCompleted) "$Mode capture cleanup did not complete"
  Require ($Report.d3dDebug.liveEngineObjects -eq 0) "$Mode retained an engine D3D resource"
  Require ($Report.d3dDebug.peakEngineObjects -le ($Report.queue.capacity + 1)) "$Mode exceeded the bounded D3D frame-resource peak"
  Require ($Report.d3dDebug.status -in @('reported', 'skipped')) "$Mode D3D debug outcome was not typed"
  if ($Report.d3dDebug.status -eq 'reported') {
    Require ($Report.d3dDebug.liveEngineObjects -eq 0) "$Mode retained an engine D3D resource"
  }
}

$normal = Invoke-CaptureProbe @('capture-window', '--frames', '600', '--d3d-debug')
Require ($normal.ok -and $normal.capturedFrames -eq 600) 'normal window capture did not produce 600 frames'
Require ($normal.sequenceIncreasing -and $normal.timestampsMonotonic) 'normal window frame ordering failed'
Require ($normal.hashes.changed -and $normal.hashes.unique -gt 1) 'normal window content did not change'
Require ($normal.terminalEventCount -eq 0) 'normal capture emitted a terminal event'
Require-Resources $normal 'normal'

$resize = Invoke-CaptureProbe @('capture-window-resize', '--fixture')
Require ($resize.ok -and $resize.generation.resizeCount -ge 30) '30 resize transitions were not completed'
Require (@($resize.generation.framesPerSize.PSObject.Properties).Count -ge 3) 'resize report did not retain per-size evidence'
Require ($resize.checks.monitorMoveStatus -in @('tested', 'skipped_insufficient_monitors')) 'monitor move result was not typed'
Require ($resize.checks.dpiTransitionStatus -in @('tested', 'skipped_no_mixed_dpi', 'skipped_insufficient_monitors')) 'DPI transition result was not typed'
Require ($resize.terminalEventCount -eq 0) 'resize capture emitted a terminal event'
Require-Resources $resize 'resize'

$minimize = Invoke-CaptureProbe @('capture-window-minimize', '--fixture')
Require ($minimize.ok -and $minimize.noContentIntervals -ge 2) 'minimize/hide did not emit no-content intervals'
Require ($null -eq $minimize.terminalReason) 'temporary no-content became terminal'
Require ($minimize.terminalEventCount -eq 0) 'temporary no-content emitted a terminal event'
Require-Resources $minimize 'minimize'

$close = Invoke-CaptureProbe @('capture-window-close', '--fixture')
Require ($close.ok -and $close.terminalReason -eq 'source_closed') 'window close was not typed terminal'
Require ($close.terminalEventCount -eq 1) 'close probe did not emit exactly one terminal event'
Require ($close.checks.handleReuseStatus -in @('tested', 'skipped_no_reuse')) 'HWND reuse result was not typed'
if ($close.checks.handleReuseStatus -eq 'tested') {
  Require ($close.checks.handleReuseRejected) 'recycled HWND retained the old opaque identity'
} else {
  Require (-not $close.checks.handleReuseRejected) 'HWND reuse was claimed without observing reuse'
}
Require-Resources $close 'close'

$repeat = Invoke-CaptureProbe @('capture-window-repeat', '--cycles', '50')
Require ($repeat.ok -and $repeat.repeat -eq 50 -and $repeat.capturedFrames -eq 100) '50 window capture cycles failed'
Require ($repeat.terminalEventCount -eq 0) 'lifecycle repeat emitted a terminal event'
Require-Resources $repeat 'repeat'

$invalidLine = & $Probe capture-window --source src_invalid
Require ($LASTEXITCODE -ne 0) 'invalid window source unexpectedly started capture'
$invalid = $invalidLine | ConvertFrom-Json
Require (-not $invalid.ok -and $invalid.failure.code -eq 'source_unavailable') 'invalid window source failure was not typed JSON'

Write-Output 'window-capture-probe-json:ok'
