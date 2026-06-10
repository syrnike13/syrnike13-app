import type { User } from '@syrnike13/api-types'
import { Extension } from '@tiptap/core'
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion'

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

export type MentionSuggestionConfig = {
  items: (props: { query: string }) => MentionSuggestionItem[]
  render: SuggestionOptions<MentionSuggestionItem>['render']
}

export function createMentionSuggestionExtension(
  config: MentionSuggestionConfig,
) {
  return Extension.create({
    name: 'mentionSuggestion',

    addProseMirrorPlugins() {
      return [
        Suggestion<MentionSuggestionItem>({
          editor: this.editor,
          char: '@',
          allowSpaces: false,
          items: ({ query }) => config.items({ query }),
          render: config.render,
          command: ({ editor, range, props }) => {
            if (props.kind === 'everyone' || props.kind === 'online') {
              editor
                .chain()
                .focus()
                .insertContentAt(range, [
                  { type: 'massMention', attrs: { kind: props.kind } },
                  { type: 'text', text: ' ' },
                ])
                .run()
              return
            }

            editor
              .chain()
              .focus()
              .insertContentAt(range, [
                { type: 'userMention', attrs: { id: props.id } },
                { type: 'text', text: ' ' },
              ])
              .run()
          },
        }),
      ]
    },
  })
}
