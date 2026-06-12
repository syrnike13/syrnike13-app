export async function closeVoiceCallNotification(channelId: string) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return
  }

  try {
    const registration = await navigator.serviceWorker.ready
    const notifications = await registration.getNotifications({
      tag: `voice-call:${channelId}`,
    })

    notifications.forEach((notification) => notification.close())
  } catch {
    // Notification cleanup is best effort; call UI state is still handled locally.
  }
}
