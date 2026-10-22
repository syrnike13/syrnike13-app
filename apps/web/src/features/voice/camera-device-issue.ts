import type { VoiceMediaError, VoiceMediaState } from '@syrnike13/platform'

type CameraMedia = {
  state: VoiceMediaState
  error?: VoiceMediaError | null
}

/**
 * Camera failures caused by the selected (or default) input device itself.
 * Only device-stage errors qualify: a denied permission or a failed
 * publication is not fixed by choosing another camera.
 */
const CAMERA_DEVICE_FAILURE_CODES: ReadonlySet<string> = new Set([
  'camera_input_failed',
  'camera_unavailable',
  'camera_capture_failed',
])

/** Failures that stop publishing while the local capture keeps running. */
const CAMERA_PUBLICATION_FAILURE_CODES: ReadonlySet<string> = new Set([
  'camera_publish_failed',
  'camera_sender_failed',
])

export function isCameraDeviceFailure(camera: CameraMedia) {
  return camera.state === 'failed' &&
    camera.error?.stage === 'camera' &&
    CAMERA_DEVICE_FAILURE_CODES.has(camera.error.code)
}

/**
 * The camera button's next intent. A device failure leaves a dead "on" intent:
 * the button turns it off, and the device picker is the way to retry. Any
 * other failure is retried by enabling the same intent again.
 */
export function nextCameraEnabled(camera: CameraMedia) {
  if (camera.state === 'off') return true
  if (camera.state === 'failed') return !isCameraDeviceFailure(camera)
  return false
}

/** The local self-view has live frames: capture runs even if publishing failed. */
export function isLocalCameraPreviewActive(camera: CameraMedia) {
  if (camera.state === 'starting' || camera.state === 'running') return true
  return camera.state === 'failed' &&
    CAMERA_PUBLICATION_FAILURE_CODES.has(camera.error?.code ?? '')
}
