import { cn } from '#/lib/utils'

export const USER_PROFILE_BANNER_ASPECT_RATIO = 5 / 2

export function userProfileBannerClassName(
  ...classNames: Array<string | undefined>
) {
  return cn('relative w-full overflow-hidden aspect-[5/2]', ...classNames)
}
