import { Extension, InputRule } from '@tiptap/core'

export type EmojiShortcodeResolver = (
  name: string,
) => { unicode: string } | { customId: string } | null

/**
 * Discord behaviour: a completed `:shortcode:` turns into the emoji as soon as
 * the closing colon is typed. Unknown names stay as plain text.
 */
export function createEmojiShortcodeExtension(resolve: EmojiShortcodeResolver) {
  return Extension.create({
    name: 'emojiShortcode',

    addInputRules() {
      return [
        new InputRule({
          find: /(?:^|\s)(:([\w+-]{2,}):)$/,
          handler: ({ state, range, match }) => {
            const resolved = resolve(match[2]!.toLowerCase())
            if (!resolved) return null
            const start = range.to - match[1]!.length
            const node =
              'customId' in resolved
                ? state.schema.nodes.customEmoji?.create({ id: resolved.customId })
                : state.schema.text(resolved.unicode)
            if (!node) return null
            state.tr.replaceWith(start, range.to, node)
          },
        }),
      ]
    },
  })
}
