import { useEffect, useRef, useState } from 'react'
import { Effect } from 'effect'
import { useLocale, useTranslations } from '@syrnike13/ui/i18n'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@syrnike13/ui/primitives/alert-dialog'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import type { ActivityInstance } from '@syrnike13/api-types/gateway-schema'
import {
  LIMITS,
  type ActivityLayout,
  type AuthorizationScope,
  type JsonObject,
  type Leaderboard,
  type PlayerData,
  type Score,
} from '@syrnike13/activity-sdk/protocol'

import { useAuth } from '#/features/auth/auth-context'
import { syncStore } from '@syrnike13/client/sync/sync-store'
import {
  activityApiErrorCode,
  authorizeActivityEffect,
  fetchActivityLeaderboardEffect,
  fetchActivityPlayerDataEffect,
  putActivityPlayerDataEffect,
  putActivityScoreEffect,
  type ActivityApplication,
  type ActivityPlayerDataResponse,
  type ActivityScoreResponse,
} from './activity-api'
import {
  activityDataScope,
  activityOrigin,
  externalLinkUrl,
  readActivityTheme,
  toActivityParticipants,
  toActivityUser,
  toSharedState,
} from './activity-context'
import {
  ActivityFrameBridge,
  ActivityFrameError,
  type ActivityFrameHandlers,
} from './activity-frame-bridge'
import { activityStore } from './activity-store'
import { cn } from '#/lib/utils'

type ActivityFrameProps = {
  application: ActivityApplication
  instance: ActivityInstance
  currentUserId: string
  layout: ActivityLayout
  className?: string
}

type PromptRequest =
  | { kind: 'authorize'; scopes: readonly AuthorizationScope[] }
  | { kind: 'link'; url: string }

type PendingPrompt = PromptRequest & { resolve: (allowed: boolean) => void }

/** Iframe sandbox from ADR-0011: no popups, no top navigation. */
export const ACTIVITY_FRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-pointer-lock'
export const ACTIVITY_FRAME_ALLOW = 'autoplay; clipboard-write'

function serializedBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function runApi<A, E>(effect: Effect.Effect<A, E>) {
  return Effect.runPromise(effect).catch((error: unknown) => {
    throw new ActivityFrameError(activityApiErrorCode(error))
  })
}

function toPlayerData(response: ActivityPlayerDataResponse): PlayerData {
  return {
    data: response.data as JsonObject,
    trusted: response.trusted,
    updatedAt: response.updated_at ?? null,
  }
}

function toScore(response: ActivityScoreResponse): Score {
  return {
    user: toActivityUser(response.user_id, syncStore.getState().users),
    value: response.value,
    trusted: response.trusted,
    updatedAt: response.updated_at,
  }
}

/**
 * Activity Frame (ADR-0011): embeds the Activity Origin and bridges the SDK
 * protocol to the gateway and REST. Session tokens never reach the iframe.
 */
export function ActivityFrame({
  application,
  instance,
  currentUserId,
  layout,
  className,
}: ActivityFrameProps) {
  const t = useTranslations('activities')
  const auth = useAuth()
  const { locale } = useLocale()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const bridgeRef = useRef<ActivityFrameBridge | null>(null)
  const [connected, setConnected] = useState(false)
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null)
  const origin = activityOrigin(application.activity_url)

  const latest = useRef({
    application,
    instance,
    currentUserId,
    layout,
    locale,
    token: auth.session?.token ?? null,
  })
  latest.current = {
    application,
    instance,
    currentUserId,
    layout,
    locale,
    token: auth.session?.token ?? null,
  }

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || !origin) return

    const requireToken = () => {
      const token = latest.current.token
      if (!token) throw new ActivityFrameError('disconnected')
      return token
    }
    const ask = (next: PromptRequest) =>
      new Promise<boolean>((resolve) => {
        setPrompt((current) => {
          // One dialog at a time: a second request is declined.
          if (current) {
            resolve(false)
            return current
          }
          return { ...next, resolve }
        })
      })

    const handlers: ActivityFrameHandlers = {
      async ready() {
        const { application, instance, currentUserId, layout, locale } =
          latest.current
        const state =
          activityStore.sharedState(instance.id) ??
          (await activityStore.sync(instance.channel_id, instance.id))
        const users = syncStore.getState().users
        return {
          protocolVersion: 1,
          application: { id: application._id, name: application.name },
          instance: {
            id: instance.id,
            channelId: instance.channel_id,
            serverId: instance.server_id ?? null,
          },
          user: toActivityUser(currentUserId, users),
          participants: toActivityParticipants(instance, users),
          hostId: instance.host_id,
          state: toSharedState(state),
          locale,
          theme: readActivityTheme(document.documentElement),
          layout,
        }
      },
      async send({ payload, to }) {
        const { instance } = latest.current
        if (serializedBytes(payload) > LIMITS.messageBytes) {
          throw new ActivityFrameError('payload_too_large')
        }
        await activityStore.sendMessage(
          instance.channel_id,
          instance.id,
          payload,
          to,
        )
      },
      async setState({ expectedVersion, data }) {
        const { instance, currentUserId } = latest.current
        if (serializedBytes(data) > LIMITS.stateBytes) {
          throw new ActivityFrameError('payload_too_large')
        }
        const result = await activityStore.setState(
          instance.channel_id,
          instance.id,
          expectedVersion,
          data,
        )
        return {
          ok: result.ok,
          state: result.state
            ? toSharedState(result.state)
            : {
                version: expectedVersion + 1,
                data,
                updatedBy: currentUserId,
              },
        }
      },
      async getPlayerData() {
        const { application, instance } = latest.current
        return toPlayerData(
          await runApi(
            fetchActivityPlayerDataEffect(
              requireToken(),
              application._id,
              activityDataScope(instance),
            ),
          ),
        )
      },
      async setPlayerData({ data }) {
        const { application, instance } = latest.current
        if (serializedBytes(data) > LIMITS.playerDataBytes) {
          throw new ActivityFrameError('payload_too_large')
        }
        return toPlayerData(
          await runApi(
            putActivityPlayerDataEffect(
              requireToken(),
              application._id,
              activityDataScope(instance),
              data,
            ),
          ),
        )
      },
      async submitScore({ key, value, mode }) {
        const { application, instance } = latest.current
        return toScore(
          await runApi(
            putActivityScoreEffect(
              requireToken(),
              application._id,
              activityDataScope(instance),
              key,
              value,
              mode,
            ),
          ),
        )
      },
      async getLeaderboard({ key, limit, ascending }) {
        const { application, instance } = latest.current
        const response = await runApi(
          fetchActivityLeaderboardEffect(
            requireToken(),
            application._id,
            activityDataScope(instance),
            key,
            { limit, ascending },
          ),
        )
        const leaderboard: Leaderboard = {
          key: response.key,
          entries: response.entries.map(toScore),
          own: response.own ? toScore(response.own) : null,
        }
        return leaderboard
      },
      async authorize({ scopes }) {
        const { application } = latest.current
        const token = requireToken()
        if (!application.first_party) {
          const allowed = await ask({ kind: 'authorize', scopes })
          if (!allowed) throw new ActivityFrameError('cancelled')
        }
        const { code } = await runApi(
          authorizeActivityEffect(token, application._id, scopes),
        )
        return { code }
      },
      async openExternalLink({ url }) {
        const safeUrl = externalLinkUrl(url)
        if (!safeUrl) throw new ActivityFrameError('invalid_request')
        const allowed = await ask({ kind: 'link', url: safeUrl })
        if (!allowed) return { opened: false }
        // Electron routes http(s) window.open to the system browser.
        window.open(safeUrl, '_blank', 'noopener,noreferrer')
        return { opened: true }
      },
      async leave() {
        const { instance } = latest.current
        await activityStore.leave(instance.channel_id, instance.id)
      },
      async end() {
        const { instance } = latest.current
        await activityStore.end(instance.channel_id, instance.id)
      },
    }

    const bridge = new ActivityFrameBridge({
      iframe,
      origin,
      handlers,
      onConnect: () => setConnected(true),
    })
    bridgeRef.current = bridge

    const instanceId = latest.current.instance.id
    const unsubscribeInstance = activityStore.subscribeInstance(
      instanceId,
      (event) => {
        if (event.type === 'message') {
          bridge.emit('message', { from: event.from, payload: event.payload })
        } else if (event.type === 'state') {
          bridge.emit('state', toSharedState(event.state))
        } else {
          bridge.emit('ended', { reason: event.reason })
        }
      },
    )

    let status = activityStore.status
    const unsubscribeStore = activityStore.subscribe(() => {
      if (activityStore.status === status) return
      status = activityStore.status
      bridge.emit('connection', { status })
    })

    const root = document.documentElement
    const themeObserver = new MutationObserver(() => {
      bridge.emit('theme', readActivityTheme(root))
    })
    themeObserver.observe(root, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    })

    return () => {
      themeObserver.disconnect()
      unsubscribeStore()
      unsubscribeInstance()
      bridge.dispose()
      bridgeRef.current = null
      setConnected(false)
      setPrompt((current) => {
        current?.resolve(false)
        return null
      })
    }
  }, [origin, instance.id])

  useEffect(() => {
    bridgeRef.current?.emit('participants', {
      participants: toActivityParticipants(
        instance,
        syncStore.getState().users,
      ),
      hostId: instance.host_id,
    })
  }, [instance])

  useEffect(() => {
    bridgeRef.current?.emit('layout', { layout })
  }, [layout])

  useEffect(() => {
    bridgeRef.current?.emit('locale', { locale })
  }, [locale])

  const settlePrompt = (allowed: boolean) => {
    prompt?.resolve(allowed)
    setPrompt(null)
  }

  if (!origin) {
    return (
      <div
        role="alert"
        className="flex size-full items-center justify-center p-4 text-center text-sm text-muted-foreground"
      >
        {t('frame.unavailable')}
      </div>
    )
  }

  return (
    <div className={cn('relative size-full', className)}>
      <iframe
        ref={iframeRef}
        title={application.name}
        src={application.activity_url}
        sandbox={ACTIVITY_FRAME_SANDBOX}
        allow={ACTIVITY_FRAME_ALLOW}
        referrerPolicy="no-referrer"
        data-testid="activity-frame"
        className="size-full border-0 bg-background"
      />
      {!connected ? (
        <div
          role="status"
          className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-background text-sm text-muted-foreground"
        >
          <Spinner className="size-5" />
          {t('frame.loading')}
        </div>
      ) : null}

      <AlertDialog
        open={prompt !== null}
        onOpenChange={(open) => {
          if (!open) settlePrompt(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {prompt?.kind === 'authorize'
                ? t('authorize.title', { name: application.name })
                : t('externalLink.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {prompt?.kind === 'authorize'
                ? t('authorize.description', { name: application.name })
                : t('externalLink.description', { name: application.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {prompt?.kind === 'authorize' ? (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
              {prompt.scopes.map((scope) => (
                <li key={scope}>{t(`authorize.scopes.${scope}`)}</li>
              ))}
            </ul>
          ) : prompt?.kind === 'link' ? (
            <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-sm text-foreground">
              {prompt.url}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('dialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => settlePrompt(true)}>
              {prompt?.kind === 'authorize'
                ? t('authorize.allow')
                : t('externalLink.open')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
