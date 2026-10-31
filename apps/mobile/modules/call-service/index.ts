import { requireNativeModule, type EventSubscription } from 'expo'

type CallServiceModule = {
  /** Shows the ongoing call notification; call while the app is in the foreground. */
  start(title: string, text: string): void
  stop(): void
  /** While enabled, leaving the app shrinks it into a PiP window (Android 12+). */
  setPictureInPicture(enabled: boolean, width: number, height: number): void
  isInPictureInPicture(): boolean
  addListener(
    event: 'onPictureInPictureModeChanged',
    listener: (event: { active: boolean }) => void,
  ): EventSubscription
}

export const CallService = requireNativeModule<CallServiceModule>('CallService')
