import type { ClassValue } from 'clsx'

import { cn } from '#/lib/utils'

export function userProfileBannerClassName(
  ...classNames: ClassValue[]
) {
  return cn('relative w-full overflow-hidden aspect-[5/2]', ...classNames)
}
