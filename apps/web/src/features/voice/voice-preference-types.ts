import {
  DesktopScreenShareCaptureModeSchema,
  DesktopScreenShareCodecSchema,
  DesktopScreenShareQualitySchema,
  type DesktopScreenShareCaptureMode,
  type DesktopScreenShareCodec,
  type DesktopScreenShareQualityName,
} from '@syrnike13/platform'

export const ScreenShareQualitySchema = DesktopScreenShareQualitySchema
export type ScreenShareQualityName = DesktopScreenShareQualityName

export const ScreenShareCodecSchema = DesktopScreenShareCodecSchema
export type ScreenShareCodec = DesktopScreenShareCodec

export const ScreenShareCaptureModeSchema = DesktopScreenShareCaptureModeSchema
export type ScreenShareCaptureMode = DesktopScreenShareCaptureMode

export const SCREEN_SHARE_QUALITY_NAMES = [
  'low',
  'high',
  'high60',
  'text',
] satisfies ScreenShareQualityName[]

export const SCREEN_SHARE_CAPTURE_MODES = [
  'auto',
  'native',
] satisfies ScreenShareCaptureMode[]

export const SCREEN_SHARE_CAPTURE_MODE_LABELS: Record<
  ScreenShareCaptureMode,
  string
> = {
  auto: 'Авто (нативный на Windows)',
  native: 'Нативный (Windows)',
}

export const SCREEN_SHARE_QUALITY_LABELS: Record<
  ScreenShareQualityName,
  string
> = {
  low: '720p, 30 FPS',
  high: '1080p, 30 FPS',
  high60: '1080p, 60 FPS',
  text: 'Исходное разрешение, 5 FPS',
}
