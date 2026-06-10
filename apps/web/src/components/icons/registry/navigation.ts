import {
  RiGroupLine,
  RiHashtag,
  RiSearchLine,
  RiServerLine,
  RiUserLine,
} from '@remixicon/react'

import { defineIcon } from '#/components/icons/define-icon'

export const HashIcon = defineIcon(RiHashtag, {
  pack: 'remixicon',
  name: 'RiHashtag',
})

export const ServerIcon = defineIcon(RiServerLine, {
  pack: 'remixicon',
  name: 'RiServerLine',
})

export const SearchIcon = defineIcon(RiSearchLine, {
  pack: 'remixicon',
  name: 'RiSearchLine',
})

export const UsersIcon = defineIcon(RiGroupLine, {
  pack: 'remixicon',
  name: 'RiGroupLine',
})

export const UserIcon = defineIcon(RiUserLine, {
  pack: 'remixicon',
  name: 'RiUserLine',
})
