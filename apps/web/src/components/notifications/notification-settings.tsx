import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Effect, Fiber } from 'effect'

import {
  SettingsBlock,
  SettingsRow,
} from '#/components/settings/settings-panels'
import { Button } from '#/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
import { SoundSettings } from '#/components/sounds/sound-settings'
import { useAuth } from '#/features/auth/auth-context'
import { fetchSyrnikeConfigEffect } from '#/features/api/config-api'
import {
  subscribePushEffect,
  unsubscribePushEffect,
} from '#/features/api/push-api'

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index)
  }
  return output
}

type NotificationSettingsProps = {
  layout?: 'card' | 'settings'
}

export function NotificationSettings({
  layout = 'card',
}: NotificationSettingsProps) {
  const auth = useAuth()
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default',
  )
  const [pushReady, setPushReady] = useState(false)
  const [vapidKey, setVapidKey] = useState<string | null>(null)

  useEffect(() => {
    const fiber = Effect.runFork(
      fetchSyrnikeConfigEffect().pipe(
        Effect.tap((config) =>
          Effect.sync(() => {
            setVapidKey(config.vapid ?? null)
          }),
        ),
        Effect.ignore,
      ),
    )

    setPushReady(
      typeof window !== 'undefined' &&
        'serviceWorker' in navigator &&
        'PushManager' in window,
    )

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [])

  function enableDesktop() {
    if (!('Notification' in window)) {
      toast.error('Браузер не поддерживает уведомления')
      return
    }

    Effect.runFork(
      Effect.tryPromise({
        try: () => Notification.requestPermission(),
        catch: (cause) => cause,
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            setPermission(result)
            if (result === 'granted') {
              toast.success('Уведомления включены для открытых вкладок')
            } else if (result === 'denied') {
              toast.error('Доступ к уведомлениям запрещён')
            }
          }),
        ),
        Effect.ignore,
      ),
    )
  }

  function enablePush() {
    const token = auth.session?.token
    if (!token || !vapidKey) {
      toast.error('Push недоступен на этом узле')
      return
    }

    Effect.runFork(
      Effect.gen(function*() {
        if (Notification.permission !== 'granted') {
          const result = yield* Effect.tryPromise({
            try: () => Notification.requestPermission(),
            catch: (cause) => cause,
          })
          yield* Effect.sync(() => {
            setPermission(result)
          })
          if (result !== 'granted') return
        }

        const registration = yield* Effect.tryPromise({
          try: () =>
            navigator.serviceWorker.register('/sw.js', {
              scope: '/',
            }),
          catch: (cause) => cause,
        })
        const subscription = yield* Effect.tryPromise({
          try: () =>
            registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(vapidKey),
            }),
          catch: (cause) => cause,
        })
        const json = subscription.toJSON()
        const endpoint = json.endpoint
        const auth = json.keys?.auth
        const p256dh = json.keys?.p256dh
        if (!endpoint || !auth || !p256dh) {
          return yield* Effect.fail(new Error('Некорректная подписка'))
        }
        yield* subscribePushEffect(token, {
          endpoint,
          auth,
          p256dh,
        })
        yield* Effect.sync(() => {
          toast.success('Push-уведомления включены')
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              error instanceof Error
                ? error.message
                : 'Не удалось включить push (нужен service worker)',
            )
          }),
        ),
      ),
    )
  }

  function disablePush() {
    const token = auth.session?.token
    if (!token) return

    Effect.runFork(
      Effect.gen(function*() {
        const registration = yield* Effect.tryPromise({
          try: () => navigator.serviceWorker.getRegistration(),
          catch: (cause) => cause,
        })
        const subscription = registration
          ? yield* Effect.tryPromise({
              try: () => registration.pushManager.getSubscription(),
              catch: (cause) => cause,
            })
          : null
        if (subscription) {
          const json = subscription.toJSON()
          const endpoint = json.endpoint
          const auth = json.keys?.auth
          const p256dh = json.keys?.p256dh
          if (endpoint && auth && p256dh) {
            yield* unsubscribePushEffect(token, {
              endpoint,
              auth,
              p256dh,
            })
          }
          yield* Effect.tryPromise({
            try: () => subscription.unsubscribe(),
            catch: (cause) => cause,
          })
        }
        yield* Effect.sync(() => {
          toast.success('Push отключён')
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              error instanceof Error ? error.message : 'Не удалось отключить',
            )
          }),
        ),
      ),
    )
  }

  if (layout === 'settings') {
    return (
      <div className="space-y-2">
        <SoundSettings />

        <SettingsBlock title="Браузер">
          <SettingsRow
            label="Уведомления в браузере"
            hint={`Текущий статус: ${permission}. Сообщения приходят, когда вкладка не в фокусе.`}
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={enableDesktop}
            >
              Разрешить
            </Button>
          </SettingsRow>
        </SettingsBlock>

        {pushReady && vapidKey ? (
          <SettingsBlock title="Push">
            <SettingsRow
              label="Фоновые push-уведомления"
              hint="Работают, когда вкладка закрыта, через service worker."
            >
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" onClick={enablePush}>
                  Включить
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={disablePush}
                >
                  Отключить
                </Button>
              </div>
            </SettingsRow>
          </SettingsBlock>
        ) : null}
      </div>
    )
  }

  const actions = (
    <div className="flex flex-col gap-2">
      <Button type="button" variant="outline" onClick={enableDesktop}>
        Разрешить уведомления в браузере
      </Button>
      {pushReady && vapidKey ? (
        <>
          <Button type="button" onClick={enablePush}>
            Включить push (фон)
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={disablePush}
          >
            Отключить push
          </Button>
        </>
      ) : null}
    </div>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Уведомления</CardTitle>
        <CardDescription>
          Статус: {permission}. Сообщения приходят, когда вкладка не в фокусе.
        </CardDescription>
      </CardHeader>
      <CardContent>{actions}</CardContent>
    </Card>
  )
}
