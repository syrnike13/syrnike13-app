export const defaultMentionClassName =
  'inline rounded-sm bg-primary/35 px-0.5 font-medium text-primary-foreground transition-colors hover:bg-primary/55'

export function mentionColourStyle(colour: string | undefined) {
  if (!colour) return undefined
  return {
    color: 'var(--primary-foreground)',
    ['--mention-bg' as string]: `color-mix(in srgb, ${colour} 35%, transparent)`,
    ['--mention-bg-hover' as string]: `color-mix(in srgb, ${colour} 55%, transparent)`,
    backgroundColor: 'var(--mention-bg)',
  } as const
}
