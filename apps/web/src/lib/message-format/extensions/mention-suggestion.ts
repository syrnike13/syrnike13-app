import type { User } from '@syrnike13/api-types'
import { Extension } from '@tiptap/core'
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'

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
    }
  | {
      kind: 'channel'
      id: string
      label: string
      description: string
    }

export type MentionSuggestionConfig = {
  items: (props: { query: string }) => MentionSuggestionItem[]
  render: SuggestionOptions<MentionSuggestionItem>['render']
  char?: '@' | '#'
  name?: string
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
          items: ({ query }) => config.items({ query }),
          render: config.render,
          command: ({ editor, range, props }) => {
            const mention =
              props.kind === 'everyone' || props.kind === 'online'
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
