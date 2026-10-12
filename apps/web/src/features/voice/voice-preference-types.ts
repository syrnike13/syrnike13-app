import {
  DesktopScreenShareCaptureModeSchema,
  DesktopScreenShareCodecSchema,
  DesktopScreenShareQualitySchema,
  DesktopNativeScreenShareProfileSchema,
  type DesktopScreenShareCaptureMode,
  type DesktopScreenShareCodec,
  type DesktopScreenShareQualityName,
  type DesktopNativeScreenShareProfile,
} from '@syrnike13/platform'

export const ScreenShareQualitySchema = DesktopScreenShareQualitySchema
export type ScreenShareQualityName = DesktopScreenShareQualityName

export const NativeScreenShareProfileSchema = DesktopNativeScreenShareProfileSchema
export type NativeScreenShareProfile = DesktopNativeScreenShareProfile

export const NATIVE_SCREEN_SHARE_PROFILES = [
  '540p30',
  '720p30',
  '720p60',
  '1080p30',
  '1080p60',
] satisfies NativeScreenShareProfile[]

export const NATIVE_SCREEN_SHARE_PROFILE_LABELS: Record<
  NativeScreenShareProfile,
  string
> = {
  '540p30': '540p · 30 FPS',
  '720p30': '720p · 30 FPS',
  '720p60': '720p · 60 FPS',
  '1080p30': '1080p · 30 FPS',
  '1080p60': '1080p · 60 FPS',
}

export function nativeScreenShareProfileSettings(profile: NativeScreenShareProfile) {
  const settings = {
    '540p30': { width: 960, height: 540, fps: 30, bitrate: 625_000 },
    '720p30': { width: 1_280, height: 720, fps: 30, bitrate: 2_000_000 },
    '720p60': { width: 1_280, height: 720, fps: 60, bitrate: 4_000_000 },
    '1080p30': { width: 1_920, height: 1_080, fps: 30, bitrate: 6_000_000 },
    '1080p60': { width: 1_920, height: 1_080, fps: 60, bitrate: 8_000_000 },
  }
  return { ...settings[profile], audioBitrate: 128_000 }
}

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
