import {
  RiCheckDoubleLine,
  RiEmotionAddLine,
  RiEmotionHappyLine,
  RiFileCopyLine,
  RiFileLine,
  RiLink,
  RiLinksLine,
  RiMoreLine,
  RiPushpinLine,
  RiReplyLine,
  RiUnpinLine,
} from '@remixicon/react'

import { iconifyIcon } from '#/components/icons/adapters/iconify'
import { defineIcon } from '#/components/icons/define-icon'

export const ReplyIcon = defineIcon(RiReplyLine, {
  pack: 'remixicon',
  name: 'RiReplyLine',
})

export const PinIcon = defineIcon(RiPushpinLine, {
  pack: 'remixicon',
  name: 'RiPushpinLine',
})

export const PinOffIcon = defineIcon(RiUnpinLine, {
  pack: 'remixicon',
  name: 'RiUnpinLine',
})

export const CopyIcon = defineIcon(RiFileCopyLine, {
  pack: 'remixicon',
  name: 'RiFileCopyLine',
})

export const LinkIcon = defineIcon(RiLink, {
  pack: 'remixicon',
  name: 'RiLink',
})

export const Link2Icon = defineIcon(RiLinksLine, {
  pack: 'remixicon',
  name: 'RiLinksLine',
})

export const SmilePlusIcon = defineIcon(RiEmotionAddLine, {
  pack: 'remixicon',
  name: 'RiEmotionAddLine',
})

export const SmileIcon = defineIcon(RiEmotionHappyLine, {
  pack: 'remixicon',
  name: 'RiEmotionHappyLine',
})

const MajesticonsChatIcon = iconifyIcon('majesticons:chat')

export const MessageCircleIcon = defineIcon(MajesticonsChatIcon, {
  pack: 'iconify',
  name: 'majesticons:chat',
})

export const MessageSquareIcon = defineIcon(MajesticonsChatIcon, {
  pack: 'iconify',
  name: 'majesticons:chat',
})

export const MoreHorizontalIcon = defineIcon(RiMoreLine, {
  pack: 'remixicon',
  name: 'RiMoreLine',
})

export const FileIcon = defineIcon(RiFileLine, {
  pack: 'remixicon',
  name: 'RiFileLine',
})

export const CheckCheckIcon = defineIcon(RiCheckDoubleLine, {
  pack: 'remixicon',
  name: 'RiCheckDoubleLine',
})
