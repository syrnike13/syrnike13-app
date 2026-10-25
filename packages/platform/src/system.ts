import { Schema } from 'effect'

/**
 * Hardware summary the desktop shell reads locally.
 *
 * The renderer merges it with browser-visible data (GPU, display fallback) and
 * attaches the result to a bug report only when the author asks for it.
 */
export const DesktopSystemInfoSchema = Schema.Struct({
  /** Operating system name with the marketing version, e.g. `Windows 11 24H2 (build 26100)`. */
  os: Schema.String,
  /** Processor model, or `null` when the platform does not report one. */
  cpu: Schema.Union([Schema.String, Schema.Null]),
  /** Logical processor count. */
  cpu_threads: Schema.Union([Schema.Int, Schema.Null]),
  /** Total physical memory in bytes. */
  memory_bytes: Schema.Union([Schema.Finite, Schema.Null]),
  /** Primary display, e.g. `2560x1440 @ 165 Hz`. */
  display: Schema.Union([Schema.String, Schema.Null]),
})

export type DesktopSystemInfo = typeof DesktopSystemInfoSchema.Type
