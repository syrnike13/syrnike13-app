import { toast } from 'sonner'

import { writeClipboardText } from '#/lib/clipboard'

export async function copyMessageActionValue(label: string, value: string) {
  try {
    await writeClipboardText(value)
    toast.success(label)
  } catch {
    toast.error('Не удалось скопировать')
  }
}
