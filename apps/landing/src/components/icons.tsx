import {
  RiAppleFill,
  RiUbuntuFill,
  RiWindowsFill,
} from '@remixicon/react'

import { defineIcon } from '#/components/define-icon'

export const WindowsIcon = defineIcon(RiWindowsFill, {
  pack: 'remixicon',
  name: 'RiWindowsFill',
})

export const AppleIcon = defineIcon(RiAppleFill, {
  pack: 'remixicon',
  name: 'RiAppleFill',
})

export const LinuxIcon = defineIcon(RiUbuntuFill, {
  pack: 'remixicon',
  name: 'RiUbuntuFill',
})
