import { Mark, mergeAttributes } from '@tiptap/core'

export function createSpoilerMark(title: string) {
  return Mark.create({
    name: 'spoiler',

    parseHTML() {
      return [{ tag: 'span[data-spoiler]' }]
    },

    renderHTML({ HTMLAttributes }) {
      return [
        'span',
        mergeAttributes(HTMLAttributes, {
          'data-spoiler': '',
          class:
            'cursor-pointer rounded bg-foreground/10 px-1 text-transparent transition hover:text-inherit',
          ...(title ? { title } : {}),
        }),
        0,
      ]
    },
  })
}

export const SpoilerMark = createSpoilerMark('')
