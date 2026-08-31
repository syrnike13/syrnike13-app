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

$normal = Invoke-CaptureProbe @('capture-monitor', '--frames', '600', '--d3d-debug')
Require ($normal.ok -and $normal.capturedFrames -eq 600) 'normal capture did not produce 600 frames'
Require ($normal.sequenceIncreasing -and $normal.timestampsMonotonic) 'normal capture ordering failed'
Require ($normal.hashes.changed -and $normal.hashes.samples.Count -gt 1) 'normal capture hashes did not change'
Require ($normal.queue.maximumDepth -le $normal.queue.capacity -and $normal.queue.capacity -le 3) 'normal queue exceeded capacity'
Require ($normal.d3dDebug.status -in @('reported', 'skipped')) 'D3D debug result was not typed'
if ($normal.d3dDebug.status -eq 'reported') {
  Require ($normal.d3dDebug.liveEngineObjects -eq 0) 'D3D report found a live engine texture'
}
Require ($normal.resources.delta.handles -le $normal.resources.budget.handles -and
         $normal.resources.delta.threads -le $normal.resources.budget.threads) 'normal resources did not return to baseline'

$slow = Invoke-CaptureProbe @('capture-monitor-slow-consumer', '--frames', '5')
Require ($slow.ok -and $slow.queue.dropped -gt 0) '1 FPS consumer did not supersede frames'
Require ($slow.queue.maximumDepth -le 3) 'slow consumer queue exceeded capacity'
Require ($slow.resources.delta.handles -le $slow.resources.budget.handles -and
         $slow.resources.delta.threads -le $slow.resources.budget.threads) 'slow resources did not return to baseline'

$repeat = Invoke-CaptureProbe @('capture-monitor-repeat', '--cycles', '50')
Require ($repeat.ok -and $repeat.repeat -eq 50) '50 capture cycles failed'
Require ($repeat.resources.delta.handles -le $repeat.resources.budget.handles -and $repeat.resources.delta.threads -le $repeat.resources.budget.threads) 'repeat resources did not return to baseline'
Require ($repeat.resources.maximumCycleDelta.handles -le $repeat.resources.budget.handles -and $repeat.resources.maximumCycleDelta.threads -le $repeat.resources.budget.threads) 'a capture cycle retained process resources'

$raced = Invoke-CaptureProbe @('capture-monitor-stop-during-start')
Require ($raced.ok -and $raced.state -eq 'stopped') 'stop during start was not terminal and deterministic'
Require ($null -ne $raced.queue -and $null -ne $raced.resources -and
         $null -ne $raced.d3dDebug -and $null -ne $raced.durationsMs) 'stop during start report was incomplete'

$invalidLine = & $Probe capture-monitor --source src_invalid
Require ($LASTEXITCODE -ne 0) 'invalid opaque source unexpectedly started capture'
$invalid = $invalidLine | ConvertFrom-Json
Require (-not $invalid.ok -and $invalid.failure.code -eq 'source_unavailable') 'invalid opaque source failure was not typed JSON'

Write-Output 'monitor-capture-probe-json:ok'
