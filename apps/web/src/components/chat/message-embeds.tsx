import type { Embed, File as MediaFile } from '@syrnike13/api-types'
import type { ReactNode } from 'react'

import { FileIcon, PlayIcon } from '#/components/icons'
import { FxImage } from '#/components/ui/fx-image'
import {
  attachmentOriginalUrl,
  attachmentPreviewUrl,
  embedMediaUrl,
  imageFileAspectRatio,
  isImageFile,
} from '#/lib/media'
import { cn } from '#/lib/utils'

/** Ссылку открываем только по http(s): javascript:/data: из чужой og-разметки не пускаем. */
function safeLink(url: string | null | undefined) {
  const value = url?.trim()
  if (!value || !/^https?:\/\//i.test(value)) return null
  return value
}

function hostnameOf(url: string | null | undefined) {
  const value = safeLink(url)
  if (!value) return null

  try {
    return new URL(value).hostname
  } catch {
    return null
  }
}

/**
 * Акцентный цвет приходит из og-разметки страницы (theme-color) — это данные,
 * а не хардкод темы. Пускаем только явные CSS-цвета, остальное — токен темы.
 */
const ACCENT_COLOUR_PATTERN =
  /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))$/i

export function embedAccentColour(colour: string | null | undefined) {
  const value = colour?.trim()
  if (!value || value.length > 32) return undefined
  return ACCENT_COLOUR_PATTERN.test(value) ? value : undefined
}

/**
 * Website-embed без заголовка, описания и медиа рисуется пустой рамкой —
 * повторяем WebsiteMetadata::is_empty из бэкенда.
 */
export function isRenderableEmbed(embed: Embed) {
  if (embed.type === 'None') return false

  if (embed.type === 'Website') {
    return Boolean(
      embed.title?.trim() ||
        embed.description?.trim() ||
        embed.image?.url ||
        embed.video?.url ||
        embed.special,
    )
  }

  return true
}

export function visibleEmbeds(embeds: readonly Embed[] | null | undefined) {
  return (embeds ?? []).filter(isRenderableEmbed)
}

function embedAspectRatio(width?: number | null, height?: number | null) {
  if (!width || !height) return null

  const ratio = width / height
  if (!Number.isFinite(ratio) || ratio <= 0) return null
  return ratio
}

function EmbedCardShell({
  type,
  colour,
  children,
}: {
  type: string
  colour?: string | null
  children: ReactNode
}) {
  const accent = embedAccentColour(colour)

  return (
    <div
      data-embed={type}
      className={cn(
        'flex max-w-lg flex-col gap-1 rounded-md border border-l-4 border-border bg-card/50 px-3 py-2 text-sm',
      )}
      style={accent ? { borderLeftColor: accent } : undefined}
    >
      {children}
    </div>
  )
}

function EmbedSiteHeader({
  iconUrl,
  siteName,
}: {
  iconUrl?: string | null
  siteName?: string | null
}) {
  const icon = safeLink(iconUrl)
  const name = siteName?.trim()

  if (!icon && !name) return null

  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {icon ? (
        <span className="relative size-4 shrink-0 overflow-hidden rounded-sm">
          <FxImage src={embedMediaUrl(icon)} alt="" fill rounded="sm" />
        </span>
      ) : null}
      {name ? <span className="truncate">{name}</span> : null}
    </div>
  )
}

function EmbedTitleLink({
  href,
  children,
}: {
  href?: string | null
  children: string
}) {
  const link = safeLink(href)

  if (!link) {
    return <span className="font-semibold text-foreground">{children}</span>
  }

  return (
    <a
      href={link}
      target="_blank"
      rel="noreferrer noopener"
      className="font-semibold text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {children}
    </a>
  )
}

function EmbedDescription({ text }: { text?: string | null }) {
  const value = text?.trim()
  if (!value) return null

  return (
    <p className="line-clamp-4 whitespace-pre-line text-muted-foreground">
      {value}
    </p>
  )
}

/**
 * Box картинки: до decode резервируем высоту по ratio, иначе карточка прыгает.
 * Разметка повторяет SingleImageAttachment, чтобы превью не отличалось от вложений.
 */
function EmbedImageBox({
  src,
  alt,
  ratio,
}: {
  src: string
  alt: string
  ratio: number | null
}) {
  const aspectRatio = ratio ?? 1

  return (
    <div
      data-embed-image
      data-aspect-ratio={String(aspectRatio)}
      className="relative max-h-96 w-full max-w-full overflow-hidden rounded-md border border-border bg-border"
      style={{
        aspectRatio,
        width: `min(100%, 28rem, calc(24rem * ${aspectRatio}))`,
      }}
    >
      <FxImage src={src} alt={alt} fill objectFit="contain" />
    </div>
  )
}

function EmbedVideoLink({
  url,
  width,
  height,
}: {
  url: string
  width?: number | null
  height?: number | null
}) {
  const link = safeLink(url)
  const host = hostnameOf(url) ?? 'Видео'
  const className =
    'flex items-center gap-2 rounded-md border border-border bg-background/40 px-3 py-2 text-xs text-foreground'

  const body = (
    <>
      <PlayIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{host}</span>
      {width && height ? (
        <span className="shrink-0 text-muted-foreground">
          {width}×{height}
        </span>
      ) : null}
    </>
  )

  if (!link) {
    return <div className={className}>{body}</div>
  }

  return (
    <a
      data-embed-video-link
      href={link}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(className, 'hover:bg-background/70')}
    >
      {body}
    </a>
  )
}

function WebsiteEmbed({ embed }: { embed: Extract<Embed, { type: 'Website' }> }) {
  const link = safeLink(embed.url) ?? safeLink(embed.original_url)
  const title = embed.title?.trim()
  const imageUrl = safeLink(embed.image?.url)
  const videoUrl = safeLink(embed.video?.url)
  const thumbnail = imageUrl && embed.image?.size === 'Preview' ? imageUrl : null
  const hero = imageUrl && !thumbnail ? imageUrl : null

  return (
    <EmbedCardShell type="website" colour={embed.colour}>
      <EmbedSiteHeader
        iconUrl={embed.icon_url}
        siteName={embed.site_name}
      />
      <div className="flex min-w-0 gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {title ? <EmbedTitleLink href={link}>{title}</EmbedTitleLink> : null}
          <EmbedDescription text={embed.description} />
          {videoUrl ? (
            <EmbedVideoLink
              url={videoUrl}
              width={embed.video?.width}
              height={embed.video?.height}
            />
          ) : null}
        </div>
        {thumbnail ? (
          <span className="relative size-20 shrink-0 overflow-hidden rounded-md border border-border bg-border">
            <FxImage
              src={embedMediaUrl(thumbnail)}
              alt={title ?? 'Превью ссылки'}
              fill
              objectFit="cover"
            />
          </span>
        ) : null}
      </div>
      {hero ? (
        <EmbedImageBox
          src={embedMediaUrl(hero)}
          alt={title ?? 'Превью ссылки'}
          ratio={embedAspectRatio(embed.image?.width, embed.image?.height)}
        />
      ) : null}
    </EmbedCardShell>
  )
}

function ImageEmbed({ embed }: { embed: Extract<Embed, { type: 'Image' }> }) {
  const link = safeLink(embed.url)
  const box = (
    <EmbedImageBox
      src={embedMediaUrl(embed.url)}
      alt="Изображение"
      ratio={embedAspectRatio(embed.width, embed.height)}
    />
  )

  if (!link) {
    return <div data-embed="image">{box}</div>
  }

  return (
    <a
      data-embed="image"
      href={link}
      target="_blank"
      rel="noreferrer noopener"
      className="block max-w-full rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {box}
    </a>
  )
}

function VideoEmbed({ embed }: { embed: Extract<Embed, { type: 'Video' }> }) {
  const link = safeLink(embed.url)
  const host = hostnameOf(embed.url) ?? 'Видео'

  if (!link) {
    return (
      <EmbedCardShell type="video">
        <span className="truncate text-muted-foreground">{host}</span>
      </EmbedCardShell>
    )
  }

  return (
    <EmbedCardShell type="video">
      <a
        data-embed-video-link
        href={link}
        target="_blank"
        rel="noreferrer noopener"
        className="flex items-center gap-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <PlayIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-foreground">{host}</span>
      </a>
    </EmbedCardShell>
  )
}

function EmbedMediaLink({ media }: { media: MediaFile }) {
  const label = media.filename?.trim() || media._id

  return (
    <a
      href={attachmentOriginalUrl(media)}
      target="_blank"
      rel="noreferrer noopener"
      className="flex items-center gap-2 rounded-md border border-border bg-background/40 px-3 py-2 text-xs text-foreground hover:bg-background/70"
    >
      <FileIcon className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </a>
  )
}

function TextEmbed({ embed }: { embed: Extract<Embed, { type: 'Text' }> }) {
  const link = safeLink(embed.url)
  const title = embed.title?.trim()
  const description = embed.description?.trim()
  const media = embed.media
  const host = hostnameOf(embed.url)
  const empty = !title && !description && !media

  return (
    <EmbedCardShell type="text" colour={embed.colour}>
      <EmbedSiteHeader iconUrl={embed.icon_url} />
      {title ? <EmbedTitleLink href={link}>{title}</EmbedTitleLink> : null}
      <EmbedDescription text={embed.description} />
      {media ? (
        isImageFile(media) ? (
          <EmbedImageBox
            src={attachmentPreviewUrl(media)}
            alt={media.filename?.trim() || 'Изображение'}
            ratio={imageFileAspectRatio(media)}
          />
        ) : (
          <EmbedMediaLink media={media} />
        )
      ) : null}
      {empty && link ? (
        <a
          href={link}
          target="_blank"
          rel="noreferrer noopener"
          className="truncate text-muted-foreground hover:underline"
        >
          {host ?? link}
        </a>
      ) : null}
    </EmbedCardShell>
  )
}

function EmbedCard({ embed }: { embed: Embed }) {
  switch (embed.type) {
    case 'Website':
      return <WebsiteEmbed embed={embed} />
    case 'Image':
      return <ImageEmbed embed={embed} />
    case 'Video':
      return <VideoEmbed embed={embed} />
    case 'Text':
      return <TextEmbed embed={embed} />
    default:
      return null
  }
}

/** Превью ссылок, картинок и видео из `message.embeds`. */
export function MessageEmbeds({
  embeds,
}: {
  embeds: readonly Embed[] | null | undefined
}) {
  const items = visibleEmbeds(embeds)
  if (!items.length) return null

  return (
    <div data-message-embeds className="flex flex-col gap-2">
      {items.map((embed, index) => (
        <EmbedCard key={`${embed.type}-${index}`} embed={embed} />
      ))}
    </div>
  )
}
