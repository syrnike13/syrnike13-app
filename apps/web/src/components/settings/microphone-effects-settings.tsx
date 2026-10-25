import { useMemo, useState } from 'react'
import {
  AUDIO_EFFECT_BUILTIN_KINDS,
  AUDIO_EFFECT_BUILTINS,
  AUDIO_EFFECTS_MAX_SLOTS,
  type AudioEffectBuiltinKind,
  type AudioEffectParameterDefinition,
  type AudioEffectSlot,
  type AudioEffectSlotStatus,
  type AudioEffectSlotUpdate,
  type AudioEffectsStats,
  type AudioPluginInfo,
} from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Badge } from '@syrnike13/ui/primitives/badge'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@syrnike13/ui/primitives/command'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemTitle,
} from '@syrnike13/ui/primitives/item'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import { Switch } from '@syrnike13/ui/primitives/switch'

import {
  ChevronDownIcon,
  ChevronUpIcon,
  ExternalLinkIcon,
  PlusIcon,
  RefreshIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from '#/components/icons'
import { SettingsBlock } from '#/components/settings/settings-panels'
import { PresetSlider } from '#/components/ui/preset-slider'
import { useAudioEffects } from '#/features/voice/use-audio-effects'

const PERCENT_STOPS = [{ value: 0 }, { value: 100 }] as const

function newSlotId() {
  return crypto.randomUUID()
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(Math.abs(value) < 10 ? 1 : 0)
}

function ParameterSlider({
  definition,
  label,
  value,
  onChange,
}: {
  definition: AudioEffectParameterDefinition
  label: string
  value: number
  onChange: (value: number) => void
}) {
  const t = useTranslations('settings.voice.effects')
  const percent = definition.unit === 'percent'
  const display = (next: number) => t(`unit.${definition.unit}`, {
    value: percent ? Math.round(next * 100) : formatNumber(next),
  })
  return (
    <div className="space-y-1">
      <p className="text-sm text-muted-foreground">{label}</p>
      <PresetSlider
        stops={[{ value: definition.minimum }, { value: definition.maximum }]}
        value={value}
        mode="continuous"
        step={definition.step}
        showLabels={false}
        showMarks={false}
        onValueChange={onChange}
        formatValue={display}
        aria-label={label}
      />
    </div>
  )
}

function SlotRow({
  slot,
  status,
  index,
  count,
  onMove,
  onRemove,
  updateSlot,
  openEditor,
  load,
}: {
  slot: AudioEffectSlot
  status: AudioEffectSlotStatus | undefined
  load: AudioEffectsStats['slots'][number] | undefined
  index: number
  count: number
  onMove: (from: number, to: number) => void
  onRemove: (slotId: string) => void
  updateSlot: (update: AudioEffectSlotUpdate) => void
  openEditor: (slotId: string) => void
}) {
  const t = useTranslations('settings.voice.effects')
  const name = slot.kind === 'builtin' ? t(`builtin.${slot.builtin}`) : slot.name
  const failed = status?.state === 'failed'
  const latencyMs = status?.latencySamples ? status.latencySamples / 48 : 0
  // A 10 ms frame is the whole budget of the realtime voice path.
  const loadText = load && load.averageUs > 0 && slot.enabled
    ? t('load', { ms: (load.averageUs / 1000).toFixed(2), percent: (load.averageUs / 100).toFixed(1) })
    : null

  return (
    <Item variant="outline">
      <ItemContent className="min-w-0">
        <ItemTitle className="min-w-0">
          <span className="truncate">{name}</span>
          {status?.state === 'loading' ? <Badge variant="secondary">{t('loading')}</Badge> : null}
          {failed ? (
            <Badge variant="destructive">
              <TriangleAlertIcon />
              {t('failed')}
            </Badge>
          ) : null}
        </ItemTitle>
        {slot.kind === 'vst3' || failed || latencyMs >= 1 || loadText ? (
          <ItemDescription className="truncate">
            {[
              slot.kind === 'vst3' ? slot.vendor : null,
              loadText,
              latencyMs >= 1 ? t('latency', { value: Math.round(latencyMs) }) : null,
              failed && !status?.crashed ? status?.error : null,
            ].filter(Boolean).join(' · ')}
          </ItemDescription>
        ) : null}
        {status?.crashed ? <ItemDescription className="text-destructive">{t('crashed')}</ItemDescription> : null}
        {load && load.overDeadline > 0 ? (
          <ItemDescription className="text-destructive">{t('overDeadline', { count: load.overDeadline })}</ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions>
        {slot.kind === 'vst3' && status?.hasEditor ? (
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => openEditor(slot.slotId)}>
            <ExternalLinkIcon />
            <span className="sr-only">{t('openEditor')}</span>
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0}
          onClick={() => onMove(index, index - 1)}>
          <ChevronUpIcon />
          <span className="sr-only">{t('moveUp')}</span>
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" disabled={index === count - 1}
          onClick={() => onMove(index, index + 1)}>
          <ChevronDownIcon />
          <span className="sr-only">{t('moveDown')}</span>
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => onRemove(slot.slotId)}>
          <Trash2Icon />
          <span className="sr-only">{t('remove')}</span>
        </Button>
        <Switch
          checked={slot.enabled}
          aria-label={t('enabledAria', { name })}
          onCheckedChange={(enabled) => updateSlot({ slotId: slot.slotId, enabled })}
        />
      </ItemActions>
      <ItemFooter className="flex-col items-stretch gap-3">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">{t('mix')}</p>
          <PresetSlider
            stops={PERCENT_STOPS}
            value={Math.round(slot.mix * 100)}
            mode="continuous"
            step={1}
            showLabels={false}
            showMarks={false}
            disabled={!slot.enabled}
            onValueChange={(value) => updateSlot({ slotId: slot.slotId, mix: value / 100 })}
            formatValue={(value) => `${value}%`}
            aria-label={t('mixAria', { name })}
          />
        </div>
        {slot.kind === 'builtin' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {AUDIO_EFFECT_BUILTINS[slot.builtin].parameters.map((definition) => (
              <ParameterSlider
                key={definition.id}
                definition={definition}
                label={t(`param.${definition.id}`)}
                value={slot.params[definition.id] ?? definition.initial}
                onChange={(value) => updateSlot({ slotId: slot.slotId, params: { [definition.id]: value } })}
              />
            ))}
          </div>
        ) : null}
      </ItemFooter>
    </Item>
  )
}

function AddEffectButton({
  plugins,
  scanning,
  disabled,
  onAddBuiltin,
  onAddPlugin,
  onRescan,
  onEnsureCatalog,
}: {
  plugins: readonly AudioPluginInfo[]
  scanning: boolean
  disabled: boolean
  onAddBuiltin: (kind: AudioEffectBuiltinKind) => void
  onAddPlugin: (plugin: AudioPluginInfo) => void
  onRescan: () => void
  onEnsureCatalog: () => void
}) {
  const t = useTranslations('settings.voice.effects')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const needle = query.trim().toLocaleLowerCase()
  const matches = (text: string) => needle.length === 0 || text.toLocaleLowerCase().includes(needle)
  const builtins = AUDIO_EFFECT_BUILTIN_KINDS.filter((kind) => matches(t(`builtin.${kind}`)))
  const found = plugins.filter((plugin) => matches(`${plugin.name} ${plugin.vendor}`))

  return (
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next)
      // Listing plugins loads them, so it waits for the list to be opened.
      if (next) onEnsureCatalog()
    }}>
      <PopoverTrigger
        render={
          <Button type="button" size="sm" disabled={disabled}>
            <PlusIcon data-icon="inline-start" />
            {t('add')}
          </Button>
        }
      />
      <PopoverContent align="start" side="bottom" sideOffset={6} className="w-80 max-w-full p-0">
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder={t('search')} />
          <CommandList className="max-h-80">
            <CommandEmpty>{scanning ? t('scanning') : t('noPlugins')}</CommandEmpty>
            {builtins.length > 0 ? (
              <CommandGroup heading={t('builtinGroup')}>
                {builtins.map((kind) => (
                  <CommandItem key={kind} value={`builtin:${kind}`} onSelect={() => {
                    onAddBuiltin(kind)
                    setOpen(false)
                  }}>
                    {t(`builtin.${kind}`)}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {found.length > 0 ? (
              <CommandGroup heading={t('pluginsGroup')}>
                {found.map((plugin) => (
                  <CommandItem key={`${plugin.path}|${plugin.classId}`} value={`${plugin.path}|${plugin.classId}`}
                    onSelect={() => {
                      onAddPlugin(plugin)
                      setOpen(false)
                    }}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate">{plugin.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{plugin.vendor}</p>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem value="rescan" disabled={scanning} onSelect={onRescan}>
                <RefreshIcon />
                {scanning ? t('scanning') : t('rescan')}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Microphone effect chain of the Windows desktop app. */
export function MicrophoneEffectsSettings() {
  const t = useTranslations('settings.voice.effects')
  const { state, catalog, stats, setChain, updateSlot, openEditor, scanPlugins, ensureCatalog } = useAudioEffects()
  const slots = state?.slots ?? []
  const statuses = useMemo(
    () => new Map(state?.statuses.map((status) => [status.slotId, status])),
    [state?.statuses],
  )

  const add = (slot: AudioEffectSlot) => setChain([...slots, slot])
  const move = (from: number, to: number) => {
    const next = [...slots]
    const [slot] = next.splice(from, 1)
    if (slot) next.splice(to, 0, slot)
    setChain(next)
  }

  return (
    <SettingsBlock title={t('title')} description={t('description')}>
      <div className="space-y-3">
        {state?.host === 'failed' ? (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
            {t('hostFailed')}
          </p>
        ) : null}
        {state?.host === 'starting' ? (
          <p className="text-sm text-muted-foreground">{t('hostStarting')}</p>
        ) : null}
        {slots.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ItemGroup className="gap-2">
            {slots.map((slot, index) => (
              <SlotRow
                key={slot.slotId}
                slot={slot}
                status={statuses.get(slot.slotId)}
                index={index}
                count={slots.length}
                onMove={move}
                updateSlot={updateSlot}
                openEditor={openEditor}
                load={stats?.slots.find((value) => value.slotId === slot.slotId)}
                onRemove={(slotId) => setChain(slots.filter((value) => value.slotId !== slotId))}
              />
            ))}
          </ItemGroup>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <AddEffectButton
            plugins={catalog?.plugins ?? []}
            scanning={catalog?.scanning ?? false}
            disabled={state === null || slots.length >= AUDIO_EFFECTS_MAX_SLOTS}
            onAddBuiltin={(kind) => add({
              slotId: newSlotId(), kind: 'builtin', builtin: kind,
              mix: AUDIO_EFFECT_BUILTINS[kind].initialMix, enabled: true,
              params: Object.fromEntries(AUDIO_EFFECT_BUILTINS[kind].parameters.map((value) => [value.id, value.initial])),
            })}
            onAddPlugin={(plugin) => add({
              slotId: newSlotId(), kind: 'vst3', path: plugin.path, classId: plugin.classId,
              name: plugin.name, vendor: plugin.vendor, mix: 1, enabled: true,
            })}
            onRescan={scanPlugins}
            onEnsureCatalog={ensureCatalog}
          />
          {stats ? (
            <span className="text-sm text-muted-foreground">
              {t('hostLoad', { cpu: stats.processCpuPercent.toFixed(1), memory: Math.round(stats.privateMegabytes) })}
            </span>
          ) : null}
          {catalog && catalog.failures.length > 0 ? (
            <span className="text-sm text-muted-foreground" title={catalog.failures.map((failure) => failure.path).join('\n')}>
              {t('scanFailures', { count: catalog.failures.length })}
            </span>
          ) : null}
        </div>
      </div>
    </SettingsBlock>
  )
}
