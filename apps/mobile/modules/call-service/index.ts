import { requireNativeModule } from 'expo'

type CallServiceModule = {
  /** Shows the ongoing call notification; call while the app is in the foreground. */
  start(title: string, text: string): void
  stop(): void
}

export const CallService = requireNativeModule<CallServiceModule>('CallService')
