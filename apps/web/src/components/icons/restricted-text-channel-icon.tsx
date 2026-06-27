import { useId } from 'react'

import { cn } from '#/lib/utils'

type RestrictedTextChannelIconProps = {
  className?: string
}

const HASH_PATH =
  'M7.78428 14L8.2047 10H4V8H8.41491L8.94043 3H10.9514L10.4259 8H14.4149L14.9404 3H16.9514L16.4259 8H20V10H16.2157L15.7953 14H20V16H15.5851L15.0596 21H13.0486L13.5741 16H9.58509L9.05957 21H7.04855L7.57407 16H4V14H7.78428ZM9.7953 14H13.7843L14.2047 10H10.2157L9.7953 14Z'

const LOCK_PATH =
  'M6 22h12c1.1 0 2-.9 2-2v-9c0-1.1-.9-2-2-2h-1V7c0-2.76-2.24-5-5-5S7 4.24 7 7v2H6c-1.1 0-2 .9-2 2v9c0 1.1.9 2 2 2M9 7c0-1.65 1.35-3 3-3s3 1.35 3 3v2H9z'

const LOCK_TRANSFORM = 'translate(13.4, -1.1) scale(0.48)'

export function RestrictedTextChannelIcon({
  className,
}: RestrictedTextChannelIconProps) {
  const maskId = useId()

  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="currentColor"
      className={cn('shrink-0', className)}
      aria-hidden
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse">
          <rect width={24} height={24} fill="white" />
          <g transform={LOCK_TRANSFORM}>
            <path
              d={LOCK_PATH}
              fill="black"
              stroke="black"
              strokeWidth={5}
              strokeLinejoin="round"
            />
          </g>
        </mask>
      </defs>
      <path d={HASH_PATH} mask={`url(#${maskId})`} />
      <g transform={LOCK_TRANSFORM}>
        <path d={LOCK_PATH} />
      </g>
    </svg>
  )
}
