import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export type ProfileDraftController = {
  isDirty: boolean
  isSaving: boolean
  save: () => Promise<boolean>
  reset: () => boolean
}

type ProfileDraftContextValue = {
  controller: ProfileDraftController | null
  setController: (controller: ProfileDraftController | null) => void
}

const ProfileDraftContext = createContext<ProfileDraftContextValue | null>(null)

export function ProfileDraftProvider({ children }: { children: ReactNode }) {
  const [controller, setController] = useState<ProfileDraftController | null>(
    null,
  )

  const value = useMemo(
    () => ({ controller, setController }),
    [controller],
  )

  return (
    <ProfileDraftContext.Provider value={value}>
      {children}
    </ProfileDraftContext.Provider>
  )
}

export function useProfileDraftContext() {
  return useContext(ProfileDraftContext)
}

export function useProfileDraftRegistration(
  registration: ProfileDraftController | null,
) {
  const ctx = useProfileDraftContext()
  const saveRef = useRef(registration?.save)
  const resetRef = useRef(registration?.reset)
  saveRef.current = registration?.save
  resetRef.current = registration?.reset

  useEffect(() => {
    if (!ctx) return
    if (!registration) {
      ctx.setController(null)
      return
    }
    ctx.setController({
      isDirty: registration.isDirty,
      isSaving: registration.isSaving,
      save: () => saveRef.current!(),
      reset: () => resetRef.current?.() ?? false,
    })
    return () => ctx.setController(null)
  }, [
    ctx,
    registration,
    registration?.isDirty,
    registration?.isSaving,
    registration?.save,
    registration?.reset,
  ])
}
