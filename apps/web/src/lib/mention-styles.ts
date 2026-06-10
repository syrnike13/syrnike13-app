export const defaultMentionClassName =
  'inline rounded-sm bg-primary/15 px-0.5 font-medium text-primary'

export function mentionColourStyle(colour: string | undefined) {
  if (!colour) return undefined
  return {
    color: colour,
    backgroundColor: `color-mix(in srgb, ${colour} 18%, transparent)`,
  } as const
}
