import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Effect, Fiber } from 'effect'
import { useTranslations } from '@syrnike13/ui/i18n'

import {
  SettingsBlock,
  SettingsRow,
} from '#/components/settings/settings-panels'
import { Switch } from '@syrnike13/ui/primitives/switch'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@syrnike13/ui/primitives/card'
import { SoundSettings } from '#/components/sounds/sound-settings'
import { useAuth } from '#/features/auth/auth-context'
import { fetchSyrnikeConfigEffect } from '#/features/api/config-api'
import {
  subscribePushEffect,
  unsubscribePushEffect,
} from '#/features/api/push-api'
import { apiErrorMessage } from '#/lib/api/error-message'

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
  const t = useTranslations('settings.notifications')
  const permissionLabel = (value: NotificationPermission) =>
    t(`permissions.${value}`)
  const auth = useAuth()
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default',
  )
  const [pushReady, setPushReady] = useState(false)
  const [vapidKey, setVapidKey] = useState<string | null>(null)
  /** Whether this browser holds a push subscription; null while checking. */
  const [pushSubscribed, setPushSubscribed] = useState<boolean | null>(null)

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return
    }
    let cancelled = false
    void navigator.serviceWorker
      .getRegistration()
      .then((registration) => registration?.pushManager.getSubscription())
      .then((subscription) => {
        if (!cancelled) setPushSubscribed(Boolean(subscription))
      })
      .catch(() => {
        if (!cancelled) setPushSubscribed(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

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
      toast.error(t('unsupported'))
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
              toast.success(t('granted'))
            } else if (result === 'denied') {
              toast.error(t('denied'))
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
      toast.error(t('pushUnavailable'))
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
          return yield* Effect.fail(new Error(t('invalidSubscription')))
        }
        yield* subscribePushEffect(token, {
          endpoint,
          auth,
          p256dh,
        })
        yield* Effect.sync(() => {
          setPushSubscribed(true)
          toast.success(t('pushEnabled'))
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              apiErrorMessage(error, t('pushError')),
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
          setPushSubscribed(false)
          toast.success(t('pushDisabled'))
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              apiErrorMessage(error, t('disableError')),
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

        <SettingsBlock title={t('browser')}>
          <SettingsRow
            label={t('browserNotifications')}
            hint={t('browserStatus', {
              status: permissionLabel(permission),
            })}
          >
            {permission === 'default' ? (
              <Button type="button" variant="outline" size="sm" onClick={enableDesktop}>
                {t('allow')}
              </Button>
            ) : null}
          </SettingsRow>
        </SettingsBlock>

        {pushReady && vapidKey ? (
          <SettingsBlock title={t('push')}>
            <SettingsRow
              label={t('backgroundPush')}
              hint={t('backgroundHint')}
            >
              <Switch
                checked={pushSubscribed ?? false}
                disabled={pushSubscribed === null}
                aria-label={t('backgroundPush')}
                onCheckedChange={(checked) =>
                  checked ? enablePush() : disablePush()
                }
              />
            </SettingsRow>
          </SettingsBlock>
        ) : null}
      </div>
    )
  }

  const actions = (
    <div className="flex flex-col gap-2">
      <Button type="button" variant="outline" onClick={enableDesktop}>
        {t('allowBrowser')}
      </Button>
      {pushReady && vapidKey ? (
        <>
          <Button type="button" onClick={enablePush}>
            {t('enablePush')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={disablePush}
          >
            {t('disablePush')}
          </Button>
        </>
      ) : null}
    </div>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('cardTitle')}</CardTitle>
        <CardDescription>
          {t('cardStatus', { status: permissionLabel(permission) })}
        </CardDescription>
      </CardHeader>
      <CardContent>{actions}</CardContent>
    </Card>
  )
}
