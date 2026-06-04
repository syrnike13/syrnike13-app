import { useEffect, useRef } from 'react'

const DISCOVER_ORIGIN = 'https://stt.gg'
const DISCOVER_SRC = `${DISCOVER_ORIGIN}/discover?embedded=true`

/**
 * Встроенный Discover через stt.gg.
 */
export function DiscoverFrame() {
  const frameRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== DISCOVER_ORIGIN) return
      const frame = frameRef.current
      if (!frame?.contentWindow) return

      try {
        const data = JSON.parse(String(event.data)) as {
          source?: string
          type?: string
        }
        if (data.source === 'discover' && data.type === 'init') {
          frame.contentWindow.postMessage(
            JSON.stringify({ source: 'syrnike13', type: 'theme', theme: {} }),
            DISCOVER_ORIGIN,
          )
        }
      } catch {
        // не JSON — игнорируем
      }
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  return (
    <iframe
      ref={frameRef}
      title="Discover"
      src={DISCOVER_SRC}
      className="min-h-0 w-full flex-1 border-0"
      allow="clipboard-write"
    />
  )
}
