import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import StarterKit from '@tiptap/starter-kit'
import type { Extensions } from '@tiptap/core'

import { ChannelMentionNode } from '#/lib/message-format/extensions/channel-mention'
import { CustomEmojiNode } from '#/lib/message-format/extensions/custom-emoji'
import { MassMentionNode } from '#/lib/message-format/extensions/mass-mention'
import {
  createMentionSuggestionExtension,
  type MentionSuggestionConfig,
} from '#/lib/message-format/extensions/mention-suggestion'
import { RoleMentionNode } from '#/lib/message-format/extensions/role-mention'
import { SpoilerMark } from '#/lib/message-format/extensions/spoiler'
import { UserMentionNode } from '#/lib/message-format/extensions/user-mention'

export type CreateMessageExtensionsOptions = {
  placeholder?: string
  mentionSuggestion?: MentionSuggestionConfig
}

export function createMessageExtensions(
  options: CreateMessageExtensionsOptions = {},
): Extensions {
  const extensions: Extensions = [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      horizontalRule: false,
      link: false,
    }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      HTMLAttributes: {
        class: 'text-primary underline underline-offset-2',
        rel: 'noreferrer noopener',
        target: '_blank',
      },
    }),
    SpoilerMark,
    UserMentionNode,
    RoleMentionNode,
    ChannelMentionNode,
    MassMentionNode,
    CustomEmojiNode,
  ]

  if (options.placeholder) {
    extensions.push(
      Placeholder.configure({
        placeholder: options.placeholder,
        emptyEditorClass: 'is-editor-empty',
      }),
    )
  }

  if (options.mentionSuggestion) {
    extensions.push(createMentionSuggestionExtension(options.mentionSuggestion))
  }

  return extensions
}
