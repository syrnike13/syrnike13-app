// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DesktopOverlayHud } from './desktop-overlay-hud'

describe('DesktopOverlayHud', () => {
  it('renders participant avatars, names, speaking ring, mute and deafen state', () => {
    const { container } = render(
      <DesktopOverlayHud
        state={{
          available: true,
          enabled: true,
          visible: true,
          target: {
            gameId: 'c:/games/raid.exe',
            processName: 'raid.exe',
            processPath: 'C:/Games/Raid.exe',
            title: 'Raid',
            bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          },
          snapshot: {
            active: true,
            channelId: 'voice-1',
            channelLabel: 'General voice',
            participants: [
              {
                userId: 'speaker',
                displayName: 'Speaker',
                avatarUrl: 'https://cdn.example/speaker.png',
                speaking: true,
                muted: true,
                deafened: true,
                screensharing: true,
              },
              {
                userId: 'listener',
                displayName: 'Listener',
                avatarUrl: null,
                speaking: false,
                muted: false,
                deafened: false,
                screensharing: false,
              },
            ],
          },
        }}
      />,
    )

    expect(screen.getByText('Speaker')).toBeTruthy()
    expect(screen.getByText('Listener')).toBeTruthy()
    expect(screen.queryByText('General voice')).toBeNull()
    expect(screen.getByAltText('Speaker').getAttribute('src')).toBe(
      'https://cdn.example/speaker.png',
    )
    expect(screen.getByLabelText('Speaker говорит').className).toContain(
      'ring-2',
    )
    expect(screen.getByTitle('Микрофон отключён')).toBeTruthy()
    expect(screen.getByTitle('Звук отключён')).toBeTruthy()
    expect(screen.getByLabelText('В эфире')).toBeTruthy()

    const overlayPanel = container.querySelector('[data-overlay-panel]')
    expect(overlayPanel?.className).not.toContain('bg-')
    expect(container.querySelector('main')?.className).toContain(
      'text-foreground',
    )
    expect(container.innerHTML).not.toMatch(/text-white|rgba\(|#[\da-f]{3,8}/i)

    const speakerRow = screen.getByText('Speaker').closest('[data-participant-row]')
    const icons = speakerRow?.querySelector('[data-status-icons]')
    const name = speakerRow?.querySelector('[data-participant-name]')
    const onAirBadge = screen.getByLabelText('В эфире')
    expect(
      name?.compareDocumentPosition(icons!) === Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(true)
    expect(name?.parentElement).toBe(icons?.parentElement)
    expect(name?.parentElement).toBe(onAirBadge.parentElement)
    expect(
      icons?.compareDocumentPosition(onAirBadge) ===
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(true)
    expect(name?.parentElement?.className).toContain('rounded-full')
    expect(name?.parentElement?.className).toContain('bg-background/75')

    const listenerRow = screen.getByText('Listener').closest('[data-participant-row]')
    expect(listenerRow?.className).toContain('opacity-55')
  })

  it('renders nothing when overlay is hidden', () => {
    const { container } = render(
      <DesktopOverlayHud
        state={{
          available: true,
          enabled: true,
          visible: false,
          target: null,
          snapshot: {
            active: false,
            channelId: null,
            channelLabel: null,
            participants: [],
          },
        }}
      />,
    )

    expect(container.textContent).toBe('')
  })

  it('ignores empty display-name parts when rendering fallback initials', () => {
    render(
      <DesktopOverlayHud
        state={{
          available: true,
          enabled: true,
          visible: true,
          target: null,
          snapshot: {
            active: true,
            channelId: 'voice-1',
            channelLabel: 'General voice',
            participants: [
              {
                userId: 'listener',
                displayName: '  Mira   Stone  ',
                avatarUrl: null,
                speaking: false,
                muted: false,
                deafened: false,
                screensharing: false,
              },
            ],
          },
        }}
      />,
    )

    expect(screen.getByText('MS')).toBeTruthy()
    expect(screen.queryByText(/undefined/i)).toBeNull()
  })
})
