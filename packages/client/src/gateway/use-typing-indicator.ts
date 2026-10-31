import { useEffect, useRef } from 'react'

import type { EventsGateway } from './events-gateway'

/** Sends typing start/stop for the composer; typing lapses 4 s after the last keystroke. */
export function useTypingIndicator(
  eventsGateway: Pick<EventsGateway, 'beginTyping' | 'endTyping'>,
  channelId: string | undefined,
) {
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
  }, [channelId, eventsGateway])

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

  function stopTyping() {
    clearTimeout(timeoutRef.current)
    if (!typingRef.current || !channelId) return
    typingRef.current = false
    eventsGateway.endTyping(channelId)
  }

  return { notifyTyping, stopTyping }
}
