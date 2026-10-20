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

function renderControl(onToggleCamera = vi.fn()) {
  return render(
    <VoiceCameraSplitControl
      surface="stage"
      title="Включить камеру"
      disabled={false}
      cameraOn={false}
      onToggleCamera={onToggleCamera}
    />,
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
    renderControl()

    expect(screen.queryByText('HD Webcam')).toBeNull()
  })

  it('opens the device list when the camera device fails', () => {
    const view = renderControl()

    media.cameraDeviceFailed = true
    media.cameraDevicePickerRequest = 1
    view.rerender(
      <VoiceCameraSplitControl
        surface="stage"
        title="Включить камеру"
        disabled={false}
        cameraOn={false}
        onToggleCamera={vi.fn()}
      />,
    )

    expect(
      screen.getByText('Не удалось включить камеру. Выберите устройство.'),
    ).toBeTruthy()
    expect(screen.getByText('По умолчанию (OBS Virtual Camera)')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'HD Webcam' }))

    expect(media.selectCameraDevice).toHaveBeenCalledWith('12')
    expect(screen.queryByText('HD Webcam')).toBeNull()
  })

  it('opens one device list when the stage and the panel both show a camera button', () => {
    const tree = () => (
      <>
        <CameraDevicePickerAnchor>
          <button type="button">panel camera</button>
        </CameraDevicePickerAnchor>
        <VoiceCameraSplitControl
          surface="stage"
          title="Включить камеру"
          disabled={false}
          cameraOn={false}
          onToggleCamera={vi.fn()}
        />
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
    renderControl()

    fireEvent.click(screen.getByRole('button', { name: 'Параметры камеры' }))
    fireEvent.click(screen.getByRole('button', { name: 'По умолчанию (OBS Virtual Camera)' }))

    expect(media.selectCameraDevice).toHaveBeenCalledWith(undefined)
  })
})
