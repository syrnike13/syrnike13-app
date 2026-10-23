// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CameraDevicePickerAnchor,
  VoiceCameraSplitControl,
} from './voice-camera-split-control'

const media = vi.hoisted(() => ({
  cameraDeviceFailed: false,
  cameraDevicePickerRequest: 0,
  selectCameraDevice: vi.fn(),
}))

vi.mock('#/features/voice/voice-media-context', () => ({
  useVoiceMedia: () => media,
}))

vi.mock('#/features/voice/use-media-devices', () => ({
  useMediaDevices: () => [
    { deviceId: '11', kind: 'videoinput', label: 'OBS Virtual Camera', groupId: '' },
    { deviceId: '12', kind: 'videoinput', label: 'HD Webcam', groupId: '' },
  ],
}))

vi.mock('#/features/voice/use-voice-preferences', () => ({
  useVoicePreferences: () => ({ preferredVideoDevice: undefined }),
}))

vi.mock('#/features/settings/settings-modal-context', () => ({
  useSettingsModal: () => ({ openSettings: vi.fn() }),
}))

function cameraControl(onToggleCamera = vi.fn(), cameraOn = false) {
  return (
    <VoiceCameraSplitControl
      surface="stage"
      title="Включить камеру"
      disabled={false}
      cameraOn={cameraOn}
      onToggleCamera={onToggleCamera}
    />
  )
}

describe('VoiceCameraSplitControl', () => {
  beforeEach(() => {
    media.cameraDeviceFailed = false
    media.cameraDevicePickerRequest = 0
    media.selectCameraDevice.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps the device list closed until it is requested', () => {
    render(cameraControl())

    expect(screen.queryByText('HD Webcam')).toBeNull()
  })

  it('opens the device list when the camera device fails', () => {
    const view = render(cameraControl())

    media.cameraDeviceFailed = true
    media.cameraDevicePickerRequest = 1
    view.rerender(cameraControl())

    expect(
      screen.getByText('Не удалось включить камеру. Выберите устройство.'),
    ).toBeTruthy()
    expect(screen.getByText('HD Webcam')).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: 'HD Webcam' }))

    expect(media.selectCameraDevice).toHaveBeenCalledWith('12')
    // The list closes; Base UI keeps it mounted until the exit transition ends.
    expect(document.querySelector('[data-slot="popover-content"]')).toHaveAttribute(
      'data-closed',
    )
  })

  it('opens one device list when the stage and the panel both show a camera button', () => {
    const tree = () => (
      <>
        <CameraDevicePickerAnchor>
          <button type="button">panel camera</button>
        </CameraDevicePickerAnchor>
        {cameraControl()}
      </>
    )
    const view = render(tree())

    media.cameraDeviceFailed = true
    media.cameraDevicePickerRequest = 1
    view.rerender(tree())

    expect(
      screen.getAllByText('Не удалось включить камеру. Выберите устройство.'),
    ).toHaveLength(1)
  })

  it('opens the device list from the chevron', () => {
    render(cameraControl())

    fireEvent.click(screen.getByRole('button', { name: 'Параметры камеры' }))
    fireEvent.click(screen.getByRole('radio', { name: 'HD Webcam' }))

    expect(media.selectCameraDevice).toHaveBeenCalledWith('12')
  })
})
