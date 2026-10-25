import { useEffect, useRef } from 'react'

/**
 * Drives the voice session's self-monitoring check for one settings surface.
 *
 * Only a check this surface started is ended here: on stop, unmount or when
 * the page goes away (a closed tab never runs React cleanup, and a check
 * forwarded to another tab's voice session would otherwise stay on).
 *
 * The surface also follows a check another settings surface started and a
 * check the session ends elsewhere, for example from the deafen button or a
 * desktop hotkey.
 *
 * A surface that stopped its own check and started another one before the
 * session reported the stop ignores that late report, so a quick restart is
 * not cancelled.
 */
export function useSelfMonitoringCheck(
  requested: boolean,
  selfMonitoringActive: boolean,
  setSelfMonitoringActive: (active: boolean) => void,
  onEnded: () => void,
) {
  const setActiveRef = useRef(setSelfMonitoringActive)
  const onEndedRef = useRef(onEnded)
  const previousRequestedRef = useRef(requested)
  const previousActiveRef = useRef(selfMonitoringActive)
  // A running check this surface shows: its own start or one it joined.
  const runningRef = useRef(false)
  // This surface asked for a stop the session has not reported yet.
  const stopPendingRef = useRef(false)

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
    const requestedBefore = previousRequestedRef.current
    const activeBefore = previousActiveRef.current
    previousRequestedRef.current = requested
    previousActiveRef.current = selfMonitoringActive

    if (!requested) {
      if (!selfMonitoringActive) stopPendingRef.current = false
      else if (requestedBefore && runningRef.current) stopPendingRef.current = true
      runningRef.current = false
      return
    }

    if (selfMonitoringActive && !activeBefore) {
      runningRef.current = true
      stopPendingRef.current = false
      return
    }

    if (!selfMonitoringActive) {
      if (stopPendingRef.current) {
        // The report of the stop this surface asked for, not the end of the
        // check it started after that stop.
        stopPendingRef.current = false
        return
      }
      if (!runningRef.current) return
      runningRef.current = false
      onEndedRef.current()
      return
    }

    // A check another surface started was already running when this one asked
    // for it, so its start is never reported here.
    if (!stopPendingRef.current) runningRef.current = true
  }, [requested, selfMonitoringActive])
}
