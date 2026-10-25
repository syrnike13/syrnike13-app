import {
  BellIcon,
  GlobeIcon,
  MonitorIcon,
  PaletteIcon,
  PencilFillIcon,
  ShieldIcon,
  Volume2Icon,
} from '#/components/icons'
import type { AppIcon } from '#/components/icons'
import type { SettingsSection } from '#/features/settings/settings-modal-context'

export type GeneralSettingsSection = Exclude<SettingsSection, 'profile'>

export const GENERAL_SETTINGS_NAV: {
  id: GeneralSettingsSection
  labelKey: string
  icon: AppIcon
}[] = [
  { id: 'account', labelKey: 'sections.account', icon: PencilFillIcon },
  { id: 'voice', labelKey: 'sections.voice', icon: Volume2Icon },
  { id: 'sessions', labelKey: 'sections.sessions', icon: MonitorIcon },
  { id: 'privacy', labelKey: 'sections.privacy', icon: ShieldIcon },
  {
    id: 'notifications',
    labelKey: 'sections.notifications',
    icon: BellIcon,
  },
  {
    id: 'appearance',
    labelKey: 'sections.appearance',
    icon: PaletteIcon,
  },
  { id: 'language', labelKey: 'sections.language', icon: GlobeIcon },
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
