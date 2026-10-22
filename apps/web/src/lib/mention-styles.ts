export const defaultMentionClassName =
  'inline rounded-sm bg-primary/35 px-0.5 font-medium text-foreground transition-colors hover:bg-primary/55'

export function mentionColourValues(colour: string | undefined) {
  if (!colour) return undefined
  return {
    background: `color-mix(in srgb, ${colour} 35%, transparent)`,
    backgroundHover: `color-mix(in srgb, ${colour} 55%, transparent)`,
  }
}
