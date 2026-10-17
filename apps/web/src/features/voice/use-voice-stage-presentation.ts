import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

export function useVoiceStagePresentation(channelId: string | null) {
  const [popoutWindow, setPopoutWindow] = useState<Window | null>(null)
  const [popoutChannelId, setPopoutChannelId] = useState<string | null>(null)
  const windowRef = useRef<Window | null>(null)
  const [mountedStages, setMountedStages] = useState<
    ReadonlyMap<symbol, string>
  >(new Map())
  const registerStageView = useCallback((channel: string) => {
    const token = Symbol(channel)
    setMountedStages((current) => new Map(current).set(token, channel))
    return () =>
      setMountedStages((current) => {
        const next = new Map(current)
        next.delete(token)
        return next
      })
  }, [])
  const closeStagePopout = useCallback(() => {
    const current = windowRef.current
    windowRef.current = null
    setPopoutWindow(null)
    setPopoutChannelId(null)
    if (current && !current.closed) current.close()
  }, [])
  const openStagePopout = useCallback(
    (targetChannelId = channelId) => {
      if (!targetChannelId) return
      if (windowRef.current && !windowRef.current.closed) {
        setPopoutChannelId(targetChannelId)
        windowRef.current.focus()
        return
      }
      const child = window.open(
        '',
        'syrnike13-voice-stage',
        'popup=yes,width=1280,height=720',
      )
      if (!child) {
        toast.error('Браузер заблокировал отдельное окно стейджа')
        return
      }
      windowRef.current = child
      setPopoutWindow(child)
      setPopoutChannelId(targetChannelId)
      child.focus()
    },
    [channelId],
  )
  useEffect(() => {
    if (!popoutWindow) return
    const closed = () => {
      if (windowRef.current !== popoutWindow) return
      windowRef.current = null
      setPopoutWindow(null)
      setPopoutChannelId(null)
    }
    popoutWindow.addEventListener('unload', closed)
    return () => popoutWindow.removeEventListener('unload', closed)
  }, [popoutWindow])
  useEffect(() => closeStagePopout, [channelId, closeStagePopout])
  return useMemo(
    () => ({
      popoutWindow,
      popoutChannelId,
      openStagePopout,
      closeStagePopout,
      registerStageView,
      mountedStageChannelIds: [...mountedStages.values()],
    }),
    [
      popoutWindow,
      popoutChannelId,
      openStagePopout,
      closeStagePopout,
      registerStageView,
      mountedStages,
    ],
  )
}
