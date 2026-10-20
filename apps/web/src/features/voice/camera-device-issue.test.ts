import { describe, expect, it } from 'vitest'

import {
  isCameraDeviceFailure,
  isLocalCameraPreviewActive,
  nextCameraEnabled,
} from '#/features/voice/camera-device-issue'

const error = (code: string, stage?: string) => ({
  code,
  message: 'Camera demand could not be applied',
  retryable: true,
  ...(stage ? { stage } : {}),
})

describe('isCameraDeviceFailure', () => {
  it('treats device-stage input, unavailable and capture failures as device failures', () => {
    for (const code of ['camera_input_failed', 'camera_unavailable', 'camera_capture_failed']) {
      expect(isCameraDeviceFailure({ state: 'failed', error: error(code, 'camera') })).toBe(true)
    }
  })

  it('ignores permission, publication and non-failed states', () => {
    // The browser reports a denied permission as camera_unavailable without a stage.
    expect(isCameraDeviceFailure({ state: 'failed', error: error('camera_unavailable') })).toBe(false)
    expect(isCameraDeviceFailure({ state: 'failed', error: error('camera_publish_failed', 'camera') })).toBe(false)
    expect(isCameraDeviceFailure({ state: 'running', error: error('camera_input_failed', 'camera') })).toBe(false)
    expect(isCameraDeviceFailure({ state: 'failed', error: null })).toBe(false)
  })
})

describe('nextCameraEnabled', () => {
  it('turns an off camera on and a live camera off', () => {
    expect(nextCameraEnabled({ state: 'off' })).toBe(true)
    expect(nextCameraEnabled({ state: 'running' })).toBe(false)
    expect(nextCameraEnabled({ state: 'starting' })).toBe(false)
  })

  it('turns off a camera whose device failed instead of reopening it', () => {
    expect(nextCameraEnabled({ state: 'failed', error: error('camera_input_failed', 'camera') })).toBe(false)
  })

  it('retries other camera failures', () => {
    expect(nextCameraEnabled({ state: 'failed', error: error('camera_publish_failed', 'camera') })).toBe(true)
    expect(nextCameraEnabled({ state: 'failed', error: error('camera_unavailable') })).toBe(true)
  })
})

describe('isLocalCameraPreviewActive', () => {
  it('keeps the self-view while only publication failed', () => {
    expect(isLocalCameraPreviewActive({ state: 'running' })).toBe(true)
    expect(isLocalCameraPreviewActive({ state: 'failed', error: error('camera_publish_failed', 'camera') })).toBe(true)
  })

  it('drops the self-view when the camera is off or its device failed', () => {
    expect(isLocalCameraPreviewActive({ state: 'off' })).toBe(false)
    expect(isLocalCameraPreviewActive({ state: 'failed', error: error('camera_input_failed', 'camera') })).toBe(false)
  })
})
