import type { FeedbackSystem } from '@syrnike13/api-types'

import { getSyrnikeDesktop } from '#/platform/runtime'

/** Mirrors the backend limit for a single hardware line. */
export const SYSTEM_FIELD_MAX_LENGTH = 120

type BrowserSystemInput = {
  userAgent: string
  platform: string | null
  platformVersion: string | null
}

/**
 * Collect the hardware summary offered in the feedback dialog.
 *
 * The desktop shell reports CPU, memory, OS and the primary display; the
 * renderer adds the GPU name from WebGL and falls back to browser-only values
 * when the same code runs on the web.
 */
export async function collectFeedbackSystem(): Promise<FeedbackSystem> {
  const desktop = await readDesktopSystemInfo()

  const system: FeedbackSystem = {
    os: clip(desktop?.os ?? (await readBrowserSystem())),
    cpu: clip(desktop?.cpu ?? null),
    cpu_threads:
      desktop?.cpu_threads ??
      (typeof navigator === 'undefined' ? null : navigator.hardwareConcurrency || null),
    gpu: clip(readGpuName()),
    memory_bytes: desktop?.memory_bytes ?? readBrowserMemoryBytes(),
    display: clip(desktop?.display ?? describeBrowserDisplay()),
  }

  return system
}

/** Whether anything at all was collected; an empty summary is not worth sending. */
export function hasSystemDetails(system: FeedbackSystem | null): system is FeedbackSystem {
  if (!system) return false
  return (
    Boolean(system.os) ||
    Boolean(system.cpu) ||
    Boolean(system.cpu_threads) ||
    Boolean(system.gpu) ||
    Boolean(system.memory_bytes) ||
    Boolean(system.display)
  )
}

async function readDesktopSystemInfo() {
  const desktop = getSyrnikeDesktop()
  if (!desktop) return null

  try {
    return await desktop.system.getInfo()
  } catch {
    return null
  }
}

function clip(value: string | null | undefined) {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, SYSTEM_FIELD_MAX_LENGTH)
}

async function readBrowserSystem() {
  if (typeof navigator === 'undefined') return null

  const userAgentData = Reflect.get(navigator, 'userAgentData') as unknown
  return describeBrowserSystem({
    userAgent: navigator.userAgent ?? '',
    platform: readStringProperty(userAgentData, 'platform'),
    platformVersion: await readPlatformVersion(userAgentData),
  })
}

/** Name the OS the way a person would, as far as the browser lets us see it. */
export function describeBrowserSystem({
  userAgent,
  platform,
  platformVersion,
}: BrowserSystemInput): string | null {
  const platformName = `${platform ?? ''} ${userAgent}`.toLowerCase()

  if (platformName.includes('windows')) {
    // Chrome reports the kernel version: 13+ is Windows 11, anything lower is 10.
    const major = Number((platformVersion ?? '').split('.')[0])
    return Number.isFinite(major) && major >= 13 ? 'Windows 11' : 'Windows 10'
  }

  if (platformName.includes('mac') || platformName.includes('darwin')) {
    return platformVersion ? `macOS ${platformVersion}` : 'macOS'
  }

  if (platformName.includes('cros')) return 'ChromeOS'
  if (platformName.includes('android')) return 'Android'
  if (platformName.includes('linux') || platformName.includes('x11')) return 'Linux'

  return null
}

async function readPlatformVersion(userAgentData: unknown) {
  if (!userAgentData || typeof userAgentData !== 'object') return null
  const readHighEntropyValues = Reflect.get(userAgentData, 'getHighEntropyValues')
  if (typeof readHighEntropyValues !== 'function') return null

  try {
    const values: unknown = await readHighEntropyValues.call(userAgentData, [
      'platformVersion',
    ])
    return readStringProperty(values, 'platformVersion')
  } catch {
    return null
  }
}

function readStringProperty(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return null
  const property = Reflect.get(value, key)
  return typeof property === 'string' && property ? property : null
}

/** GPU model from the unmasked WebGL renderer, e.g. `NVIDIA GeForce RTX 3070`. */
export function readGpuName(): string | null {
  if (typeof document === 'undefined') return null

  try {
    const canvas = document.createElement('canvas')
    const context =
      canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl')
    if (!context || !('getExtension' in context)) return null

    const debugInfo = context.getExtension('WEBGL_debug_renderer_info')
    if (!debugInfo) return null

    const renderer = context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
    return typeof renderer === 'string' ? cleanGpuName(renderer) : null
  } catch {
    return null
  }
}

/** Strip the ANGLE wrapper and graphics API noise Chromium puts around the model. */
export function cleanGpuName(renderer: string): string | null {
  const angle = renderer.match(/^ANGLE \((.+)\)$/i)
  const inner = (angle ? angle[1]! : renderer).replace(
    /,\s*(?:d3d\d*|direct3d\d*|opengl|vulkan|metal)\s*$/i,
    '',
  )

  const parts = inner
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  // `NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0` → the device wins.
  const device = parts.length > 1 ? parts[1]! : parts[0]

  const cleaned = device
    ?.replace(/\s+(?:vs_\d+_\d+|ps_\d+_\d+)/gi, '')
    .replace(
      /\s+(?:d3d\d*|direct3d\d*|opengl|vulkan|metal)\b.*$/i,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned ? cleaned : null
}

function readBrowserMemoryBytes() {
  if (typeof navigator === 'undefined') return null
  const gigabytes = Reflect.get(navigator, 'deviceMemory')
  if (typeof gigabytes !== 'number' || !Number.isFinite(gigabytes) || gigabytes <= 0) {
    return null
  }
  return Math.round(gigabytes * 1024 ** 3)
}

function describeBrowserDisplay() {
  if (typeof window === 'undefined') return null

  const ratio = window.devicePixelRatio || 1
  const width = Math.round(window.screen.width * ratio)
  const height = Math.round(window.screen.height * ratio)
  if (width <= 0 || height <= 0) return null

  return `${width}x${height}`
}
