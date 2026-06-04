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

self.addEventListener('push', (event) => {
  let data = { title: 'syrnike13', body: 'Новое уведомление' }
  try {
    data = event.data?.json() ?? data
  } catch {
    data.body = event.data?.text() ?? data.body
  }

  event.waitUntil(
    self.registration.showNotification(data.title ?? 'syrnike13', {
      body: data.body,
      icon: '/favicon.ico',
    }),
  )
})
