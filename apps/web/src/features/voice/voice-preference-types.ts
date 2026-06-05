export type NoiseSuppressionMode = 'disabled' | 'browser' | 'enhanced'

export type ScreenShareQualityName = 'low' | 'high' | 'high60' | 'text'

export type ScreenShareCodec = 'auto' | 'vp8' | 'h264' | 'vp9' | 'av1'

export const SCREEN_SHARE_QUALITY_LABELS: Record<
  ScreenShareQualityName,
  string
> = {
  low: '720p, 30 FPS',
  high: '1080p, 30 FPS',
  high60: '1080p, 60 FPS',
  text: 'Исходное разрешение, 5 FPS',
}

export const SCREEN_SHARE_CODEC_LABELS: Record<ScreenShareCodec, string> = {
  auto: 'Авто - лучший рабочий',
  vp8: 'VP8 - совместимый',
  h264: 'H264 - резче в движении',
  vp9: 'VP9 - эффективнее, если поддерживается',
  av1: 'AV1 - экспериментально',
}
