import { useEffect, useRef } from 'react'

import { eventsGateway } from '#/features/events/gateway'

export function useTypingIndicator(channelId: string | undefined) {
  const typingRef = useRef(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )

  useEffect(() => {
    return () => {
      if (typingRef.current && channelId) {
        eventsGateway.endTyping(channelId)
      }
      clearTimeout(timeoutRef.current)
    }
  }, [channelId])

  function notifyTyping() {
    if (!channelId) return

    if (!typingRef.current) {
      typingRef.current = true
      eventsGateway.beginTyping(channelId)
    }

    clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      typingRef.current = false
      eventsGateway.endTyping(channelId)
    }, 4_000)
  }

  return { notifyTyping }
}
