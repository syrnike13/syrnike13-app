import {
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiErrorWarningLine,
  RiInformationLine,
  RiWifiLine,
  RiWifiOffLine,
} from '@remixicon/react'

import { defineIcon } from '#/components/icons/define-icon'

export const CircleCheckIcon = defineIcon(RiCheckboxCircleLine, {
  pack: 'remixicon',
  name: 'RiCheckboxCircleLine',
})

export const InfoIcon = defineIcon(RiInformationLine, {
  pack: 'remixicon',
  name: 'RiInformationLine',
})

export const TriangleAlertIcon = defineIcon(RiErrorWarningLine, {
  pack: 'remixicon',
  name: 'RiErrorWarningLine',
})

export const OctagonXIcon = defineIcon(RiCloseCircleLine, {
  pack: 'remixicon',
  name: 'RiCloseCircleLine',
})

export const WifiIcon = defineIcon(RiWifiLine, {
  pack: 'remixicon',
  name: 'RiWifiLine',
})

export const WifiOffIcon = defineIcon(RiWifiOffLine, {
  pack: 'remixicon',
  name: 'RiWifiOffLine',
})
