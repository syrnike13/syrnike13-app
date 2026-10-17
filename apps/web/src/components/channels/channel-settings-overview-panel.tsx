import { useTranslations } from '@syrnike13/ui/i18n'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Trash2Icon } from '#/components/icons'
import type { DataEditChannel, FieldsChannel } from '@syrnike13/api-types'
import { Effect } from 'effect'
import { toast } from 'sonner'

import { Button } from '@syrnike13/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'
import { Input } from '@syrnike13/ui/primitives/input'
import { Label } from '@syrnike13/ui/primitives/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@syrnike13/ui/primitives/select'
import { Slider } from '@syrnike13/ui/primitives/slider'
import { Textarea } from '@syrnike13/ui/primitives/textarea'
import { SettingsToggleRow } from '#/components/settings/settings-panels'
import {
  useDraftRegistration,
  type DraftController,
} from '#/components/settings/draft-controller-context'
import { useAuth } from '#/features/auth/auth-context'
import {
  deleteChannelEffect,
  editChannelEffect,
} from '#/features/api/channels-api'
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
import {
  isServerVoiceChannel,
  type ServerChannel,
} from '#/lib/channel-voice'
import { syncStore } from '#/features/sync/sync-store'
import { cn } from '#/lib/utils'

const SLOWMODE_OPTIONS = [
  { value: 0, key: 'off' },
  { value: 5, key: '5s' },
  { value: 10, key: '10s' },
  { value: 15, key: '15s' },
  { value: 30, key: '30s' },
  { value: 60, key: '1m' },
  { value: 120, key: '2m' },
  { value: 300, key: '5m' },
  { value: 600, key: '10m' },
  { value: 900, key: '15m' },
  { value: 1800, key: '30m' },
  { value: 3600, key: '1h' },
  { value: 7200, key: '2h' },
  { value: 21600, key: '6h' },
] as const

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
  const t = useTranslations('channels.overview')
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
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
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
      toast.error(t('nameRequired'))
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

    return Effect.runPromise(
      editChannelEffect(token, channel._id, patch).pipe(
        Effect.tap((updated) =>
          Effect.sync(() => syncStore.patchChannel(channel._id, updated)),
        ),
        Effect.as(true),
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              error instanceof Error ? error.message : t('saveError'),
            )
            return false
          }),
        ),
        Effect.ensuring(Effect.sync(() => setSaving(false))),
      ),
    )
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

    setDeletingChannel(true)
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* deleteChannelEffect(token, channel._id)
        yield* Effect.sync(() => {
          syncStore.removeChannel(channel._id)
          setDeleteDialogOpen(false)
          toast.success(t('deleted'))
        })

        const fallback = pickDefaultChannelId(
          syncStore.getState(),
          auth.user?._id,
        )
        yield* Effect.tryPromise({
          try: () =>
            fallback
              ? navigate({
                  to: `${prefix}/c/$channelId`,
                  params: { channelId: fallback },
                  search: { m: undefined },
                })
              : navigate({ to: prefix, search: { tab: 'online' } }),
          catch: (cause) => cause,
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              error instanceof Error
                ? error.message
                : t('deleteError'),
            )
          }),
        ),
        Effect.ensuring(Effect.sync(() => setDeletingChannel(false))),
      ),
    )
  }

  return (
    <>
      <div>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">{t('title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('description', { channel: channel.name })}
        </p>
      </div>

      <div>
        <SettingsField label={t('name')}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-rename" className="sr-only">
              {t('name')}
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
            label={t('topicLabel')}
            description={t('topicDescription')}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="channel-topic" className="sr-only">
                {t('topicLabel')}
              </Label>
              <Textarea
                id="channel-topic"
                value={topic}
                rows={3}
                maxLength={1024}
                placeholder={t('topicPlaceholder')}
                onChange={(event) => setTopic(event.target.value)}
              />
            </div>
          </SettingsField>
        ) : null}

        {textChannel ? (
          <SettingsField label={t('slowMode')}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="channel-slowmode" className="sr-only">
                {t('slowMode')}
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
                      {t(`slowModeOptions.${option.key}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </SettingsField>
        ) : null}

        {textChannel ? (
          <SettingsField label={t('ageRestricted')}>
            <SettingsToggleRow
              label={t('ageRestricted')}
              hint={t('ageRestrictedHint')}
              checked={nsfw}
              onCheckedChange={setNsfw}
            />
          </SettingsField>
        ) : null}

        {voiceChannel ? (
          <SettingsField
            label={t('bitrate')}
            description={t('bitrateDescription')}
          >
            <Slider
              id="channel-audio-bitrate"
              aria-label={t('bitrate')}
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
            label={t('userLimit')}
            description={t('userLimitDescription')}
          >
            <Slider
              id="channel-max-users"
              aria-label={t('userLimit')}
              value={[maxUsersSliderValue(maxUsers)]}
              min={0}
              max={99}
              step={1}
              checkpoints={[
                { value: 0, label: '∞' },
                { value: 99, label: '99' },
              ]}
              tooltipContent={(value) =>
                value <= 0 ? t('unlimited') : String(value)
              }
              onValueChange={([next]) => {
                if (next == null) return
                setMaxUsers(maxUsersFromSliderValue(next))
              }}
            />
          </SettingsField>
        ) : null}

        <SettingsField
          label={t('dangerZone')}
          description={t('dangerDescription')}
          className="mt-6"
        >
          <div className="flex flex-col gap-4 rounded-md border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-medium text-destructive">{t('deleteChannel')}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('deleteDescription')}
              </p>
            </div>
            <Button
              type="button"
              variant="destructive"
              disabled={saving || deletingChannel}
              onClick={() => setDeleteDialogOpen(true)}
            >
              <Trash2Icon className="size-4" />
              {t('deleteChannel')}
            </Button>
          </div>
        </SettingsField>
      </div>
      </div>
      <Dialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          if (!open && !deletingChannel) {
            setDeleteDialogOpen(false)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('deleteTitle', { name: channel.name })}</DialogTitle>
            <DialogDescription>
              {t('deleteDialogDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={deletingChannel}
              onClick={() => setDeleteDialogOpen(false)}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deletingChannel}
              onClick={() => void deleteCurrentChannel()}
            >
              {t('deleteConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
