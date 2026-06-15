import { describe, expect, it, vi } from 'vitest'

import {
  EASTER_MODE_RELOAD_DELAY_MS,
  EASTER_NOTE_SOURCES,
  PALETTE_EASTER_NOTES,
  createPaletteEasterMelody,
  playEasterNote,
  type EasterNoteId,
} from '#/features/easter/easter-palette-melody'

const MELODY_THEME_SEQUENCE = [
  'syrnike',
  'syrnike',
  'lug',
  'iskra',
  'matrix',
  'monolit',
  'pergament',
  'syrnike',
  'pergament',
  'matrix',
  'grafit',
  'grafit',
  'lug',
  'iskra',
  'matrix',
  'monolit',
  'pergament',
  'syrnike',
  'pergament',
  'matrix',
]

describe('palette easter melody', () => {
  it('maps every palette to a note, including the decoy', () => {
    expect(PALETTE_EASTER_NOTES).toEqual({
      syrnike: 'd6',
      lug: 'd7',
      iskra: 'a6',
      matrix: 'g-sharp-6',
      monolit: 'g6',
      pergament: 'f6',
      grafit: 'b5',
      kontrast: 'decoy',
    })
  })

  it('enables easter mode and schedules reload after the full melody', () => {
    const playedNotes: EasterNoteId[] = []
    const setEasterModeEnabled = vi.fn()
    const reload = vi.fn()
    const schedule = vi.fn()

    const melody = createPaletteEasterMelody({
      playNote: (noteId) => playedNotes.push(noteId),
      isEasterModeEnabled: () => false,
      setEasterModeEnabled,
      reload,
      schedule,
    })

    for (const themeId of MELODY_THEME_SEQUENCE) {
      melody.handleThemeSelection(themeId)
    }

    expect(playedNotes).toEqual([
      'd6',
      'd6',
      'd7',
      'a6',
      'g-sharp-6',
      'g6',
      'f6',
      'd6',
      'f6',
      'g-sharp-6',
      'b5',
      'b5',
      'd7',
      'a6',
      'g-sharp-6',
      'g6',
      'f6',
      'd6',
      'f6',
      'g-sharp-6',
    ])
    expect(setEasterModeEnabled).toHaveBeenCalledWith(true)
    expect(schedule).toHaveBeenCalledWith(reload, EASTER_MODE_RELOAD_DELAY_MS)
  })

  it('resets melody progress when the decoy is clicked', () => {
    const melody = createPaletteEasterMelody({
      playNote: vi.fn(),
      isEasterModeEnabled: () => false,
      setEasterModeEnabled: vi.fn(),
      reload: vi.fn(),
      schedule: vi.fn(),
    })

    melody.handleThemeSelection('syrnike')
    expect(melody.getProgress()).toBe(1)

    melody.handleThemeSelection('kontrast')
    expect(melody.getProgress()).toBe(0)
  })

  it('plays notes but does not activate again while easter mode is already enabled', () => {
    const playNote = vi.fn()
    const setEasterModeEnabled = vi.fn()
    const schedule = vi.fn()

    const melody = createPaletteEasterMelody({
      playNote,
      isEasterModeEnabled: () => true,
      setEasterModeEnabled,
      reload: vi.fn(),
      schedule,
    })

    for (const themeId of MELODY_THEME_SEQUENCE) {
      melody.handleThemeSelection(themeId)
    }

    expect(playNote).toHaveBeenCalledTimes(MELODY_THEME_SEQUENCE.length)
    expect(setEasterModeEnabled).not.toHaveBeenCalled()
    expect(schedule).not.toHaveBeenCalled()
  })

  it('allows the melody to activate again after easter mode is disabled before reload', () => {
    let easterModeEnabled = false
    const setEasterModeEnabled = vi.fn((enabled: boolean) => {
      easterModeEnabled = enabled
    })
    const schedule = vi.fn()

    const melody = createPaletteEasterMelody({
      playNote: vi.fn(),
      isEasterModeEnabled: () => easterModeEnabled,
      setEasterModeEnabled,
      reload: vi.fn(),
      schedule,
    })

    for (const themeId of MELODY_THEME_SEQUENCE) {
      melody.handleThemeSelection(themeId)
    }

    easterModeEnabled = false

    for (const themeId of MELODY_THEME_SEQUENCE) {
      melody.handleThemeSelection(themeId)
    }

    expect(setEasterModeEnabled).toHaveBeenCalledTimes(2)
    expect(schedule).toHaveBeenCalledTimes(2)
  })

  it('plays the selected note audio without throwing on playback errors', () => {
    const play = vi.fn().mockRejectedValue(new Error('blocked'))
    const createAudio = vi.fn(() => ({
      volume: 0,
      preload: '',
      play,
    }))

    expect(() => playEasterNote('d6', createAudio)).not.toThrow()

    expect(createAudio).toHaveBeenCalledWith(EASTER_NOTE_SOURCES.d6)
    expect(play).toHaveBeenCalled()
  })
})
