import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'

export type AdminDraftController = {
  isDirty: boolean
  isSaving: boolean
  save: () => Promise<boolean>
  reset: () => boolean
}

type AdminDraftContextValue = {
  controller: AdminDraftController | null
  setController: Dispatch<SetStateAction<AdminDraftController | null>>
}

const AdminDraftContext = createContext<AdminDraftContextValue | null>(null)

export function AdminDraftProvider({ children }: { children: ReactNode }) {
  const [controller, setController] = useState<AdminDraftController | null>(null)
  const value = useMemo(() => ({ controller, setController }), [controller])

  return (
    <AdminDraftContext.Provider value={value}>
      {children}
    </AdminDraftContext.Provider>
  )
}

export function useAdminDraftController() {
  return useContext(AdminDraftContext)?.controller ?? null
}

export function useAdminDraftRegistration(
  registration: AdminDraftController | null,
) {
  const setController = useContext(AdminDraftContext)?.setController
  const saveRef = useRef(registration?.save)
  const resetRef = useRef(registration?.reset)
  saveRef.current = registration?.save
  resetRef.current = registration?.reset

  const isActive = registration != null
  const isDirty = registration?.isDirty ?? false
  const isSaving = registration?.isSaving ?? false

  useEffect(() => {
    if (!setController) return

    if (!isActive) {
      setController(null)
      return
    }

    setController((previous) => {
      const next: AdminDraftController = {
        isDirty,
        isSaving,
        save: () => saveRef.current?.() ?? Promise.resolve(false),
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
