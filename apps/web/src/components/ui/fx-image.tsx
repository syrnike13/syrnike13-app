import * as React from 'react'

import { cn } from '#/lib/utils.ts'

const roundedClass = {
  none: '',
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  full: 'rounded-full',
} as const

export type FxImageRounded = keyof typeof roundedClass

export type FxImageProps = {
  src: string
  alt?: string
  className?: string
  wrapperClassName?: string
  wrapperAs?: 'div' | 'span'
  aspectRatio?: number
  fill?: boolean
  rounded?: FxImageRounded
  objectFit?: 'cover' | 'contain'
} & Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'children' | 'className'
>

export function FxImage({
  src,
  alt = '',
  className,
  wrapperClassName,
  wrapperAs: Wrapper = 'div',
  aspectRatio,
  fill = false,
  rounded = 'none',
  objectFit = 'cover',
  ...wrapperProps
}: FxImageProps) {
  const roundedCls = roundedClass[rounded]
  const imageClassName = cn(
    'block size-full',
    objectFit === 'cover' ? 'object-cover' : 'object-contain',
    roundedCls,
    className,
  )

  const useIntrinsicBox =
    !fill &&
    aspectRatio != null &&
    Number.isFinite(aspectRatio) &&
    aspectRatio > 0

  const { draggable, style: wrapperStyle, ...containerProps } = wrapperProps

  const containerClassName = cn(
    fill ? 'absolute inset-0 z-0 overflow-hidden' : 'relative z-0 overflow-hidden',
    useIntrinsicBox && 'aspect-(--intrinsic-aspect) w-fit max-w-full',
    wrapperClassName,
  )

  /* eslint-disable shadcn/no-inline-styles -- wrapperProps style passthrough */
  const containerStyle = (
    useIntrinsicBox
      ? {
          '--intrinsic-aspect': aspectRatio,
          ...wrapperStyle,
        }
      : wrapperStyle
  ) as React.CSSProperties
  /* eslint-enable shadcn/no-inline-styles */

  return (
    <Wrapper
      className={containerClassName}
      style={containerStyle}
      {...containerProps}
    >
      <img
        src={src}
        alt={alt}
        className={imageClassName}
        draggable={draggable}
        loading="lazy"
        decoding="async"
      />
    </Wrapper>
  )
}
