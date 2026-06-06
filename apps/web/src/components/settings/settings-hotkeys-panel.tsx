import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircleIcon, Trash2Icon } from 'lucide-react'
import type {
  HotkeyBinding,
  HotkeyRegistrationResult,
  HotkeyRegistrationStatus,
} from '@syrnike13/platform'

import {
  SettingsBlock,
  SettingsRow,
} from '#/components/settings/settings-panels'
import { Button } from '#/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { Switch } from '#/components/ui/switch'
import { usePlatform } from '#/platform/use-platform'
import {
  HOTKEY_ACTIONS,
  canRegisterHotkeyAction,
  comboDisplayLabel,
  comboFromNativeInputEvent,
  findDuplicateCombos,
  getHotkeyAction,
  shouldCaptureRecordedInput,
} from '#/features/hotkeys/hotkey-combo'
import { cn } from '#/lib/utils'

const REGISTERABLE_ACTION = HOTKEY_ACTIONS.find((action) => action.available)!

export function SettingsHotkeysPanel() {
  const { desktop } = usePlatform()
  const [bindings, setBindings] = useState<HotkeyBinding[]>([])
  const [results, setResults] = useState<HotkeyRegistrationResult[]>([])
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const bindingsRef = useRef<HotkeyBinding[]>([])

  useEffect(() => {
    bindingsRef.current = bindings
  }, [bindings])

  useEffect(() => {
    if (!desktop) return
    let cancelled = false

    void desktop.hotkeys.setSuspended(true)
    void desktop.hotkeys.getBindings().then((loadedBindings) => {
      if (cancelled) return
      setBindings(loadedBindings)
      setLoaded(true)
      void saveBindings(loadedBindings)
    })

    const unsubscribe = desktop.hotkeys.onRecordedInput((event) => {
      setRecordingId((currentId) => {
        if (!currentId) return currentId
        if (!shouldCaptureRecordedInput(event)) return currentId
        const combo = comboFromNativeInputEvent(event)
        updateBindings(
          bindingsRef.current.map((binding) =>
            binding.id === currentId ? { ...binding, combo } : binding,
          ),
        )
        void desktop.hotkeys.stopRecording()
        return null
      })
    })

    return () => {
      cancelled = true
      unsubscribe()
      void desktop.hotkeys.stopRecording()
      void desktop.hotkeys.setSuspended(false)
    }
  }, [desktop])

  const resultById = useMemo(
    () => new Map(results.map((result) => [result.id, result.status])),
    [results],
  )
  const duplicateIds = useMemo(() => findDuplicateCombos(bindings), [bindings])

  if (!desktop) return null

  function updateBindings(nextBindings: HotkeyBinding[]) {
    setBindings(nextBindings)
    void saveBindings(nextBindings)
  }

  async function saveBindings(nextBindings: HotkeyBinding[]) {
    if (!desktop) return
    const nextResults = await desktop.hotkeys.setBindings(nextBindings)
    setResults(nextResults)
  }

  function patchBinding(id: string, patch: Partial<HotkeyBinding>) {
    updateBindings(
      bindings.map((binding) =>
        binding.id === id ? { ...binding, ...patch } : binding,
      ),
    )
  }

  function addBinding() {
    updateBindings([
      ...bindings,
      {
        id: createBindingId(),
        action: REGISTERABLE_ACTION.id,
        combo: null,
        enabled: true,
      },
    ])
  }

  function removeBinding(id: string) {
    updateBindings(bindings.filter((binding) => binding.id !== id))
  }

  function statusFor(binding: HotkeyBinding): HotkeyRegistrationStatus {
    if (!binding.enabled) return 'disabled'
    if (!binding.combo) return 'disabled'
    if (!canRegisterHotkeyAction(binding.action)) return 'unsupported'
    if (duplicateIds.has(binding.id)) return 'taken'
    return resultById.get(binding.id) ?? 'disabled'
  }

  async function startRecording(id: string) {
    setRecordingId(id)
    await desktop.hotkeys.startRecording()
  }

  return (
    <div className="space-y-2">
      <SettingsBlock title="Горячие клавиши">
        <div className="mb-4 flex justify-end">
          <Button type="button" size="sm" onClick={addBinding}>
            Добавить горячую клавишу
          </Button>
        </div>

        {!loaded ? (
          <p className="text-sm text-muted-foreground">Загрузка…</p>
        ) : bindings.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            Горячих клавиш пока нет.
          </div>
        ) : (
          <div className="space-y-0">
            {bindings.map((binding) => {
              const action = getHotkeyAction(binding.action)
              const status = statusFor(binding)
              const recording = recordingId === binding.id

              return (
                <SettingsRow key={binding.id} label={action.label} stacked>
                  <div className="grid w-full grid-cols-1 gap-3 md:grid-cols-[minmax(180px,1fr)_minmax(220px,1fr)_auto_auto] md:items-start">
                    <div className="space-y-1.5">
                      <p className="text-xs font-semibold text-muted-foreground">
                        Действие
                      </p>
                      <Select
                        value={binding.action}
                        onValueChange={(actionId) => {
                          patchBinding(binding.id, {
                            action: actionId as HotkeyBinding['action'],
                          })
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {HOTKEY_ACTIONS.map((item) => (
                            <SelectItem
                              key={item.id}
                              value={item.id}
                              disabled={!item.available}
                            >
                              {item.label}
                              {!item.available ? ' · Скоро' : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <p className="text-xs font-semibold text-muted-foreground">
                        Горячие клавиши
                      </p>
                      <button
                        type="button"
                        className={cn(
                          'flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm transition-colors',
                          recording
                            ? 'border-primary ring-2 ring-primary/20'
                            : 'hover:bg-accent/40',
                        )}
                        onClick={() => {
                          void startRecording(binding.id)
                        }}
                      >
                        <span
                          className={cn(
                            'truncate font-mono text-xs font-semibold',
                            !binding.combo && 'text-muted-foreground',
                          )}
                        >
                          {recording
                            ? 'Нажмите сочетание…'
                            : comboDisplayLabel(binding.combo)}
                        </span>
                        <span className="shrink-0 rounded bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                          {recording ? 'Запись' : 'Изменить'}
                        </span>
                      </button>
                      <HotkeyStatusMessage status={status} />
                    </div>

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="mt-5 size-9"
                      onClick={() => removeBinding(binding.id)}
                    >
                      <Trash2Icon className="size-4" />
                      <span className="sr-only">Удалить горячую клавишу</span>
                    </Button>

                    <div className="mt-6 flex justify-start md:justify-end">
                      <Switch
                        checked={binding.enabled}
                        disabled={!action.available}
                        onCheckedChange={(enabled) => {
                          patchBinding(binding.id, { enabled })
                        }}
                      />
                    </div>
                  </div>
                </SettingsRow>
              )
            })}
          </div>
        )}
      </SettingsBlock>
    </div>
  )
}

function HotkeyStatusMessage({
  status,
}: {
  status: HotkeyRegistrationStatus
}) {
  const message = statusMessage(status)
  if (!message) return null

  return (
    <p className="flex items-start gap-1.5 text-xs text-destructive">
      <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
      {message}
    </p>
  )
}

function statusMessage(status: HotkeyRegistrationStatus) {
  switch (status) {
    case 'registered':
    case 'disabled':
      return null
    case 'invalid':
      return 'Назначьте горячую клавишу.'
    case 'taken':
      return 'Эта комбинация уже используется.'
    case 'unsupported':
      return 'Это действие появится позже.'
  }
}

function createBindingId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `hotkey-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
