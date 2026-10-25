import type {
  FeedbackPeripheral,
  FeedbackPeripheralConnection,
  FeedbackSystem,
} from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Button } from '@syrnike13/ui/primitives/button'
import { FieldError } from '@syrnike13/ui/primitives/field'
import { Input } from '@syrnike13/ui/primitives/input'
import { Label } from '@syrnike13/ui/primitives/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@syrnike13/ui/primitives/select'

import {
  PlusIcon,
  MonitorIcon,
  Trash2Icon,
} from '#/components/icons'
import { cn } from '#/lib/utils'

/** Mirrors the `maxItems` of `DataCreateFeedbackSuggestion.peripherals`. */
export const PERIPHERALS_MAX = 8
/** Mirrors the backend limit for one device name. */
export const PERIPHERAL_DEVICE_MAX_LENGTH = 80

export const PERIPHERAL_CONNECTIONS: readonly FeedbackPeripheralConnection[] = [
  'wireless_2_4_ghz',
  'bluetooth',
  'wired',
  'audio_card',
  'other',
]

const CONNECTION_KEYS: Record<
  FeedbackPeripheralConnection,
  `connection.${FeedbackPeripheralConnection}`
> = {
  wireless_2_4_ghz: 'connection.wireless_2_4_ghz',
  bluetooth: 'connection.bluetooth',
  wired: 'connection.wired',
  audio_card: 'connection.audio_card',
  other: 'connection.other',
}

/** A device row while it is being edited in the dialog. */
export type EditablePeripheral = FeedbackPeripheral & { key: string }

export function FeedbackSystemSummary({
  system,
  className,
}: {
  system: FeedbackSystem
  className?: string
}) {
  const t = useTranslations('feedback.system')

  const rows: Array<{ label: string; value: string }> = []
  if (system.os) rows.push({ label: t('os'), value: system.os })
  if (system.cpu) {
    rows.push({
      label: t('cpu'),
      value: system.cpu_threads
        ? `${system.cpu} · ${t('threadsValue', { count: system.cpu_threads })}`
        : system.cpu,
    })
  } else if (system.cpu_threads) {
    rows.push({
      label: t('cpu'),
      value: t('threadsValue', { count: system.cpu_threads }),
    })
  }
  if (system.gpu) rows.push({ label: t('gpu'), value: system.gpu })
  if (system.memory_bytes) {
    rows.push({
      label: t('memory'),
      value: t('memoryValue', {
        gb: Math.max(1, Math.round(system.memory_bytes / 1024 ** 3)),
      }),
    })
  }
  if (system.display) rows.push({ label: t('display'), value: system.display })

  return (
    <dl className={cn('grid gap-1.5 text-sm', className)}>
      {rows.map((row) => (
        <div key={row.label} className="flex min-w-0 items-baseline gap-3">
          <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 break-words text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function FeedbackPeripheralsSummary({
  peripherals,
}: {
  peripherals: FeedbackPeripheral[]
}) {
  const t = useTranslations('feedback.system')

  return (
    <ul className="flex flex-col gap-1 text-sm">
      {peripherals.map((peripheral, index) => (
        <li
          key={`${peripheral.device}-${peripheral.connection}-${index}`}
          className="flex min-w-0 items-baseline gap-3"
        >
          <span className="min-w-0 break-words text-foreground">
            {peripheral.device}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {t(CONNECTION_KEYS[peripheral.connection])}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function FeedbackSystemFields({
  system,
  busy,
  error,
  peripherals,
  profileSaved,
  canSaveProfile,
  onCollect,
  onClear,
  onAddPeripheral,
  onChangePeripheral,
  onRemovePeripheral,
  onSaveProfile,
}: {
  system: FeedbackSystem | null
  busy: boolean
  error: string | null
  peripherals: EditablePeripheral[]
  profileSaved: boolean
  canSaveProfile: boolean
  onCollect: () => void
  onClear: () => void
  onAddPeripheral: () => void
  onChangePeripheral: (
    key: string,
    patch: Partial<Omit<EditablePeripheral, 'key'>>,
  ) => void
  onRemovePeripheral: (key: string) => void
  onSaveProfile: () => void
}) {
  const t = useTranslations('feedback.create')
  const connections = useTranslations('feedback.system')

  return (
    <section className="space-y-3" aria-labelledby="feedback-system-label">
      <div className="space-y-1">
        <Label id="feedback-system-label">{t('systemTitle')}</Label>
        <p className="text-xs text-muted-foreground">{t('systemHint')}</p>
      </div>

      {system ? (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <FeedbackSystemSummary system={system} />
          <div className="flex flex-wrap items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCollect}
              disabled={busy}
            >
              {busy ? t('systemCollecting') : t('systemRefresh')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onClear}>
              {t('systemRemove')}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCollect}
          disabled={busy}
        >
          <MonitorIcon data-icon="inline-start" aria-hidden />
          {busy ? t('systemCollecting') : t('systemAdd')}
        </Button>
      )}

      <FieldError>{error}</FieldError>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label>{t('peripheralsTitle')}</Label>
          <span className="text-xs tabular-nums text-muted-foreground">
            {peripherals.length}/{PERIPHERALS_MAX}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{t('peripheralsHint')}</p>

        {peripherals.map((peripheral) => (
          <div key={peripheral.key} className="flex items-center gap-2">
            <Input
              value={peripheral.device}
              maxLength={PERIPHERAL_DEVICE_MAX_LENGTH}
              placeholder={t('peripheralPlaceholder')}
              aria-label={t('peripheralPlaceholder')}
              onChange={(event) =>
                onChangePeripheral(peripheral.key, { device: event.target.value })
              }
            />
            <Select
              value={peripheral.connection}
              onValueChange={(value) =>
                onChangePeripheral(peripheral.key, {
                  connection: value as FeedbackPeripheralConnection,
                })
              }
            >
              <SelectTrigger
                className="w-44 shrink-0"
                aria-label={t('peripheralConnectionLabel')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIPHERAL_CONNECTIONS.map((connection) => (
                  <SelectItem key={connection} value={connection}>
                    {connections(CONNECTION_KEYS[connection])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('removePeripheral', {
                name: peripheral.device || t('peripheralPlaceholder'),
              })}
              onClick={() => onRemovePeripheral(peripheral.key)}
            >
              <Trash2Icon aria-hidden />
            </Button>
          </div>
        ))}

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAddPeripheral}
          disabled={peripherals.length >= PERIPHERALS_MAX}
        >
          <PlusIcon data-icon="inline-start" aria-hidden />
          {t('addPeripheral')}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onSaveProfile}
          disabled={!canSaveProfile}
        >
          {profileSaved ? t('systemSaved') : t('systemSave')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('systemSaveHint')}</span>
      </div>
    </section>
  )
}
