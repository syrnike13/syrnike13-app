import { useEffect, useRef } from 'react'

/**
 * Drives the voice session's self-monitoring check for one settings surface.
 *
 * Only a check this surface started is ended here: on stop, unmount or when
 * the page goes away (a closed tab never runs React cleanup, and a check
 * forwarded to another tab's voice session would otherwise stay on).
 *
 * onEnded runs when the session ends the check elsewhere, for example from
 * the deafen button or a desktop hotkey. Only a start the session reported
 * after this request counts, so the late "ended" of a previous check never
 * cancels a new one.
 */
export function useSelfMonitoringCheck(
  requested: boolean,
  selfMonitoringActive: boolean,
  setSelfMonitoringActive: (active: boolean) => void,
  onEnded: () => void,
) {
  const setActiveRef = useRef(setSelfMonitoringActive)
  const onEndedRef = useRef(onEnded)
  const previousActiveRef = useRef(selfMonitoringActive)
  const startedRef = useRef(false)

  useEffect(() => {
    setActiveRef.current = setSelfMonitoringActive
    onEndedRef.current = onEnded
  }, [onEnded, setSelfMonitoringActive])

  useEffect(() => {
    if (!requested) return
    setActiveRef.current(true)
    const end = () => setActiveRef.current(false)
    window.addEventListener('pagehide', end)
    return () => {
      window.removeEventListener('pagehide', end)
      end()
    }
  }, [requested])

  useEffect(() => {
    const previous = previousActiveRef.current
    previousActiveRef.current = selfMonitoringActive
    if (!requested) {
      startedRef.current = false
    } else if (selfMonitoringActive && !previous) {
      startedRef.current = true
    } else if (!selfMonitoringActive && startedRef.current) {
      startedRef.current = false
      onEndedRef.current()
    }
  }, [requested, selfMonitoringActive])
}
