import { Toaster as SharedToaster } from '@syrnike13/ui/primitives/sonner'
import type { ToasterProps } from 'sonner'

/** Admin is dark-only: keep Sonner on the active dark theme regardless of OS. */
function Toaster(props: ToasterProps) {
  return <SharedToaster theme="dark" {...props} />
}

export { Toaster }
