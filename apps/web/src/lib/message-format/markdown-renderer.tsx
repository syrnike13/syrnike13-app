import { useMemo, type ReactNode } from 'react'
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

function SyrnikeEntityLink({
  href,
  context,
}: {
  href: string
  context: MessageFormatContext
}) {
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
    return (
      <span
        className="cursor-pointer rounded bg-foreground/10 px-1 text-transparent transition hover:text-inherit"
        title="Спойлер — наведите, чтобы показать"
      >
        {text}
      </span>
    )
  }

  return null
}

function createMarkdownComponents(
  context: MessageFormatContext,
): Components {
  return {
    h1: ({ children }) => (
      <h1 className="my-0.5 text-xl font-bold leading-snug">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="my-0.5 text-lg font-semibold leading-snug">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="my-0.5 text-base font-semibold leading-snug">{children}</h3>
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
      <p className="my-0 whitespace-pre-wrap leading-relaxed">{children}</p>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-0.5 border-l-2 border-primary/40 pl-2 text-muted-foreground">
        {children}
      </blockquote>
    ),
    ul: ({ children }) => (
      <ul className="my-0.5 list-disc pl-5">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="my-0.5 list-decimal pl-5">{children}</ol>
    ),
    li: ({ children }) => (
      <li className="my-0 leading-relaxed [&>p:only-child]:my-0 [&>p:only-child]:inline">
        {children}
      </li>
    ),
    pre: ({ children }) => (
      <pre className="my-1 overflow-x-auto rounded-md bg-background/60 p-2 font-mono text-[0.9em]">
        {children}
      </pre>
    ),
    code: ({ className, children }) => {
      const isBlock = Boolean(className)
      if (isBlock) {
        return <code className={className}>{children}</code>
      }
      return (
        <code className="rounded bg-background/60 px-1 py-0.5 font-mono text-[0.9em]">
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
          className="text-primary underline underline-offset-2"
        >
          {children}
        </a>
      )
    },
    strong: ({ children }) => (
      <strong className="font-semibold">{children}</strong>
    ),
    em: ({ children }) => <em className="italic">{children}</em>,
    del: ({ children }) => (
      <span className="line-through opacity-80">{children}</span>
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
