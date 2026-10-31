import { requireNativeModule } from 'expo'

type AppUpdateModule = {
  /** Whether the user allowed this app to install APKs. */
  canInstall(): boolean
  openInstallSettings(): void
  /** Downloads the APK, checks its SHA-256 (hex) and opens the system installer. */
  downloadAndInstall(url: string, sha256: string): Promise<void>
}

export const AppUpdate = requireNativeModule<AppUpdateModule>('AppUpdate')
