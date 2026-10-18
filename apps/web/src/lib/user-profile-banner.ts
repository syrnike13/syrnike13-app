import type { ClassValue } from 'clsx'

import { cn } from '#/lib/utils'

export function userProfileBannerClassName(
  ...classNames: ClassValue[]
) {
  return cn('relative w-full overflow-hidden h-26.25', ...classNames)
}
