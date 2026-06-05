import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export type DraftController = {
  isDirty: boolean
  isSaving: boolean
  save: () => Promise<boolean>
  reset: () => boolean
}

type DraftContextValue = {
  controller: DraftController | null
  setController: (controller: DraftController | null) => void
}

const DraftContext = createContext<DraftContextValue | null>(null)

export function DraftProvider({ children }: { children: ReactNode }) {
  const [controller, setController] = useState<DraftController | null>(null)

  const value = useMemo(
    () => ({ controller, setController }),
    [controller],
  )

  return (
    <DraftContext.Provider value={value}>{children}</DraftContext.Provider>
  )
}

export function useDraftContext() {
  return useContext(DraftContext)
}

export function useDraftRegistration(registration: DraftController | null) {
  const setController = useDraftContext()?.setController
  const saveRef = useRef(registration?.save)
  const resetRef = useRef(registration?.reset)
  saveRef.current = registration?.save
  resetRef.current = registration?.reset

  const isDirty = registration?.isDirty ?? false
  const isSaving = registration?.isSaving ?? false
  const isActive = registration != null

  useEffect(() => {
    if (!setController) return

    if (!isActive) {
      setController(null)
      return
    }

    setController((previous) => {
      const next: DraftController = {
        isDirty,
        isSaving,
        save: () => saveRef.current!(),
        reset: () => resetRef.current?.() ?? false,
      }
      if (
        previous &&
        previous.isDirty === next.isDirty &&
        previous.isSaving === next.isSaving
      ) {
        return previous
      }
      return next
    })
  }, [isActive, isDirty, isSaving, setController])

  useEffect(() => {
    if (!setController) return
    return () => setController(null)
  }, [setController])
}
