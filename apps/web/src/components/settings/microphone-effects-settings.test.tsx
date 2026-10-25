// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AudioEffectSlot, AudioEffectsState } from '@syrnike13/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MicrophoneEffectsSettings } from '#/components/settings/microphone-effects-settings'

const eq: AudioEffectSlot = {
  slotId: 'eq-1', kind: 'builtin', builtin: 'eq', mix: 1, enabled: true,
  params: { lowGainDb: 0, midGainDb: 0, midFrequency: 1500, highGainDb: 0 },
}
const room: AudioEffectSlot = {
  slotId: 'room-1', kind: 'vst3', path: 'C:/VST3/Room.vst3', classId: '0123456789ABCDEF0123456789ABCDEF',
  name: 'Room Verb', vendor: 'Acme', mix: 0.4, enabled: true,
}

const mocks = vi.hoisted(() => {
  const state: { current: AudioEffectsState } = {
    current: { host: 'running', slots: [], statuses: [] },
  }
  const api = {
    getState: vi.fn(async () => state.current),
    setChain: vi.fn(async (slots: readonly AudioEffectSlot[]) => ({ ...state.current, slots })),
    updateSlot: vi.fn(async () => undefined),
    openEditor: vi.fn(async () => true),
    getStats: vi.fn(async () => ({
      processCpuPercent: 3.2, audioThreadCpuPercent: 2.1, privateMegabytes: 48,
      slots: [{ slotId: 'room-1', averageUs: 850, p99Us: 1200, maxUs: 2400, overDeadline: 2 }],
    })),
    onStateChange: vi.fn(() => () => undefined),
    getCatalog: vi.fn(async () => ({ scanning: false, plugins: [], failures: [] })),
    scanPlugins: vi.fn(async () => ({ scanning: false, plugins: [], failures: [] })),
    onCatalogChange: vi.fn(() => () => undefined),
  }
  return { state, api }
})

vi.mock('#/platform/runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('#/platform/runtime')>(),
  getSyrnikeDesktop: () => ({ audioEffects: mocks.api }),
}))

describe('MicrophoneEffectsSettings', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('lists the chain with plugin status and an editor button only where one exists', async () => {
    mocks.state.current = {
      host: 'running',
      slots: [eq, room],
      statuses: [
        { slotId: 'eq-1', state: 'ready', hasEditor: false, latencySamples: 0 },
        { slotId: 'room-1', state: 'ready', hasEditor: true, latencySamples: 480 },
      ],
    }
    render(<MicrophoneEffectsSettings />)
    expect(await screen.findByText('Room Verb')).toBeTruthy()
    expect(screen.getByText(/Acme/).textContent).toMatch(/10/)
    // 0.85 ms of the 10 ms frame, the frames the host missed, and its CPU.
    expect((await screen.findByText(/0[.,]85/)).textContent).toMatch(/8[.,]5%/)
    expect(screen.getByText(/(Missed the deadline|Не успел) 2 /)).toBeTruthy()
    expect(screen.getByText(/3[.,]2% CPU · 48/)).toBeTruthy()
    const editors = screen.getAllByRole('button', { name: /plugin window|окно плагина/i })
    expect(editors).toHaveLength(1)
    fireEvent.click(editors[0]!)
    expect(mocks.api.openEditor).toHaveBeenCalledWith('room-1')
  })

  it('reorders and removes slots through the whole chain', async () => {
    mocks.state.current = { host: 'running', slots: [eq, room], statuses: [] }
    render(<MicrophoneEffectsSettings />)
    await screen.findByText('Room Verb')
    fireEvent.click(screen.getAllByRole('button', { name: /move down|ниже/i })[0]!)
    expect(mocks.api.setChain).toHaveBeenLastCalledWith([room, eq])
    await waitFor(() => expect(screen.getAllByRole('button', { name: /remove effect|удалить эффект/i })).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('button', { name: /remove effect|удалить эффект/i })[0]!)
    expect(mocks.api.setChain).toHaveBeenLastCalledWith([eq])
  })

  it('reports a failed plugin and a host that keeps crashing', async () => {
    mocks.state.current = {
      host: 'failed',
      slots: [room],
      statuses: [{ slotId: 'room-1', state: 'failed', hasEditor: false, error: 'LoadLibraryW failed' }],
    }
    render(<MicrophoneEffectsSettings />)
    expect(await screen.findByText(/LoadLibraryW failed/)).toBeTruthy()
    expect(screen.getByText(/plugin host stopped|хост плагинов перестал/i)).toBeTruthy()
  })

  it('explains a plugin that crashed the host and was left out', async () => {
    mocks.state.current = {
      host: 'running', slots: [room],
      statuses: [{ slotId: 'room-1', state: 'failed', hasEditor: false, crashed: true }],
    }
    render(<MicrophoneEffectsSettings />)
    expect(await screen.findByText(/crashed and was switched off|аварийно завершился/i)).toBeTruthy()
  })

  it('scans plugins only when the effect list is opened', async () => {
    mocks.state.current = { host: 'running', slots: [], statuses: [] }
    render(<MicrophoneEffectsSettings />)
    await screen.findByText(/No effects yet|Эффектов пока нет/i)
    // Listing plugins loads every installed module, so opening the settings
    // must not start it: only the list itself does.
    expect(mocks.api.scanPlugins).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /add effect|добавить эффект/i }))
    await waitFor(() => expect(mocks.api.scanPlugins).toHaveBeenCalledTimes(1))
  })

  it('switches a slot off without rebuilding the chain', async () => {
    mocks.state.current = { host: 'running', slots: [eq], statuses: [] }
    render(<MicrophoneEffectsSettings />)
    fireEvent.click(await screen.findByRole('switch'))
    expect(mocks.api.updateSlot).toHaveBeenCalledWith({ slotId: 'eq-1', enabled: false })
    expect(mocks.api.setChain).not.toHaveBeenCalled()
  })
})
