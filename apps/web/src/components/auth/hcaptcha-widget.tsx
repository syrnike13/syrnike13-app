import HCaptcha from '@hcaptcha/react-hcaptcha'
import { useRef, type RefObject } from 'react'

type HCaptchaWidgetProps = {
  siteKey: string
  captchaRef: RefObject<HCaptcha | null>
}

/** Невидимая hCaptcha — токен запрашивается перед отправкой формы. */
export function HCaptchaWidget({ siteKey, captchaRef }: HCaptchaWidgetProps) {
  return (
    <HCaptcha
      ref={captchaRef}
      sitekey={siteKey}
      size="invisible"
    />
  )
}

export async function executeHcaptcha(
  captchaRef: RefObject<HCaptcha | null>,
): Promise<string | null> {
  const instance = captchaRef.current
  if (!instance) return null
  try {
    const result = await instance.execute({ async: true })
    return result.response ?? null
  } catch {
    return null
  }
}

export function useHcaptchaRef() {
  return useRef<HCaptcha>(null)
}
