// Kill-switch for the old root-domain service worker. The app now lives on
// app.syrnike13.ru; browsers refresh this script on navigation and unregister it.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key)))
      await self.registration.unregister()
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      for (const client of clients) client.navigate(client.url)
    })(),
  )
})
