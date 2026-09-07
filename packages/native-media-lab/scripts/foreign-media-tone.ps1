param(
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [Parameter(Mandatory = $true)][string]$StopPath
)

$ErrorActionPreference = 'Stop'
$stream = [System.IO.MemoryStream]::new()
$writer = [System.IO.BinaryWriter]::new($stream)
$player = $null
try {
  $sampleRate = 48000
  $sampleCount = $sampleRate * 2
  $dataBytes = $sampleCount * 2
  $writer.Write([System.Text.Encoding]::ASCII.GetBytes('RIFF'))
  $writer.Write([int](36 + $dataBytes))
  $writer.Write([System.Text.Encoding]::ASCII.GetBytes('WAVEfmt '))
  $writer.Write([int]16)
  $writer.Write([int16]1)
  $writer.Write([int16]1)
  $writer.Write([int]$sampleRate)
  $writer.Write([int]($sampleRate * 2))
  $writer.Write([int16]2)
  $writer.Write([int16]16)
  $writer.Write([System.Text.Encoding]::ASCII.GetBytes('data'))
  $writer.Write([int]$dataBytes)
  for ($sample = 0; $sample -lt $sampleCount; ++$sample) {
    $writer.Write([int16][Math]::Round(800 * [Math]::Sin(2 * [Math]::PI * 1000 * $sample / $sampleRate)))
  }
  $writer.Flush()
  $stream.Position = 0
  $player = [System.Media.SoundPlayer]::new($stream)
  $player.Load()
  $player.PlayLooping()
  [System.IO.File]::WriteAllText($ReadyPath, [string]$PID)
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath $StopPath)) {
    Start-Sleep -Milliseconds 100
  }
} finally {
  if ($null -ne $player) { $player.Stop(); $player.Dispose() }
  $writer.Dispose()
  $stream.Dispose()
}
