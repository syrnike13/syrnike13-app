self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key)))),
      self.clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then((clients) => {
          for (const client of clients) {
            client.navigate(client.url)
          }
        }),
      self.registration.unregister(),
    ]),
  )
})
