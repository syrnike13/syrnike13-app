import {
  RiGamepadLine,
  RiVideoOffFill,
  RiVideoOnFill,
  RiVolumeMuteLine,
  RiVolumeUpFill,
} from '@remixicon/react'
import { Microphone, MicrophoneMute } from 'iconoir-react/solid'

import { iconifyIcon } from '#/components/icons/adapters/iconify'
import { defineIcon } from '#/components/icons/define-icon'

export const MicIcon = defineIcon(Microphone, {
  pack: 'iconoir',
  name: 'microphone-solid',
})

export const MicOffIcon = defineIcon(MicrophoneMute, {
  pack: 'iconoir',
  name: 'microphone-mute-solid',
})

export const HeadphonesIcon = defineIcon(
  iconifyIcon('material-symbols:headphones-rounded'),
  {
    pack: 'iconify',
    name: 'material-symbols:headphones-rounded',
  },
)

export const HeadphoneOffIcon = defineIcon(
  iconifyIcon('material-symbols:headset-off-rounded'),
  {
    pack: 'iconify',
    name: 'material-symbols:headset-off-rounded',
  },
)

export const VideoIcon = defineIcon(RiVideoOnFill, {
  pack: 'remixicon',
  name: 'RiVideoOnFill',
})

export const VideoOffIcon = defineIcon(RiVideoOffFill, {
  pack: 'remixicon',
  name: 'RiVideoOffFill',
})

export const PhoneOffIcon = defineIcon(iconifyIcon('f7:phone-down-fill'), {
  pack: 'iconify',
  name: 'f7:phone-down-fill',
})

export const MonitorUpIcon = defineIcon(iconifyIcon('ic:round-screen-share'), {
  pack: 'iconify',
  name: 'ic:round-screen-share',
})

export const Volume2Icon = defineIcon(RiVolumeUpFill, {
  pack: 'remixicon',
  name: 'RiVolumeUpFill',
})

/** Иконка голосового канала — сайдбар, dock, создание канала */
export const Volume2BoldIcon = defineIcon(iconifyIcon('wpf:speaker'), {
  pack: 'iconify',
  name: 'wpf:speaker',
})

export const VolumeXIcon = defineIcon(RiVolumeMuteLine, {
  pack: 'remixicon',
  name: 'RiVolumeMuteLine',
})

export const MonitorXIcon = defineIcon(
  iconifyIcon('ic:round-stop-screen-share'),
  {
    pack: 'iconify',
    name: 'ic:round-stop-screen-share',
  },
)

export const SignalIcon = defineIcon(iconifyIcon('lucide:signal'), {
  pack: 'iconify',
  name: 'lucide:signal',
})

export const Gamepad2Icon = defineIcon(RiGamepadLine, {
  pack: 'remixicon',
  name: 'RiGamepadLine',
})

/** Звуковая панель в голосовой панели пользователя. */
export const SoundboardIcon = defineIcon(iconifyIcon('lucide:audio-lines'), {
  pack: 'iconify',
  name: 'lucide:audio-lines',
})

/** Активность в голосовой панели пользователя. */
export const ActivityIcon = defineIcon(iconifyIcon('duo-icons:app'), {
  pack: 'iconify',
  name: 'duo-icons:app',
})
