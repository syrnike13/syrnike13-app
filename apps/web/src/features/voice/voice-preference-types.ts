export type ScreenShareQualityName = 'low' | 'high' | 'high60' | 'text'

export type ScreenShareCodec = 'auto' | 'av1'

export type ScreenShareCaptureMode = 'auto' | 'native'

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
