import os from 'node:os'

import type { DesktopSystemInfo } from '@syrnike13/platform'
import { screen } from 'electron'

/** Windows build number → marketing release name used by the OS itself. */
const WINDOWS_RELEASE_NAMES: Record<string, string> = {
  '19041': 'Windows 10 20H1',
  '19042': 'Windows 10 20H2',
  '19043': 'Windows 10 21H1',
  '19044': 'Windows 10 21H2',
  '19045': 'Windows 10 22H2',
  '22000': 'Windows 11 21H2',
  '22621': 'Windows 11 22H2',
  '22631': 'Windows 11 23H2',
  '26100': 'Windows 11 24H2',
  '26200': 'Windows 11 25H2',
}

/**
 * Collect the hardware summary the author can attach to a bug report.
 *
 * Everything here is read-only and stays on the machine until the renderer
 * explicitly sends it with a report.
 */
export function collectDesktopSystemInfo(): DesktopSystemInfo {
  const cpus = os.cpus()
  const cpuModel = cpus[0]?.model?.trim().replace(/\s+/g, ' ')
  const totalMemory = os.totalmem()

  return {
    os: describeOperatingSystem(),
    cpu: cpuModel ? cpuModel : null,
    cpu_threads: cpus.length > 0 ? cpus.length : null,
    memory_bytes: totalMemory > 0 ? totalMemory : null,
    display: describePrimaryDisplay(),
  }
}

/** Name of a Windows release from an `os.release()` value. */
export function describeWindowsRelease(release: string): string {
  const build = release.split('.')[2]
  const name = build ? WINDOWS_RELEASE_NAMES[build] : undefined
  return name ? `${name} (build ${build})` : `Windows ${release}`
}

/** Physical pixels of a display plus its refresh rate, when the OS reports one. */
export function formatDisplay(display: {
  width: number
  height: number
  scaleFactor: number
  displayFrequency?: number
}): string | null {
  const width = Math.round(display.width * display.scaleFactor)
  const height = Math.round(display.height * display.scaleFactor)
  if (width <= 0 || height <= 0) return null

  const refresh = display.displayFrequency
  return typeof refresh === 'number' && Number.isFinite(refresh) && refresh > 0
    ? `${width}x${height} @ ${Math.round(refresh)} Hz`
    : `${width}x${height}`
}

function describeOperatingSystem() {
  const release = os.release()

  if (process.platform === 'win32') {
    return describeWindowsRelease(release)
  }

  if (process.platform === 'darwin') {
    return `macOS ${process.getSystemVersion()}`
  }

  return `${os.type()} ${release}`
}

function describePrimaryDisplay() {
  const display = screen.getPrimaryDisplay()
  return formatDisplay({
    width: display.size.width,
    height: display.size.height,
    scaleFactor: display.scaleFactor,
    displayFrequency: display.displayFrequency,
  })
}
