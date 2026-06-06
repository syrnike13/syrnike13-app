import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouterState } from '@tanstack/react-router'

type HistoryEntry = {
  pathname: string
  search: string
}

function entryKey(entry: HistoryEntry) {
  return `${entry.pathname}${entry.search}`
}

export function useShellHistoryNav() {
  const location = useRouterState({ select: (state) => state.location })
  const locationKey = `${location.pathname}${location.searchStr}`

  const entriesRef = useRef<HistoryEntry[]>([])
  const indexRef = useRef(0)
  const [navState, setNavState] = useState({
    canGoBack: false,
    canGoForward: false,
  })

  const syncNavState = useCallback(() => {
    const index = indexRef.current
    const length = entriesRef.current.length
    setNavState({
      canGoBack: index > 0,
      canGoForward: index < length - 1,
    })
  }, [])

  useEffect(() => {
    const next: HistoryEntry = {
      pathname: location.pathname,
      search: location.searchStr,
    }
    const nextKey = entryKey(next)
    const entries = entriesRef.current
    const index = indexRef.current

    if (entries.length === 0) {
      entriesRef.current = [next]
      indexRef.current = 0
      syncNavState()
      return
    }

    const current = entries[index]
    if (current && entryKey(current) === nextKey) return

    const previous = entries[index - 1]
    if (previous && entryKey(previous) === nextKey) {
      indexRef.current = index - 1
      syncNavState()
      return
    }

    const forward = entries[index + 1]
    if (forward && entryKey(forward) === nextKey) {
      indexRef.current = index + 1
      syncNavState()
      return
    }

    entriesRef.current = [...entries.slice(0, index + 1), next]
    indexRef.current = entriesRef.current.length - 1
    syncNavState()
  }, [locationKey, location.pathname, location.searchStr, syncNavState])

  const goBack = useCallback(() => {
    if (indexRef.current <= 0) return
    window.history.back()
  }, [])

  const goForward = useCallback(() => {
    if (indexRef.current >= entriesRef.current.length - 1) return
    window.history.forward()
  }, [])

  return {
    canGoBack: navState.canGoBack,
    canGoForward: navState.canGoForward,
    goBack,
    goForward,
  }
}
