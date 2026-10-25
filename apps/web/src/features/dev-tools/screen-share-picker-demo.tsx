import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import type { DesktopDisplayMediaSource } from '@syrnike13/platform'
import { Button } from '@syrnike13/ui/primitives/button'

import {
  DesktopScreenSharePicker,
  type ScreenSharePickerDemo,
} from '#/features/voice/desktop-screen-share-picker'

function thumbnailDataUrl(title: string, accent: string) {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">',
    '<rect width="320" height="180" fill="#111214"/>',
    '<rect width="320" height="26" fill="#1b1d21"/>',
    '<circle cx="14" cy="13" r="4" fill="#3f4247"/>',
    '<circle cx="28" cy="13" r="4" fill="#3f4247"/>',
    '<circle cx="42" cy="13" r="4" fill="#3f4247"/>',
    '<rect x="18" y="44" width="132" height="12" rx="6" fill="#2c2f34"/>',
    `<rect x="18" y="44" width="72" height="12" rx="6" fill="${accent}"/>`,
    '<rect x="18" y="70" width="184" height="8" rx="4" fill="#25282d"/>',
    '<rect x="18" y="86" width="156" height="8" rx="4" fill="#25282d"/>',
    '<rect x="18" y="102" width="172" height="8" rx="4" fill="#25282d"/>',
    '<rect x="222" y="44" width="80" height="120" rx="8" fill="#1b1d21"/>',
    `<rect x="232" y="56" width="60" height="8" rx="4" fill="${accent}" opacity="0.7"/>`,
    '<rect x="232" y="72" width="60" height="8" rx="4" fill="#25282d"/>',
    '<rect x="232" y="88" width="44" height="8" rx="4" fill="#25282d"/>',
    `<text x="18" y="146" font-family="sans-serif" font-size="12" fill="#8b9096">${title}</text>`,
    '</svg>',
  ].join('')

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const DEMO_SOURCES: readonly DesktopDisplayMediaSource[] = [
  {
    id: 'screen:1',
    name: 'Display 1 · 2560×1440',
    type: 'screen',
    thumbnailDataUrl: thumbnailDataUrl('Display 1', '#6e8bff'),
    appIconDataUrl: null,
    audioAvailable: true,
    audioMode: 'system_exclude',
  },
  {
    id: 'screen:2',
    name: 'Display 2 · 1920×1080',
    type: 'screen',
    thumbnailDataUrl: thumbnailDataUrl('Display 2', '#44b78b'),
    appIconDataUrl: null,
    audioAvailable: true,
    audioMode: 'system_exclude',
  },
  {
    id: 'window:1',
    name: 'Syrnike — General',
    type: 'window',
    thumbnailDataUrl: thumbnailDataUrl('Syrnike', '#8b7bff'),
    appIconDataUrl: null,
    audioAvailable: true,
    audioMode: 'process',
  },
  {
    id: 'window:2',
    name: 'Visual Studio Code',
    type: 'window',
    thumbnailDataUrl: thumbnailDataUrl('Visual Studio Code', '#3fa6ff'),
    appIconDataUrl: null,
    audioAvailable: true,
    audioMode: 'process',
  },
  {
    id: 'window:3',
    name: 'Spotify',
    type: 'window',
    thumbnailDataUrl: thumbnailDataUrl('Spotify', '#3fd07a'),
    appIconDataUrl: null,
    audioAvailable: false,
  },
  {
    id: 'game:1',
    name: 'Counter-Strike 2',
    type: 'game',
    thumbnailDataUrl: thumbnailDataUrl('Counter-Strike 2', '#ff9f43'),
    appIconDataUrl: null,
    audioAvailable: true,
    audioMode: 'process',
  },
]

/**
 * Dev-only pixel preview of the native screen-share picker: the real dialog
 * with demo sources, so the selection UI can be shown without the Electron
 * bridge. Nothing is captured, published, or sent to the backend.
 */
export function ScreenSharePickerDemoLauncher() {
  const [open, setOpen] = useState(false)

  const demo = useMemo<ScreenSharePickerDemo | null>(() => {
    if (!open) return null
    return {
      request: {
        id: 'dev-screen-share-picker',
        audioRequested: true,
        nativeVideo: true,
      },
      sources: DEMO_SOURCES,
      onSelect: (source, audioRequested) => {
        setOpen(false)
        toast.success(
          `Demo: ${source.name}${audioRequested ? '' : ' (muted)'}`,
        )
      },
      onCancel: () => setOpen(false),
    }
  }, [open])

  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        Open picker
      </Button>
      {demo ? <DesktopScreenSharePicker demo={demo} /> : null}
    </>
  )
}
