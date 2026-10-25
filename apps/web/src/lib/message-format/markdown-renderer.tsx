import { useMemo, useState, type ReactNode } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { MessageUserMention } from '#/components/chat/message-user-mention'
import { MentionPill } from '#/components/chat/mention-pill'
import { CustomEmoji } from '#/components/emoji/custom-emoji'
import {
  isSyrnikeEntityHref,
  parseSyrnikeEntityHref,
  prepareMessageMarkdown,
} from '#/lib/message-format/entity-markdown-bridge'
import type { MessageFormatContext } from '#/lib/message-format/types'

/** Спойлер как в Discord: скрыт до клика, после — остаётся открытым. */
function SpoilerText({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  const [revealed, setRevealed] = useState(false)

  if (revealed) {
    return <span className="rounded-sm bg-foreground/10">{children}</span>
  }

  return (
    // eslint-disable-next-line design/no-lookalike -- inline spoiler keeps text flow; role=button with keyboard handling
    <span
      role="button"
      tabIndex={0}
      title={title}
      className="cursor-pointer rounded-sm bg-foreground/25 transition-colors hover:bg-foreground/30"
      onClick={(event) => {
        event.stopPropagation()
        setRevealed(true)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          setRevealed(true)
        }
      }}
    >
      <span className="invisible">{children}</span>
    </span>
  )
}

function SyrnikeEntityLink({
  href,
  context,
}: {
  href: string
  context: MessageFormatContext
}) {
  const t = useTranslations('chat')
  const parsed = parseSyrnikeEntityHref(href)
  if (!parsed) return null

  if (parsed.kind === 'user') {
    const user = context.users?.[parsed.id]
    const member =
      context.serverId && context.members
        ? context.members[`${context.serverId}:${parsed.id}`]
        : undefined

    return (
      <MessageUserMention
        userId={parsed.id}
        user={user}
        server={context.server}
        serverId={context.serverId}
        serverName={context.serverName}
        member={member}
        currentUserId={context.currentUserId}
      />
    )
  }

  if (parsed.kind === 'role') {
    const role = context.roles?.[parsed.id]
    return <MentionPill label={`@${role?.name ?? parsed.id}`} />
  }

  if (parsed.kind === 'channel') {
    const channel = context.channels?.[parsed.id]
    const channelName =
      channel && 'name' in channel && channel.name
        ? channel.name
        : parsed.id
    return <MentionPill label={`#${channelName}`} />
  }

  if (parsed.kind === 'mass') {
    const label = parsed.id === 'online' ? '@online' : '@everyone'
    return <MentionPill label={label} />
  }

  if (parsed.kind === 'emoji') {
    const emoji = context.emojis?.[parsed.id]
    return <CustomEmoji emojiId={parsed.id} name={emoji?.name} />
  }

  if (parsed.kind === 'spoiler') {
    const text = decodeURIComponent(parsed.id)
    const inlineComponents = {
      ...createMarkdownComponents(context),
      p: ({ children }: { children?: ReactNode }) => <>{children}</>,
    }
    return (
      <SpoilerText title={t('spoilerShow')}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={inlineComponents}
          urlTransform={(url) =>
            url.startsWith('syrnike:') ? url : defaultUrlTransform(url)
          }
        >
          {text}
        </ReactMarkdown>
      </SpoilerText>
    )
  }

  return null
}

function createMarkdownComponents(
  context: MessageFormatContext,
): Components {
  return {
    h1: ({ children }) => (
      <h1 className="mt-2 mb-1 text-2xl leading-8 font-bold">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="mt-2 mb-1 text-xl leading-6.5 font-bold">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="mt-2 mb-1 text-base font-bold">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="my-0.5 text-sm font-semibold leading-snug">{children}</h4>
    ),
    h5: ({ children }) => (
      <h5 className="my-0.5 text-sm font-medium leading-snug">{children}</h5>
    ),
    h6: ({ children }) => (
      <h6 className="my-0.5 text-sm font-medium leading-snug text-muted-foreground">
        {children}
      </h6>
    ),
    p: ({ children }) => (
      <p className="whitespace-pre-wrap">{children}</p>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-0.5 border-l-4 border-muted-foreground/40 pl-3">
        {children}
      </blockquote>
    ),
    ul: ({ children }) => (
      <ul className="my-1 ml-4 list-disc">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="my-1 ml-4 list-decimal">{children}</ol>
    ),
    li: ({ children }) => (
      <li className="[&>p:only-child]:inline">
        {children}
      </li>
    ),
    pre: ({ children }) => (
      <pre className="my-1 max-w-full overflow-x-auto rounded-md border border-border bg-secondary p-2 font-mono text-sm leading-4.5">
        {children}
      </pre>
    ),
    code: ({ className, children }) => {
      const isBlock = Boolean(className)
      if (isBlock) {
        return <code className={className}>{children}</code>
      }
      return (
        <code className="rounded-sm bg-secondary px-1 py-0.5 font-mono text-sm">
          {children}
        </code>
      )
    },
    a: ({ href, children }) => {
      if (href && isSyrnikeEntityHref(href)) {
        return <SyrnikeEntityLink href={href} context={context} />
      }

      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-primary hover:underline"
        >
          {children}
        </a>
      )
    },
    strong: ({ children }) => (
      <strong className="font-bold">{children}</strong>
    ),
    em: ({ children }) => <em className="italic">{children}</em>,
    del: ({ children }) => (
      <span className="line-through">{children}</span>
    ),
  }
}

type MessageMarkdownRendererProps = {
  content: string
  context?: MessageFormatContext
}

export function MessageMarkdownRenderer({
  content,
  context = {},
}: MessageMarkdownRendererProps): ReactNode {
  const markdown = useMemo(() => prepareMessageMarkdown(content), [content])
  const components = useMemo(
    () => createMarkdownComponents(context),
    [context],
  )

  if (!content) return null

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={components}
      urlTransform={(url) => {
        if (url.startsWith('syrnike:')) return url
        return defaultUrlTransform(url)
      }}
    >
      {markdown}
    </ReactMarkdown>
  )
}
