import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type SettingsSection =
  | 'profile'
  | 'account'
  | 'voice'
  | 'sessions'
  | 'notifications'
  | 'appearance'
  | 'hotkeys'
  | 'overlay'
  | 'desktop'

type SettingsModalContextValue = {
  open: boolean
  section: SettingsSection
  setOpen: (open: boolean) => void
  openSettings: (section?: SettingsSection) => void
  setSection: (section: SettingsSection) => void
}

const SettingsModalContext = createContext<SettingsModalContextValue | null>(
  null,
)

export function SettingsModalProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<SettingsSection>('account')

  const openSettings = useCallback((next: SettingsSection = 'account') => {
    setSection(next)
    setOpen(true)
  }, [])

  const value = useMemo(
    () => ({
      open,
      section,
      setOpen,
      openSettings,
      setSection,
    }),
    [open, section, openSettings],
  )

  return (
    <SettingsModalContext.Provider value={value}>
      {children}
    </SettingsModalContext.Provider>
  )
}

export function useSettingsModal() {
  const context = useContext(SettingsModalContext)
  if (!context) {
    throw new Error('useSettingsModal must be used within SettingsModalProvider')
  }
  return context
}
