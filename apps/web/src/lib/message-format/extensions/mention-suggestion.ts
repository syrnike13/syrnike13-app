import type { User } from '@syrnike13/api-types'
import { Extension } from '@tiptap/core'
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'

export const MAX_MENTION_SUGGESTION_ITEMS = 6

export type MentionSuggestionItem =
  | {
      kind: 'user'
      id: string
      user: User
      serverName: string
      username: string
      nameColour?: string
    }
  | {
      kind: 'everyone' | 'online'
      label: string
      description: string
    }
  | {
      kind: 'role'
      id: string
      label: string
      description: string
      colour?: string
    }
  | {
      kind: 'channel'
      id: string
      label: string
      description: string
    }
  | {
      kind: 'emoji'
      /** `:shortcode:` shown in the row. */
      label: string
      unicode?: string
      customId?: string
    }

export type MentionSuggestionConfig = {
  items: (props: { query: string }) => MentionSuggestionItem[]
  render: SuggestionOptions<MentionSuggestionItem>['render']
  char?: '@' | '#' | ':'
  name?: string
  /** Rows shown at most (mentions: 6). */
  limit?: number
}

export function createMentionSuggestionExtension(
  config: MentionSuggestionConfig,
) {
  return Extension.create({
    name: config.name ?? 'mentionSuggestion',

    addProseMirrorPlugins() {
      return [
        Suggestion<MentionSuggestionItem>({
          editor: this.editor,
          pluginKey: new PluginKey(config.name ?? 'mentionSuggestion'),
          char: config.char ?? '@',
          allowSpaces: false,
          items: ({ query }) =>
            config.items({ query }).slice(0, config.limit ?? MAX_MENTION_SUGGESTION_ITEMS),
          render: config.render,
          command: ({ editor, range, props }) => {
            const mention =
              props.kind === 'emoji'
                ? props.customId
                  ? { type: 'customEmoji', attrs: { id: props.customId } }
                  : { type: 'text', text: props.unicode ?? '' }
                : props.kind === 'everyone' || props.kind === 'online'
                ? { type: 'massMention', attrs: { kind: props.kind } }
                : props.kind === 'role'
                  ? { type: 'roleMention', attrs: { id: props.id } }
                  : props.kind === 'channel'
                    ? { type: 'channelMention', attrs: { id: props.id } }
                    : { type: 'userMention', attrs: { id: props.id } }
            const nextText = editor.state.doc.resolve(range.to).nodeAfter?.text
            const insertionRange = { ...range }
            const replacesSpace = nextText?.startsWith(' ') ?? false
            if (replacesSpace) insertionRange.to += 1
            const needsSpace =
              replacesSpace || !nextText || !/^[\s.,!?;:)}\]]/.test(nextText)

            editor
              .chain()
              .focus()
              .insertContentAt(
                insertionRange,
                needsSpace ? [mention, { type: 'text', text: ' ' }] : [mention],
              )
              .run()
          },
        }),
      ]
    },
  })
}
