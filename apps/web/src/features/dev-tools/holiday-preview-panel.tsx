// design-allow-file hardcoded-string: internal developer holiday preview panel.
import {
  HOLIDAY_CATALOG,
  findHoliday,
  useHolidayPreview,
  type HolidayOverride,
} from '@syrnike13/ui/holidays'
import { Button } from '@syrnike13/ui/primitives/button'
import { useTranslations, type Translator } from '@syrnike13/ui/i18n'

import {
  BellIcon,
  CheckIcon,
  HomeIcon,
  RotateCcwIcon,
  SearchIcon,
  SmileIcon,
} from '#/components/icons'

const ICON_PREVIEWS = [
  { key: 'home', Icon: HomeIcon },
  { key: 'notifications', Icon: BellIcon },
  { key: 'emoji', Icon: SmileIcon },
  { key: 'search', Icon: SearchIcon },
] as const

function OverrideChip({
  label,
  selected,
  onSelect,
}: {
  label: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant={selected ? 'secondary' : 'outline'}
      aria-pressed={selected}
      onClick={onSelect}
    >
      {selected ? <CheckIcon className="size-3" /> : null}
      {label}
    </Button>
  )
}

function overrideLabel(override: HolidayOverride, t: Translator) {
  if (override === 'auto') return 'Auto · calendar'
  if (override === 'off') return 'Off'
  const holiday = findHoliday(override)
  return holiday ? t(holiday.labelKey) : override
}

/**
 * Dev-only switch for date-driven seasonal icons.
 *
 * Previews any catalog holiday month-independently, persists the choice in
 * localStorage and drives the same provider contract as a real holiday date.
 */
export function HolidayPreviewPanel() {
  const t = useTranslations('holidays')
  const { active, override, setOverride, todayKey } = useHolidayPreview()

  const activeLabel = active ? t(active.holiday.labelKey) : null

  return (
    <>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pt-1 pb-3">
        <div className="space-y-1 rounded-lg border p-2.5 text-xs">
          <p className="flex items-center justify-between gap-2 text-muted-foreground">
            <span>Today (local)</span>
            <span className="tabular-nums">{todayKey}</span>
          </p>
          <p className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Active</span>
            <span className="truncate">
              {active && activeLabel
                ? `${activeLabel} · ${active.source === 'override' ? 'dev override' : 'calendar'}`
                : 'None'}
            </span>
          </p>
          <p className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Preview</span>
            <span className="truncate">{overrideLabel(override, t)}</span>
          </p>
        </div>

        <div className="space-y-1.5">
          <span className="text-xs font-medium">Preview</span>
          <div className="flex flex-wrap gap-1">
            <OverrideChip
              label="Auto · calendar"
              selected={override === 'auto'}
              onSelect={() => setOverride('auto')}
            />
            <OverrideChip
              label="Off"
              selected={override === 'off'}
              onSelect={() => setOverride('off')}
            />
            {HOLIDAY_CATALOG.map((holiday) => (
              <OverrideChip
                key={holiday.id}
                label={t(holiday.labelKey)}
                selected={override === holiday.id}
                onSelect={() => setOverride(holiday.id)}
              />
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <span className="text-xs font-medium">Icon replacements</span>
          <div className="grid grid-cols-4 gap-2">
            {ICON_PREVIEWS.map(({ key, Icon }) => (
              <div
                key={key}
                className="flex flex-col items-center gap-1 rounded-md bg-muted/40 p-2"
              >
                <Icon className="size-5" />
                <span className="text-xs text-muted-foreground">{key}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Preview persists in localStorage and selects the holiday independently
          of the calendar. Only Home has a seasonal replacement; other icons
          stay unchanged.
        </p>
      </div>

      <div className="shrink-0 border-t px-4 py-2.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full justify-start"
          disabled={override === 'auto'}
          onClick={() => setOverride('auto')}
        >
          <RotateCcwIcon className="size-4" />
          Reset to calendar
        </Button>
      </div>
    </>
  )
}
