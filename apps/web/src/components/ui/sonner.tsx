import { Toaster as SharedToaster } from '@syrnike13/ui/primitives/sonner'
import type { ToasterProps } from 'sonner'

import { useAppearance } from '#/features/appearance/appearance-context'

function Toaster(props: ToasterProps) {
  const { resolvedVariant } = useAppearance()
  return <SharedToaster theme={resolvedVariant} {...props} />
}

export { Toaster }
