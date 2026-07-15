import {
  RiAndroidFill,
  RiAppleFill,
  RiUbuntuFill,
  RiWindowsFill,
} from '@remixicon/react'

import { defineIcon } from '#/components/icons/define-icon'

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

export const AndroidIcon = defineIcon(RiAndroidFill, {
  pack: 'remixicon',
  name: 'RiAndroidFill',
})
