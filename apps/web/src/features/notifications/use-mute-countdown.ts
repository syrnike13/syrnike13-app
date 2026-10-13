import { useEffect, useState } from 'react'

/**
 * Тикающее «сейчас» для обратного отсчёта мьюта: подпись в меню и в строке
 * канала должна обновляться сама, стор для этого не меняется.
 * Тикаем только у заглушённых каналов, чтобы не будить остальные строки.
 */
export function useMuteCountdown(muted: boolean, intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!muted) return

    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [muted, intervalMs])

  return now
}
