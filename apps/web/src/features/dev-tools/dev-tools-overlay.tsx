import { useState } from 'react'

import { Button } from '@syrnike13/ui/primitives/button'
import {
  Card,
  CardHeader,
  CardTitle,
} from '@syrnike13/ui/primitives/card'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@syrnike13/ui/primitives/tabs'
import { useHolidayPreview } from '@syrnike13/ui/holidays'

import { BugIcon, XIcon } from '#/components/icons'

import { HolidayPreviewPanel } from './holiday-preview-panel'
import { PrismWorkbenchPanel } from './prism-workbench-panel'
import { VoiceStagePreviewPanel } from './voice-stage-preview-panel'
import { usePrismWorkbench } from './use-prism-workbench'
import {
  isDevVoiceGhostsModified,
  useDevVoiceGhostsState,
} from '#/features/voice/dev-voice-stage-ghosts'

const DEV_TABS = ['holidays', 'themes', 'voice'] as const

type DevTab = (typeof DEV_TABS)[number]

function isDevTab(value: unknown): value is DevTab {
  return DEV_TABS.some((tab) => tab === value)
}

function ModifiedDot() {
  return (
    <span
      className="size-1.5 rounded-full bg-primary"
      aria-hidden="true"
    />
  )
}

/**
 * Single dev-only launcher for internal overlays.
 *
 * One floating button replaces the per-tool triggers in the corners. The panel
 * hosts holiday previews and the Prism theme workbench; the workbench lives
 * above the panel so its state survives closing it.
 */
export function DevToolsOverlay() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<DevTab>('holidays')
  const workbench = usePrismWorkbench(open && tab === 'themes')
  const holiday = useHolidayPreview()
  const ghosts = useDevVoiceGhostsState()

  const ghostsModified = isDevVoiceGhostsModified(ghosts)
  const modified =
    workbench.isCustom || holiday.override !== 'auto' || ghostsModified

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant={modified ? 'secondary' : 'outline'}
        className="fixed right-4 bottom-4 z-1000 gap-1.5 font-mono"
        onClick={() => setOpen(true)}
      >
        <BugIcon className="size-4" />
        DEV
        {modified ? <ModifiedDot /> : null}
      </Button>
    )
  }

  return (
    <div className="fixed right-4 bottom-4 z-1000 w-96 max-w-viewport-inset">
      <Card
        role="dialog"
        aria-label="Dev tools"
        className="max-h-dev-overlay gap-0 overflow-hidden shadow-xl"
      >
        <CardHeader className="flex shrink-0 items-center gap-2 border-b">
          <BugIcon className="size-4 text-muted-foreground" />
          <CardTitle className="flex-1 text-sm">Dev tools</CardTitle>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Close dev tools"
            onClick={() => {
              workbench.setPreviewVariant(null)
              setOpen(false)
            }}
          >
            <XIcon className="size-4" />
          </Button>
        </CardHeader>
        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (isDevTab(value)) setTab(value)
          }}
          className="min-h-0 flex-1"
        >
          <div className="shrink-0 px-4 pt-3">
            <TabsList className="w-full">
              <TabsTrigger value="holidays">
                Holidays
                {holiday.override !== 'auto' ? <ModifiedDot /> : null}
              </TabsTrigger>
              <TabsTrigger value="themes">
                Themes
                {workbench.isCustom ? <ModifiedDot /> : null}
              </TabsTrigger>
              <TabsTrigger value="voice">
                Voice
                {ghostsModified ? <ModifiedDot /> : null}
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent
            value="holidays"
            keepMounted
            className="flex min-h-0 flex-1 flex-col"
          >
            <HolidayPreviewPanel />
          </TabsContent>
          <TabsContent
            value="themes"
            keepMounted
            className="flex min-h-0 flex-1 flex-col"
          >
            <PrismWorkbenchPanel
              themes={workbench.themes}
              selectedTheme={workbench.selectedTheme}
              tuning={workbench.tuning}
              previewVariant={workbench.previewVariant}
              activeVariant={workbench.activeVariant}
              onSelectTheme={workbench.selectTheme}
              onAddTheme={workbench.addTheme}
              onRemoveTheme={workbench.removeSelectedTheme}
              onRestoreTheme={workbench.restoreSelectedTheme}
              onTuningChange={workbench.setTuning}
              onAnchorColorChange={workbench.setAnchorColor}
              onAnchorContrastChange={workbench.setAnchorContrast}
              onPreviewVariantChange={workbench.setPreviewVariant}
              onResetAll={workbench.resetAll}
            />
          </TabsContent>
          <TabsContent
            value="voice"
            keepMounted
            className="flex min-h-0 flex-1 flex-col"
          >
            <VoiceStagePreviewPanel />
          </TabsContent>
        </Tabs>
      </Card>
    </div>
  )
}
