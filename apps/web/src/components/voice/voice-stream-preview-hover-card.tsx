import { useEffect, useState, type ReactNode } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@syrnike13/ui/primitives/hover-card'
import { Button } from '@syrnike13/ui/primitives/button'
import { VoiceOnAirBadge } from './voice-participant-icons'
import { useAuth } from '#/features/auth/auth-context'
import { useVoiceStage } from '#/features/voice/voice-stage-context'
import { useWatchParticipantScreenShare } from '#/features/voice/use-watch-participant-screen-share'
import { stageMediaItemId } from '#/features/voice/voice-stage-media'
import { streamPreviewWatchLabel } from '#/features/voice/stream-preview'
import { apiBlobRequest } from '@syrnike13/client/api/client'
import { recordDiagnosticEvent } from '#/features/diagnostics/diagnostic-reporter'

export function StreamPreviewCardContent({
  imageUrl,
  loading,
  self,
  watching,
  onWatch,
}: {
  imageUrl: string | null
  loading: boolean
  self: boolean
  watching: boolean
  onWatch: () => void
}) {
  const t = useTranslations('voice')
  const [imageFailed, setImageFailed] = useState(false)
  useEffect(() => setImageFailed(false), [imageUrl])
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3 text-sm font-semibold">
        {t('stream.nowStreaming')} <VoiceOnAirBadge />
      </div>
      <div
        className="relative mb-3 flex aspect-video items-center justify-center overflow-hidden rounded-md bg-muted text-center text-sm text-muted-foreground"
        aria-busy={loading}
      >
        {imageUrl && !imageFailed ? (
          <img
            src={imageUrl}
            alt={t('stream.previewAlt')}
            className="size-full object-contain"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <span className={loading ? 'animate-pulse px-3' : 'px-3'}>
            {loading
              ? t('stream.loadingPreview')
              : t('stream.previewUnavailable')}
          </span>
        )}
      </div>
      <Button className="w-full" disabled={self || watching} onClick={onWatch}>
        {streamPreviewWatchLabel(self, watching, t)}
      </Button>
    </>
  )
}

export function VoiceStreamPreviewHoverCard({
  channelId,
  userId,
  children,
  suspended = false,
}: {
  channelId: string
  userId: string
  children: ReactNode
  suspended?: boolean
}) {
  const auth = useAuth()
  const voice = useVoiceStage()
  const watch = useWatchParticipantScreenShare()
  const [open, setOpen] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const token = auth.session?.token
  useEffect(() => {
    if (suspended) setOpen(false)
  }, [suspended])
  useEffect(() => {
    if (!open || !token) return
    const abort = new AbortController()
    let url: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      setLoading(true)
      try {
        const blob = await apiBlobRequest(
          `/channels/${channelId}/voice/stream-preview/${userId}?t=${Date.now()}`,
          { token, signal: abort.signal, cache: 'no-store' },
        )
        if (abort.signal.aborted) return
        const next = blob ? URL.createObjectURL(blob) : null
        if (url) URL.revokeObjectURL(url)
        url = next
        setImageUrl(next)
      } catch (error) {
        if (!abort.signal.aborted) {
          setImageUrl(null)
          if (url) URL.revokeObjectURL(url)
          url = null
          recordDiagnosticEvent(
            'voice',
            'stream_preview_fetch_failed',
            { message: String(error) },
            { dedupeKey: 'stream-preview-fetch', heartbeatMs: 120_000 },
          )
        }
      } finally {
        if (!abort.signal.aborted) {
          setLoading(false)
          timer = setTimeout(() => {
            void refresh()
          }, 30_000)
        }
      }
    }
    setImageUrl(null)
    void refresh()
    return () => {
      abort.abort()
      clearTimeout(timer)
      if (url) URL.revokeObjectURL(url)
    }
  }, [open, token, channelId, userId])
  const self = auth.user?._id === userId
  const watching =
    voice.stageChannelId === channelId &&
    voice.viewedRemoteScreenIds.includes(stageMediaItemId(userId, 'screen'))
  return (
    <HoverCard
      open={open && !suspended}
      onOpenChange={(next) => {
        if (!next || (!blocked && !suspended)) setOpen(next)
      }}
    >
      <HoverCardTrigger
        delay={500}
        closeDelay={200}
        render={
          <div
            onPointerDownCapture={() => {
              setBlocked(true)
              setOpen(false)
            }}
            onDragStartCapture={() => {
              setBlocked(true)
              setOpen(false)
            }}
            onPointerLeave={() => setBlocked(false)}
          />
        }
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={12}
        className="w-80"
      >
        <StreamPreviewCardContent
          imageUrl={imageUrl}
          loading={loading}
          self={self}
          watching={watching}
          onWatch={() => {
            setOpen(false)
            void watch(channelId, userId)
          }}
        />
      </HoverCardContent>
    </HoverCard>
  )
}
