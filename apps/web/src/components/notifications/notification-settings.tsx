import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
import { useAuth } from '#/features/auth/auth-context'
import { fetchSyrnikeConfig } from '#/features/api/config-api'
import { subscribePush, unsubscribePush } from '#/features/api/push-api'

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
    void fetchSyrnikeConfig()
      .then((config) => setVapidKey(config.vapid ?? null))
      .catch(() => {
        // optional
      })

    setPushReady(
      typeof window !== 'undefined' &&
        'serviceWorker' in navigator &&
        'PushManager' in window,
    )
  }, [])

  async function enableDesktop() {
    if (!('Notification' in window)) {
      toast.error('Браузер не поддерживает уведомления')
      return
    }

    const result = await Notification.requestPermission()
    setPermission(result)

    if (result === 'granted') {
      toast.success('Уведомления включены для открытых вкладок')
    } else if (result === 'denied') {
      toast.error('Доступ к уведомлениям запрещён')
    }
  }

  async function enablePush() {
    const token = auth.session?.token
    if (!token || !vapidKey) {
      toast.error('Push недоступен на этом узле')
      return
    }

    if (Notification.permission !== 'granted') {
      await enableDesktop()
      if (Notification.permission !== 'granted') return
    }

    try {
      const registration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
      })

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      })

      const json = subscription.toJSON()
      if (!json.keys?.auth || !json.keys?.p256dh || !json.endpoint) {
        throw new Error('Некорректная подписка')
      }

      await subscribePush(token, {
        endpoint: json.endpoint,
        auth: json.keys.auth,
        p256dh: json.keys.p256dh,
      })

      toast.success('Push-уведомления включены')
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Не удалось включить push (нужен service worker)',
      )
    }
  }

  async function disablePush() {
    const token = auth.session?.token
    if (!token) return

    try {
      const registration = await navigator.serviceWorker.getRegistration()
      const subscription = await registration?.pushManager.getSubscription()
      if (subscription) {
        const json = subscription.toJSON()
        if (json.endpoint && json.keys?.auth && json.keys?.p256dh) {
          await unsubscribePush(token, {
            endpoint: json.endpoint,
            auth: json.keys.auth,
            p256dh: json.keys.p256dh,
          })
        }
        await subscription.unsubscribe()
      }
      toast.success('Push отключён')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось отключить',
      )
    }
  }

  const actions = (
    <div className="flex flex-col gap-2">
      <Button type="button" variant="outline" onClick={() => void enableDesktop()}>
        Разрешить уведомления в браузере
      </Button>
      {pushReady && vapidKey ? (
        <>
          <Button type="button" onClick={() => void enablePush()}>
            Включить push (фон)
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => void disablePush()}
          >
            Отключить push
          </Button>
        </>
      ) : null}
    </div>
  )

  if (layout === 'settings') {
    return <div>{actions}</div>
  }

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
