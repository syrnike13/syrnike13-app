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

  const containerBoxStyle = React.useMemo((): React.CSSProperties | undefined => {
    if (!useIntrinsicBox) return undefined
    return {
      aspectRatio,
      width: 'auto',
      maxWidth: '100%',
      height: 'auto',
    }
  }, [aspectRatio, useIntrinsicBox])

  const { draggable, style: wrapperStyle, ...containerProps } = wrapperProps

  const containerClassName = cn(
    fill ? 'absolute inset-0 z-0 overflow-hidden' : 'relative z-0 overflow-hidden',
    useIntrinsicBox && 'w-fit max-w-full',
    wrapperClassName,
  )

  const containerStyle: React.CSSProperties = {
    ...containerBoxStyle,
    ...wrapperStyle,
  }

  return (
    <div
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
    </div>
  )
}
