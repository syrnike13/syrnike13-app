import {
  RiWindowFill,
  RiComputerFill,
  RiEmotionFill,
  RiGlobalFill,
  RiGroupFill,
  RiKeyboardFill,
  RiLayoutFill,
  RiNotificationFill,
  RiPaletteFill,
  RiPencilFill,
  RiPencilLine,
  RiShieldFill,
  RiShieldLine,
} from '@remixicon/react'

import { iconifyIcon } from '#/components/icons/adapters/iconify'
import { defineIcon } from '#/components/icons/define-icon'

const MaterialSettingsRoundedIcon = iconifyIcon(
  'material-symbols:settings-rounded',
)

export const SettingsIcon = defineIcon(MaterialSettingsRoundedIcon, {
  pack: 'iconify',
  name: 'material-symbols:settings-rounded',
})

export const Settings2Icon = defineIcon(MaterialSettingsRoundedIcon, {
  pack: 'iconify',
  name: 'material-symbols:settings-rounded',
})

export const BellIcon = defineIcon(RiNotificationFill, {
  pack: 'remixicon',
  name: 'RiNotificationFill',
})

export const MonitorIcon = defineIcon(RiComputerFill, {
  pack: 'remixicon',
  name: 'RiComputerFill',
})

export const PaletteIcon = defineIcon(RiPaletteFill, {
  pack: 'remixicon',
  name: 'RiPaletteFill',
})

export const PencilFillIcon = defineIcon(RiPencilFill, {
  pack: 'remixicon',
  name: 'RiPencilFill',
})

export const PencilIcon = defineIcon(RiPencilLine, {
  pack: 'remixicon',
  name: 'RiPencilLine',
})

export const KeyboardIcon = defineIcon(RiKeyboardFill, {
  pack: 'remixicon',
  name: 'RiKeyboardFill',
})

export const AppWindowIcon = defineIcon(RiWindowFill, {
  pack: 'remixicon',
  name: 'RiWindowFill',
})

export const GlobeIcon = defineIcon(RiGlobalFill, {
  pack: 'remixicon',
  name: 'RiGlobalFill',
})

export const LayoutTemplateIcon = defineIcon(RiLayoutFill, {
  pack: 'remixicon',
  name: 'RiLayoutFill',
})

export const ShieldFillIcon = defineIcon(RiShieldFill, {
  pack: 'remixicon',
  name: 'RiShieldFill',
})

export const ShieldIcon = defineIcon(RiShieldLine, {
  pack: 'remixicon',
  name: 'RiShieldLine',
})

export const SmileFillIcon = defineIcon(RiEmotionFill, {
  pack: 'remixicon',
  name: 'RiEmotionFill',
})

export const UsersFillIcon = defineIcon(RiGroupFill, {
  pack: 'remixicon',
  name: 'RiGroupFill',
})
