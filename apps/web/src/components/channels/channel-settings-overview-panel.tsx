import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Trash2Icon } from '#/components/icons'
import type {
  Channel,
  DataEditChannel,
  FieldsChannel,
} from '@syrnike13/api-types'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { Slider } from '#/components/ui/slider'
import { Textarea } from '#/components/ui/textarea'
import { SettingsToggleRow } from '#/components/settings/settings-panels'
import {
  useDraftRegistration,
  type DraftController,
} from '#/components/settings/draft-controller-context'
import { useAuth } from '#/features/auth/auth-context'
import { deleteChannel, editChannel } from '#/features/api/channels-api'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { pickDefaultChannelId } from '#/features/sync/selectors'
import {
  buildVoiceChannelVoicePatch,
  channelAudioBitrateKbps,
  channelMaxUsers,
  DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
  MAX_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
  MIN_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
} from '#/lib/channel-audio-bitrate'
import { isServerVoiceChannel } from '#/lib/channel-voice'
import { syncStore } from '#/features/sync/sync-store'
import { cn } from '#/lib/utils'

type ServerChannel = Extract<
  Channel,
  { channel_type: 'TextChannel' | 'VoiceChannel' }
>

const SLOWMODE_OPTIONS = [
  { value: 0, label: 'Выкл.' },
  { value: 5, label: '5 сек.' },
  { value: 10, label: '10 сек.' },
  { value: 15, label: '15 сек.' },
  { value: 30, label: '30 сек.' },
  { value: 60, label: '1 мин.' },
  { value: 120, label: '2 мин.' },
  { value: 300, label: '5 мин.' },
  { value: 600, label: '10 мин.' },
  { value: 900, label: '15 мин.' },
  { value: 1800, label: '30 мин.' },
  { value: 3600, label: '1 ч.' },
  { value: 7200, label: '2 ч.' },
  { value: 21600, label: '6 ч.' },
]

function maxUsersSliderValue(maxUsers: number | null) {
  return maxUsers ?? 0
}

function maxUsersFromSliderValue(value: number): number | null {
  return value <= 0 ? null : value
}

function SettingsField({
  label,
  description,
  children,
  className,
}: {
  label: string
  description?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        'border-b border-border/60 py-6 last:border-b-0',
        className,
      )}
    >
      <div className="mb-4">
        <h3 className="text-base font-semibold">{label}</h3>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div>{children}</div>
    </section>
  )
}

export function ChannelSettingsOverviewPanel({
  channel,
}: {
  channel: ServerChannel
}) {
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const voiceChannel = isServerVoiceChannel(channel)
  const textChannel = channel.channel_type === 'TextChannel'
  const [name, setName] = useState(channel.name)
  const [slowmode, setSlowmode] = useState(
    textChannel ? (channel.slowmode ?? 0) : 0,
  )
  const [topic, setTopic] = useState(
    textChannel ? (channel.description ?? '') : '',
  )
  const [nsfw, setNsfw] = useState(textChannel ? Boolean(channel.nsfw) : false)
  const [audioBitrateKbps, setAudioBitrateKbps] = useState(() =>
    channelAudioBitrateKbps(channel),
  )
  const [maxUsers, setMaxUsers] = useState<number | null>(() =>
    channelMaxUsers(channel),
  )
  const [saving, setSaving] = useState(false)
  const [deletingChannel, setDeletingChannel] = useState(false)

  useEffect(() => {
    setName(channel.name)
    if (textChannel) {
      setSlowmode(channel.slowmode ?? 0)
      setTopic(channel.description ?? '')
      setNsfw(Boolean(channel.nsfw))
    }
    if (voiceChannel) {
      setAudioBitrateKbps(channelAudioBitrateKbps(channel))
      setMaxUsers(channelMaxUsers(channel))
    }
  }, [channel, textChannel, voiceChannel])

  const isDirty = useMemo(() => {
    const trimmedName = name.trim()
    const currentTopic = textChannel ? (channel.description ?? '') : ''
    const topicChanged = textChannel && topic.trim() !== currentTopic.trim()
    const nameChanged = trimmedName !== channel.name
    const slowmodeChanged = textChannel && slowmode !== (channel.slowmode ?? 0)
    const nsfwChanged = textChannel && nsfw !== Boolean(channel.nsfw)
    const audioBitrateChanged =
      voiceChannel && audioBitrateKbps !== channelAudioBitrateKbps(channel)
    const maxUsersChanged =
      voiceChannel && maxUsers !== channelMaxUsers(channel)

    return (
      nameChanged ||
      topicChanged ||
      slowmodeChanged ||
      nsfwChanged ||
      audioBitrateChanged ||
      maxUsersChanged
    )
  }, [
    audioBitrateKbps,
    channel,
    maxUsers,
    name,
    nsfw,
    slowmode,
    textChannel,
    topic,
    voiceChannel,
  ])

  const resetDraft = useCallback((): boolean => {
    setName(channel.name)
    if (textChannel) {
      setSlowmode(channel.slowmode ?? 0)
      setTopic(channel.description ?? '')
      setNsfw(Boolean(channel.nsfw))
    }
    if (voiceChannel) {
      setAudioBitrateKbps(channelAudioBitrateKbps(channel))
      setMaxUsers(channelMaxUsers(channel))
    }
    return true
  }, [channel, textChannel, voiceChannel])

  const save = useCallback(async (): Promise<boolean> => {
    const token = auth.session?.token
    const trimmedName = name.trim()
    const trimmedTopic = topic.trim()
    if (!token || !trimmedName) {
      toast.error('Укажите название канала')
      return false
    }

    if (!isDirty) return true

    const nameChanged = trimmedName !== channel.name
    const currentTopic = textChannel ? (channel.description ?? '') : ''
    const topicChanged = textChannel && trimmedTopic !== currentTopic.trim()
    const slowmodeChanged = textChannel && slowmode !== (channel.slowmode ?? 0)
    const nsfwChanged = textChannel && nsfw !== Boolean(channel.nsfw)
    const audioBitrateChanged =
      voiceChannel && audioBitrateKbps !== channelAudioBitrateKbps(channel)
    const maxUsersChanged =
      voiceChannel && maxUsers !== channelMaxUsers(channel)

    setSaving(true)
    try {
      const patch: DataEditChannel = {}
      const remove: FieldsChannel[] = []

      if (nameChanged) patch.name = trimmedName
      if (topicChanged) {
        if (trimmedTopic) {
          patch.description = trimmedTopic
        } else {
          remove.push('Description')
        }
      }
      if (slowmodeChanged) patch.slowmode = slowmode
      if (nsfwChanged) patch.nsfw = nsfw
      if (voiceChannel && (audioBitrateChanged || maxUsersChanged)) {
        Object.assign(
          patch,
          buildVoiceChannelVoicePatch(channel, {
            ...(audioBitrateChanged
              ? { audio_bitrate_kbps: audioBitrateKbps }
              : {}),
            ...(maxUsersChanged ? { max_users: maxUsers } : {}),
          }),
        )
      }
      if (remove.length) patch.remove = remove

      const updated = await editChannel(token, channel._id, patch)
      syncStore.patchChannel(channel._id, updated)
      return true
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось сохранить',
      )
      return false
    } finally {
      setSaving(false)
    }
  }, [
    audioBitrateKbps,
    auth.session?.token,
    channel,
    isDirty,
    maxUsers,
    name,
    nsfw,
    slowmode,
    textChannel,
    topic,
    voiceChannel,
  ])

  const draftRegistration = useMemo(
    (): DraftController => ({
      isDirty,
      isSaving: saving,
      save,
      reset: resetDraft,
    }),
    [isDirty, resetDraft, save, saving],
  )

  useDraftRegistration(draftRegistration)

  async function deleteCurrentChannel() {
    const token = auth.session?.token
    if (!token) return
    if (
      !window.confirm(
        `Удалить канал «${channel.name}»? Это действие необратимо.`,
      )
    ) {
      return
    }

    setDeletingChannel(true)
    try {
      await deleteChannel(token, channel._id)
      syncStore.removeChannel(channel._id)
      toast.success('Канал удалён')

      const fallback = pickDefaultChannelId(
        syncStore.getState(),
        auth.user?._id,
      )
      if (fallback) {
        await navigate({
          to: `${prefix}/c/$channelId`,
          params: { channelId: fallback },
          search: { m: undefined },
        })
      } else {
        await navigate({ to: prefix, search: { tab: 'online' } })
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось удалить канал',
      )
    } finally {
      setDeletingChannel(false)
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Обзор</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Основные параметры канала #{channel.name}
        </p>
      </div>

      <div>
        <SettingsField label="Имя">
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-rename" className="sr-only">
              Имя
            </Label>
            <Input
              id="channel-rename"
              value={name}
              maxLength={32}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        </SettingsField>

        {textChannel ? (
          <SettingsField
            label="Тема канала"
            description="Коротко опишите, для чего этот канал."
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="channel-topic" className="sr-only">
                Тема канала
              </Label>
              <Textarea
                id="channel-topic"
                value={topic}
                rows={3}
                maxLength={1024}
                placeholder="О чём этот канал"
                onChange={(event) => setTopic(event.target.value)}
              />
            </div>
          </SettingsField>
        ) : null}

        {textChannel ? (
          <SettingsField label="Медленный режим">
            <div className="flex flex-col gap-2">
              <Label htmlFor="channel-slowmode" className="sr-only">
                Медленный режим
              </Label>
              <Select
                value={String(slowmode)}
                onValueChange={(value) => setSlowmode(Number(value))}
              >
                <SelectTrigger id="channel-slowmode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SLOWMODE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={String(option.value)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </SettingsField>
        ) : null}

        {textChannel ? (
          <SettingsField label="Ограничение возраста">
            <SettingsToggleRow
              label="Пометить канал как 18+"
              hint="Участникам нужно подтвердить возраст, чтобы видеть канал."
              checked={nsfw}
              onCheckedChange={setNsfw}
            />
          </SettingsField>
        ) : null}

        {voiceChannel ? (
          <SettingsField
            label="Битрейт"
            description="Качество аудио для микрофона и звука экрана."
          >
            <Slider
              id="channel-audio-bitrate"
              aria-label="Битрейт"
              value={[audioBitrateKbps]}
              min={MIN_VOICE_CHANNEL_AUDIO_BITRATE_KBPS}
              max={MAX_VOICE_CHANNEL_AUDIO_BITRATE_KBPS}
              step={1}
              checkpoints={[
                {
                  value: MIN_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
                  label: String(MIN_VOICE_CHANNEL_AUDIO_BITRATE_KBPS),
                },
                {
                  value: DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
                  label: `${DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS}kbps`,
                },
                {
                  value: MAX_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
                  label: String(MAX_VOICE_CHANNEL_AUDIO_BITRATE_KBPS),
                },
              ]}
              tooltipContent={(value) => `${value} kbps`}
              onValueChange={([next]) => {
                if (next == null) return
                setAudioBitrateKbps(next)
              }}
            />
          </SettingsField>
        ) : null}

        {voiceChannel ? (
          <SettingsField
            label="Лимит пользователей"
            description="Сколько участников могут одновременно находиться в голосовом канале."
          >
            <Slider
              id="channel-max-users"
              aria-label="Лимит пользователей"
              value={[maxUsersSliderValue(maxUsers)]}
              min={0}
              max={99}
              step={1}
              checkpoints={[
                { value: 0, label: '∞' },
                { value: 99, label: '99' },
              ]}
              tooltipContent={(value) =>
                value <= 0 ? 'Без ограничений' : String(value)
              }
              onValueChange={([next]) => {
                if (next == null) return
                setMaxUsers(maxUsersFromSliderValue(next))
              }}
            />
          </SettingsField>
        ) : null}

        <SettingsField
          label="Опасная зона"
          description="Удаление канала невозможно отменить."
          className="mt-6"
        >
          <div className="flex flex-col gap-4 rounded-md border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-medium text-destructive">Удалить канал</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Канал и его сообщения будут удалены для всех.
              </p>
            </div>
            <Button
              type="button"
              variant="destructive"
              disabled={saving || deletingChannel}
              onClick={() => void deleteCurrentChannel()}
            >
              <Trash2Icon className="size-4" />
              Удалить канал
            </Button>
          </div>
        </SettingsField>
      </div>
    </div>
  )
}
