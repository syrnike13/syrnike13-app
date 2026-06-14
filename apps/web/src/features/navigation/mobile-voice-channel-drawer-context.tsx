import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

type MobileVoiceChannelDrawerContextValue = {
  channelId: string | null
  openVoiceChannelDrawer: (channelId: string) => void
  closeVoiceChannelDrawer: () => void
}

const MobileVoiceChannelDrawerContext =
  createContext<MobileVoiceChannelDrawerContextValue | null>(null)

export function MobileVoiceChannelDrawerProvider({
  children,
}: {
  children: ReactNode
}) {
  const [channelId, setChannelId] = useState<string | null>(null)

  const openVoiceChannelDrawer = useCallback((nextChannelId: string) => {
    setChannelId(nextChannelId)
  }, [])

  const closeVoiceChannelDrawer = useCallback(() => {
    setChannelId(null)
  }, [])

  const value = useMemo(
    () => ({
      channelId,
      openVoiceChannelDrawer,
      closeVoiceChannelDrawer,
    }),
    [channelId, openVoiceChannelDrawer, closeVoiceChannelDrawer],
  )

  return (
    <MobileVoiceChannelDrawerContext.Provider value={value}>
      {children}
    </MobileVoiceChannelDrawerContext.Provider>
  )
}

export function useMobileVoiceChannelDrawer() {
  const context = useContext(MobileVoiceChannelDrawerContext)
  if (!context) {
    throw new Error(
      'useMobileVoiceChannelDrawer must be used within MobileVoiceChannelDrawerProvider',
    )
  }
  return context
}
