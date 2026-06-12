import { useId } from 'react'

import { cn } from '#/lib/utils'

type RestrictedVoiceChannelIconProps = {
  className?: string
}

/** Динамик wpf:speaker (viewBox 26×26) */
const SPEAKER_PATH =
  'M12.031 1.063c-.321.001-.676.145-1 .468L5.312 8H1c-.551 0-1 .449-1 1v8c0 .551.449 1 1 1h4.313L11 24.438c1 1 2 .488 2-.875V2.28c0-.791-.433-1.222-.969-1.219zm7.25 2a1 1 0 0 0-.218 1.906A8.96 8.96 0 0 1 24 13c0 3.524-2 6.55-4.938 8.031a1 1 0 1 0 .875 1.782C23.53 21 26 17.288 26 13s-2.471-8-6.063-9.813a1 1 0 0 0-.562-.124a1 1 0 0 0-.094 0m-2.375 3.874a1 1 0 0 0-.406 1.875C18.043 9.771 19 11.29 19 13c0 1.722-.972 3.261-2.531 4.219a1 1 0 1 0 1.062 1.687C19.601 17.636 21 15.476 21 13c0-2.461-1.387-4.633-3.438-5.906A1 1 0 0 0 17 6.937a1 1 0 0 0-.094 0'

/** Залитый замок boxicons:lock-filled (viewBox 24×24) */
const LOCK_PATH =
  'M6 22h12c1.1 0 2-.9 2-2v-9c0-1.1-.9-2-2-2h-1V7c0-2.76-2.24-5-5-5S7 4.24 7 7v2H6c-1.1 0-2 .9-2 2v9c0 1.1.9 2 2 2M9 7c0-1.65 1.35-3 3-3s3 1.35 3 3v2H9z'

/** Позиция замка внутри viewBox динамика: справа сверху */
const LOCK_TRANSFORM = 'translate(13.6, -1) scale(0.56)'

/**
 * Голосовой канал с ограничениями: динамик с залитым замком
 * справа сверху и вырезом вокруг него.
 */
export function RestrictedVoiceChannelIcon({
  className,
}: RestrictedVoiceChannelIconProps) {
  const maskId = useId()

  return (
    <svg
      viewBox="0 0 26 26"
      width="1em"
      height="1em"
      fill="currentColor"
      className={cn('shrink-0', className)}
      aria-hidden
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse">
          <rect width={26} height={26} fill="white" />
          {/* Силуэт замка с обводкой — вырезает зазор вокруг него */}
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
      <path d={SPEAKER_PATH} mask={`url(#${maskId})`} />
      <g transform={LOCK_TRANSFORM}>
        <path d={LOCK_PATH} />
      </g>
    </svg>
  )
}
