import * as React from 'react'
import {
  ImageGeneration,
  type ImageGenerationHandle,
  type ImageGenerationPreset,
  type ImageGenerationTheme,
} from 'img-fx'

import { initImgFx } from '#/lib/fx-image-init.ts'
import {
  FX_IMAGE_FORCE_MIN_SHADER_MS,
  fxImageNetworkUrl,
  isImageCached,
  shouldForceFxLoader,
} from '#/lib/fx-image-cache.ts'
import { cn } from '#/lib/utils.ts'

const MIN_SHADER_PX = 96
const MAX_SHADER_BOOST = 3
const SHADER_DELAY_MS = 120

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
  preset?: ImageGenerationPreset
  theme?: ImageGenerationTheme
  cardBg?: string
  fill?: boolean
  rounded?: FxImageRounded
  borderRadius?: number
  strength?: number
  paused?: boolean
  objectFit?: 'cover' | 'contain'
} & Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'children' | 'className' | 'style'
>

/** cached — сразу <img>; pending — ждём; effect — мозаика и reveal через img-fx. */
type Mode = 'cached' | 'pending' | 'effect'

function shaderCanvasSize(width: number, height: number) {
  const min = Math.min(width, height)
  if (min < 2) return null
  const boost = Math.min(MAX_SHADER_BOOST, Math.max(1, MIN_SHADER_PX / min))
  return {
    width: Math.ceil(width * boost),
    height: Math.ceil(height * boost),
  }
}

function scheduleRevealWhenSized(handle: ImageGenerationHandle | null) {
  if (!handle?.element) return () => {}

  let cancelled = false
  let revealed = false

  const attempt = () => {
    if (cancelled || revealed) return
    const el = handle.element
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    if (width < 2 || height < 2) return
    revealed = true
    handle.triggerReveal({ hold: 'manual' })
  }

  const observer = new ResizeObserver(() => attempt())
  observer.observe(handle.element)

  const frameId = requestAnimationFrame(() => {
    requestAnimationFrame(attempt)
  })

  return () => {
    cancelled = true
    observer.disconnect()
    cancelAnimationFrame(frameId)
  }
}

export function FxImage({
  src,
  alt = '',
  className,
  wrapperClassName,
  aspectRatio,
  preset = 'pixels-organic',
  theme = 'auto',
  cardBg,
  fill = false,
  rounded = 'none',
  borderRadius,
  strength = 1,
  paused = false,
  objectFit = 'cover',
  ...wrapperProps
}: FxImageProps) {
  initImgFx()

  const fxRef = React.useRef<ImageGenerationHandle>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const modeRef = React.useRef<Mode>('pending')

  const [mode, setMode] = React.useState<Mode>(() => {
    if (shouldForceFxLoader()) return 'effect'
    return isImageCached(src) ? 'cached' : 'pending'
  })
  const [revealReady, setRevealReady] = React.useState(false)
  const [shaderSize, setShaderSize] = React.useState({
    width: MIN_SHADER_PX,
    height: MIN_SHADER_PX,
  })

  const loadUrl = React.useMemo(
    () => (shouldForceFxLoader() ? fxImageNetworkUrl(src) : src),
    [src],
  )

  modeRef.current = mode

  const setModeSafe = React.useCallback((next: Mode) => {
    modeRef.current = next
    setMode(next)
  }, [])

  const roundedCls = roundedClass[rounded]
  const imageClassName = cn(
    'block size-full',
    objectFit === 'cover' ? 'object-cover' : 'object-contain',
    roundedCls,
    className,
  )

  const measureShader = React.useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const next = shaderCanvasSize(width, height)
    if (!next) return
    setShaderSize((prev) =>
      prev.width === next.width && prev.height === next.height ? prev : next,
    )
  }, [])

  React.useLayoutEffect(() => {
    if (mode !== 'effect') return
    measureShader()
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(measureShader)
    observer.observe(el)
    return () => observer.disconnect()
  }, [mode, measureShader, src])

  React.useLayoutEffect(() => {
    if (!src) return

    const forceLoader = shouldForceFxLoader()

    if (!forceLoader && isImageCached(src)) {
      setModeSafe('cached')
      setRevealReady(false)
      return
    }

    setRevealReady(false)

    if (forceLoader) {
      setModeSafe('effect')
    } else {
      setModeSafe('pending')
    }

    const img = new Image()
    let cancelled = false
    let decoded = false
    const loadStartedAt = performance.now()

    const armReveal = () => {
      if (forceLoader) {
        const wait = Math.max(
          0,
          FX_IMAGE_FORCE_MIN_SHADER_MS - (performance.now() - loadStartedAt),
        )
        window.setTimeout(() => {
          if (!cancelled) setRevealReady(true)
        }, wait)
        return
      }
      setRevealReady(true)
    }

    const shaderTimer = window.setTimeout(() => {
      if (cancelled || decoded) return
      setModeSafe('effect')
    }, forceLoader ? 0 : SHADER_DELAY_MS)

    img.onload = () => {
      if (cancelled) return
      decoded = true
      window.clearTimeout(shaderTimer)

      if (modeRef.current === 'pending') {
        setModeSafe('cached')
        return
      }

      armReveal()
    }

    img.onerror = () => {
      if (cancelled) return
      decoded = true
      window.clearTimeout(shaderTimer)
      setModeSafe('cached')
    }

    img.src = loadUrl

    return () => {
      cancelled = true
      window.clearTimeout(shaderTimer)
      img.onload = null
      img.onerror = null
      img.src = ''
      setRevealReady(false)
    }
  }, [src, loadUrl, setModeSafe])

  React.useLayoutEffect(() => {
    if (mode !== 'effect' || !revealReady) return

    let cancel = scheduleRevealWhenSized(fxRef.current)
    if (fxRef.current?.element) return cancel

    const id = requestAnimationFrame(() => {
      cancel = scheduleRevealWhenSized(fxRef.current)
    })

    return () => {
      cancel()
      cancelAnimationFrame(id)
    }
  }, [mode, revealReady, loadUrl])

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

  if (mode === 'cached') {
    return (
      <div
        ref={containerRef}
        className={containerClassName}
        style={containerStyle}
        data-fx-force={shouldForceFxLoader() ? '' : undefined}
        {...containerProps}
      >
        <img
          src={src}
          alt={alt}
          className={imageClassName}
          draggable={draggable}
        />
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={containerClassName}
      style={containerStyle}
      data-fx-force={shouldForceFxLoader() ? '' : undefined}
      {...containerProps}
    >
      {mode === 'effect' ? (
        <div
          className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
          aria-hidden
        >
          <ImageGeneration
            ref={fxRef}
            preset={preset}
            theme={theme}
            images={[loadUrl]}
            cardBg={cardBg}
            borderRadius={borderRadius}
            strength={strength}
            paused={paused}
            className="overflow-hidden"
            style={{
              width: shaderSize.width,
              height: shaderSize.height,
            }}
          >
            <div
              style={{
                width: shaderSize.width,
                height: shaderSize.height,
              }}
            />
          </ImageGeneration>
        </div>
      ) : null}
      {alt ? <span className="sr-only">{alt}</span> : null}
    </div>
  )
}
