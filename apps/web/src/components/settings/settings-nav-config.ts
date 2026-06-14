import {
  BellIcon,
  MonitorIcon,
  PaletteIcon,
  PencilFillIcon,
  Volume2Icon,
} from '#/components/icons'
import type { AppIcon } from '#/components/icons'
import type { SettingsSection } from '#/features/settings/settings-modal-context'

export type GeneralSettingsSection = Exclude<SettingsSection, 'profile'>

export const GENERAL_SETTINGS_NAV: {
  id: GeneralSettingsSection
  label: string
  icon: AppIcon
}[] = [
  { id: 'account', label: 'Аккаунт', icon: PencilFillIcon },
  { id: 'voice', label: 'Голос и видео', icon: Volume2Icon },
  { id: 'sessions', label: 'Устройства', icon: MonitorIcon },
  { id: 'notifications', label: 'Уведомления', icon: BellIcon },
  { id: 'appearance', label: 'Оформление', icon: PaletteIcon },
]

export function isGeneralSettingsSection(
  section: SettingsSection,
): section is GeneralSettingsSection {
  return section !== 'profile'
}

export function resolveMobileSettingsStack(
  section: SettingsSection,
): MobileSettingsScreen[] {
  if (section === 'profile') {
    return [{ kind: 'section', section: 'profile' }]
  }
  if (section === 'account') {
    return [{ kind: 'general' }]
  }
  if (isGeneralSettingsSection(section)) {
    return [{ kind: 'section', section }]
  }
  return [{ kind: 'general' }]
}

export type MobileSettingsScreen =
  | { kind: 'general' }
  | { kind: 'section'; section: SettingsSection }
