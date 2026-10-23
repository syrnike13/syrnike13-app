import { useEffect, useRef } from 'react'

/**
 * Calls onEnded when a self-monitoring check the voice session reported as
 * running stops, for example from the deafen button or a desktop hotkey.
 * A check that never reached the session (a tab that does not own voice)
 * never reports running, so it never ends here.
 */
export function useSelfMonitoringEnded(
  selfMonitoringActive: boolean,
  onEnded: () => void,
) {
  const runningRef = useRef(false)
  const onEndedRef = useRef(onEnded)

  useEffect(() => {
    onEndedRef.current = onEnded
  }, [onEnded])

  useEffect(() => {
    if (runningRef.current && !selfMonitoringActive) onEndedRef.current()
    runningRef.current = selfMonitoringActive
  }, [selfMonitoringActive])
}
