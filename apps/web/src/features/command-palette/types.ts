export type CommandItem = {
  id: string
  group: string
  label: string
  subtitle?: string
  keywords: string
  score: number
  run: () => void
}
