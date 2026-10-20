import { useCallback, useEffect, useState } from 'react'

/** Паузы перед повторными попытками; после последней ждём только `online`. */
export const IMAGE_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000, 60_000]

type RetryState = {
  src: string | null | undefined
  attempt: number
  failed: boolean
}

/**
 * Повторяет загрузку картинки после ошибки. Браузер и Radix Avatar сами
 * не перезапрашивают упавший URL, поэтому долгоживущие элементы (тайлы
 * войса, строки участников) застревают на fallback после сетевого сбоя.
 * `attempt` используется как `key`: перемонтирование создаёт новый запрос.
 */
export function useImageRetry(src: string | null | undefined) {
  const [state, setState] = useState<RetryState>({
    src,
    attempt: 0,
    failed: false,
  })
  const current = state.src === src
  const attempt = current ? state.attempt : 0
  const failed = current && state.failed

  useEffect(() => {
    if (!failed) return

    const retry = () =>
      setState({ src, attempt: attempt + 1, failed: false })
    const delay = IMAGE_RETRY_DELAYS_MS[attempt]
    const timer =
      delay === undefined ? undefined : window.setTimeout(retry, delay)
    window.addEventListener('online', retry)

    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('online', retry)
    }
  }, [attempt, failed, src])

  const onError = useCallback(() => {
    setState({ src, attempt, failed: true })
  }, [attempt, src])

  return { attempt, failed, onError }
}
