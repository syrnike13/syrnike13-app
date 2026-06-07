import { toast } from 'sonner'

let denoiseUnavailableNotified = false

export function notifyDenoiseUnavailableOnce() {
  if (denoiseUnavailableNotified) return
  denoiseUnavailableNotified = true
  toast.warning(
    'Шумоподавление RNNoise недоступно. Остались гейт и остальная обработка микрофона.',
  )
}

export function resetDenoiseUnavailableNotify() {
  denoiseUnavailableNotified = false
}
