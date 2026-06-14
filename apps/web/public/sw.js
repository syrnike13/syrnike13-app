self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key)))),
    ]),
  )
})

function voiceCallNotificationTag(data) {
  return data.tag || (data.channel_id ? `voice-call:${data.channel_id}` : undefined)
}

function voiceCallNotificationUrl(data) {
  return data.url || (data.channel_id ? `/app/c/${data.channel_id}` : undefined)
}

async function handleVoiceCallPush(data) {
  const tag = voiceCallNotificationTag(data)
  const url = voiceCallNotificationUrl(data)

  if (data.ended) {
    if (tag) {
      const notifications = await self.registration.getNotifications({ tag })
      for (const notification of notifications) {
        notification.close()
      }
    }
    return
  }

  await self.registration.showNotification(data.title ?? 'syrnike13', {
    body: data.body,
    icon: '/app-logo.png',
    tag,
    renotify: Boolean(tag),
    data: url ? { url } : undefined,
  })
}

async function openNotificationTarget(url) {
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  })

  for (const client of clients) {
    if (typeof client.navigate === 'function') {
      await client.navigate(url)
    }
    if (typeof client.focus === 'function') {
      await client.focus()
      return
    }
  }

  const opened = await self.clients.openWindow?.(url)
  await opened?.focus?.()
}

self.addEventListener('push', (event) => {
  let data = { title: 'syrnike13', body: 'Новое уведомление' }
  try {
    data = event.data?.json() ?? data
  } catch {
    data.body = event.data?.text() ?? data.body
  }

  event.waitUntil(
    data.type === 'DmCallStartEnd'
      ? handleVoiceCallPush(data)
      : self.registration.showNotification(data.title ?? 'syrnike13', {
          body: data.body,
          icon: '/app-logo.png',
        }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const url = event.notification.data?.url
  if (!url) return

  event.waitUntil(openNotificationTarget(url))
})
