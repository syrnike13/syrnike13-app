import { Effect } from 'effect'

export const closeVoiceCallNotification = Effect.fn(
  'notifications.closeVoiceCall',
)(function*(channelId: string) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return
  }

  yield* Effect.gen(function*() {
    const registration = yield* Effect.tryPromise({
      try: () => navigator.serviceWorker.ready,
      catch: (cause) => cause,
    })
    const notifications = yield* Effect.tryPromise({
      try: () =>
        registration.getNotifications({
          tag: `voice-call:${channelId}`,
        }),
      catch: (cause) => cause,
    })
    yield* Effect.sync(() => {
      notifications.forEach((notification) => notification.close())
    })
  }).pipe(Effect.catch(() => Effect.void))
})
