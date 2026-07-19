import { useCallback, useEffect, useRef } from 'react'
import { Gamepad2Icon, Loader2Icon, XIcon } from '#/components/icons'

import { Button } from '#/components/ui/button'
import {
  FIRST_PARTY_CHANNEL_ACTIVITIES,
  getFirstPartyChannelActivity,
  type FirstPartyChannelActivity,
} from './channel-activity-catalog'
import { channelActivityClient } from './channel-activity-client'
import {
  EMBEDDED_ACTIVITY_PROTOCOL_VERSION,
  isEmbeddedActivityClientMessage,
  readEmbeddedActivityTheme,
  type EmbeddedActivityHostMessage,
} from './embedded-activity-protocol'
import type {
  ChannelActivityErrorCode,
  ChannelActivityInstance,
  ChannelActivityViewState,
} from './channel-activity-types'

type ChannelActivityPanelProps = {
  channelId: string
  currentUserId: string
  activity: ChannelActivityViewState
  onClose: () => void
}

export function ChannelActivityPanel({
  channelId,
  currentUserId,
  activity,
  onClose,
}: ChannelActivityPanelProps) {
  const instance = activity.instance
  const instanceId = instance?.id
  const joined = instance?.participant_ids.includes(currentUserId) ?? false

  useEffect(() => {
    if (!instanceId || joined) return
    channelActivityClient.join(channelId, instanceId)
  }, [channelId, instanceId, joined])

  if (!instance) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="w-full max-w-2xl rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xl">
          <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Gamepad2Icon className="size-6" />
          </div>
          <h2 className="text-xl font-semibold">Активности</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Запустите общее приложение для участников этого голосового канала.
          </p>
          {activity.error ? (
            <p className="mt-3 text-sm text-destructive">
              Не удалось запустить Активность: {activity.error}
            </p>
          ) : null}
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {FIRST_PARTY_CHANNEL_ACTIVITIES.map((application) => (
              <div
                key={application.id}
                className="flex flex-col rounded-xl border border-border bg-background p-4"
              >
                <h3 className="font-medium text-foreground">
                  {application.title}
                </h3>
                <p className="mt-1 flex-1 text-sm text-muted-foreground">
                  {application.description}
                </p>
                <Button
                  type="button"
                  className="mt-4 self-start"
                  onClick={() =>
                    channelActivityClient.start(channelId, application.id)
                  }
                >
                  Запустить
                </Button>
              </div>
            ))}
          </div>
          <div className="mt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Назад
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (!joined) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <Loader2Icon className="mr-2 size-5 animate-spin" />
        Подключаем к общей Активности…
      </div>
    )
  }

  const application = getFirstPartyChannelActivity(instance.application_id)
  if (!application) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-destructive">
        Клиент не поддерживает эту Активность.
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 p-2 pt-12">
      <EmbeddedActivityFrame
        key={instance.id}
        application={application}
        instance={instance}
        error={activity.error}
        transport={activity.transport}
        currentUserId={currentUserId}
        onCommand={(command) =>
          channelActivityClient.command(channelId, instance.id, command)
        }
        onClose={onClose}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute top-12 right-3 z-10 size-9 bg-background/80 text-foreground hover:bg-accent"
        title="Закрыть Активность"
        aria-label="Закрыть Активность"
        onClick={onClose}
      >
        <XIcon className="size-5" />
      </Button>
    </div>
  )
}

function EmbeddedActivityFrame({
  application,
  instance,
  error,
  transport,
  currentUserId,
  onCommand,
  onClose,
}: {
  application: FirstPartyChannelActivity
  instance: ChannelActivityInstance
  error: ChannelActivityErrorCode | null
  transport: ChannelActivityViewState['transport']
  currentUserId: string
  onCommand: (command: unknown) => void
  onClose: () => void
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const portRef = useRef<MessagePort | null>(null)
  const commandRef = useRef(onCommand)
  const closeRef = useRef(onClose)
  const instanceRef = useRef(instance)
  const errorRef = useRef(error)
  const transportRef = useRef(transport)
  commandRef.current = onCommand
  closeRef.current = onClose
  instanceRef.current = instance
  errorRef.current = error
  transportRef.current = transport

  const connect = useCallback(() => {
    const frameWindow = iframeRef.current?.contentWindow
    if (!frameWindow) return
    portRef.current?.close()
    const channel = new MessageChannel()
    channel.port1.onmessage = (event) => {
      if (!isEmbeddedActivityClientMessage(event.data)) return
      if (event.data.type === 'syrnike.activity.command') {
        commandRef.current(event.data.command)
      } else {
        closeRef.current()
      }
    }
    channel.port1.start()
    portRef.current = channel.port1
    const message: EmbeddedActivityHostMessage = {
      type: 'syrnike.activity.bootstrap',
      version: EMBEDDED_ACTIVITY_PROTOCOL_VERSION,
      context: {
        applicationId: instance.application_id,
        instanceId: instance.id,
        channelId: instance.channel_id,
        currentUserId,
      },
      snapshot: instanceRef.current,
      error: errorRef.current,
      transport: transportRef.current,
      theme: readEmbeddedActivityTheme(),
    }
    frameWindow.postMessage(message, '*', [channel.port2])
  }, [currentUserId, instance.application_id, instance.channel_id, instance.id])

  useEffect(() => {
    const handleReady = (event: MessageEvent) => {
      if (
        event.source !== iframeRef.current?.contentWindow ||
        event.data?.type !== 'syrnike.activity.ready' ||
        event.data?.version !== EMBEDDED_ACTIVITY_PROTOCOL_VERSION
      ) {
        return
      }
      connect()
    }
    window.addEventListener('message', handleReady)
    return () => window.removeEventListener('message', handleReady)
  }, [connect])

  useEffect(() => {
    const port = portRef.current
    if (!port) return
    port.postMessage({
      type: 'syrnike.activity.snapshot',
      snapshot: instance,
    } satisfies EmbeddedActivityHostMessage)
  }, [instance])

  useEffect(() => {
    portRef.current?.postMessage({
      type: 'syrnike.activity.error',
      error,
    } satisfies EmbeddedActivityHostMessage)
  }, [error])

  useEffect(() => {
    portRef.current?.postMessage({
      type: 'syrnike.activity.transport',
      transport,
    } satisfies EmbeddedActivityHostMessage)
  }, [transport])

  useEffect(() => {
    const observer = new MutationObserver(() => {
      portRef.current?.postMessage({
        type: 'syrnike.activity.theme',
        theme: readEmbeddedActivityTheme(),
      } satisfies EmbeddedActivityHostMessage)
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    })
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => portRef.current?.close(), [])

  return (
    <iframe
      ref={iframeRef}
      title={application.title}
      src={application.entryUrl}
      sandbox="allow-scripts"
      className="min-h-0 w-full flex-1 rounded-xl border border-border bg-background"
      onLoad={connect}
    />
  )
}
