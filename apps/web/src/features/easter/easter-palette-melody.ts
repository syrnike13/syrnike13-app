import { easterModeStore } from '#/features/easter/easter-mode-store'

export const EASTER_PALETTE_HINT = 'тут не хватает КОСТЯНОЙ палитры'
export const EASTER_MODE_RELOAD_DELAY_MS = 2000

export const EASTER_NOTE_SOURCES = {
  d6: '/easter/notes/d6.ogg',
  d7: '/easter/notes/d7.ogg',
  a6: '/easter/notes/a6.ogg',
  'g-sharp-6': '/easter/notes/g-sharp-6.ogg',
  g6: '/easter/notes/g6.ogg',
  f6: '/easter/notes/f6.ogg',
  b5: '/easter/notes/b5.ogg',
  decoy: '/easter/notes/decoy.ogg',
} as const

export type EasterNoteId = keyof typeof EASTER_NOTE_SOURCES

export const PALETTE_EASTER_NOTES = {
  syrnike: 'd6',
  lug: 'd7',
  iskra: 'a6',
  matrix: 'g-sharp-6',
  monolit: 'g6',
  pergament: 'f6',
  grafit: 'b5',
  kontrast: 'decoy',
} as const satisfies Record<string, EasterNoteId>

export const EASTER_MELODY_SEQUENCE: EasterNoteId[] = [
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
]

type AudioLike = {
  volume: number
  preload: string
  play: () => Promise<unknown> | unknown
}

type PaletteEasterMelodyDeps = {
  playNote: (noteId: EasterNoteId) => void
  isEasterModeEnabled: () => boolean
  setEasterModeEnabled: (enabled: boolean) => void
  reload: () => void
  schedule: (callback: () => void, delayMs: number) => unknown
}

function createBrowserAudio(src: string): AudioLike {
  return new Audio(src)
}

export function playEasterNote(
  noteId: EasterNoteId,
  createAudio: (src: string) => AudioLike = createBrowserAudio,
) {
  const src = EASTER_NOTE_SOURCES[noteId]

  try {
    const audio = createAudio(src)
    audio.preload = 'auto'
    audio.volume = 0.9
    void Promise.resolve(audio.play()).catch(() => {})
  } catch {
    // Missing audio support or blocked playback must not break theme selection.
  }
}

export function createPaletteEasterMelody({
  playNote,
  isEasterModeEnabled,
  setEasterModeEnabled,
  reload,
  schedule,
}: PaletteEasterMelodyDeps) {
  let progress = 0
  let completionScheduled = false

  function resetProgressFor(noteId: EasterNoteId) {
    progress = noteId === EASTER_MELODY_SEQUENCE[0] ? 1 : 0
  }

  return {
    handleThemeSelection(themeId: string) {
      const noteId = PALETTE_EASTER_NOTES[themeId]
      if (!noteId) return

      playNote(noteId)

      if (isEasterModeEnabled()) {
        progress = 0
        return
      }
      if (completionScheduled) {
        completionScheduled = false
      }

      if (noteId !== EASTER_MELODY_SEQUENCE[progress]) {
        resetProgressFor(noteId)
        return
      }

      progress += 1
      if (progress < EASTER_MELODY_SEQUENCE.length) return

      progress = 0
      completionScheduled = true
      setEasterModeEnabled(true)
      schedule(reload, EASTER_MODE_RELOAD_DELAY_MS)
    },

    getProgress() {
      return progress
    },
  }
}

const browserPaletteEasterMelody = createPaletteEasterMelody({
  playNote: playEasterNote,
  isEasterModeEnabled: () => easterModeStore.getState(),
  setEasterModeEnabled: easterModeStore.setEnabled,
  reload: () => {
    if (typeof window !== 'undefined') window.location.reload()
  },
  schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
})

export function handlePaletteEasterNote(themeId: string) {
  browserPaletteEasterMelody.handleThemeSelection(themeId)
}
