import { getSyrnikeDesktop } from '#/platform/runtime'

export async function writeClipboardText(text: string) {
  const desktop = getSyrnikeDesktop()
  if (desktop) {
    await desktop.clipboard.writeText(text)
    return
  }

  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    throw new Error('Clipboard API is not available')
  }

  await navigator.clipboard.writeText(text)
}
