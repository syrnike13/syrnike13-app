// design-allow-file icon-import: literal shadcn Base UI components resolve their icons through this adapter
import type { ComponentProps } from 'react'
import {
  RiArrowDownLine,
  RiArrowDownSLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiArrowUpSLine,
  RiCheckboxCircleLine,
  RiCheckLine,
  RiCloseCircleLine,
  RiCloseLine,
  RiErrorWarningLine,
  RiFileCopyLine,
  RiInformationLine,
  RiLoaderLine,
  RiMoreLine,
  RiSearchLine,
  RiSideBarLine,
  RiSubtractLine,
} from '@remixicon/react'

const ICONS = {
  RiArrowDownLine,
  RiArrowDownSLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiArrowUpSLine,
  RiCheckboxCircleLine,
  RiCheckLine,
  RiCloseCircleLine,
  RiCloseLine,
  RiErrorWarningLine,
  RiFileCopyLine,
  RiInformationLine,
  RiLoaderLine,
  RiMoreLine,
  RiSearchLine,
  RiSideBarLine,
  RiSubtractLine,
}

export type IconPlaceholderProps = Omit<
  ComponentProps<'svg'>,
  'children'
> & {
  lucide?: string
  tabler?: string
  hugeicons?: string
  phosphor?: string
  remixicon?: string
}

/**
 * Resolves the icon placeholders emitted by the shadcn `base-nova` registry to
 * the Remix Icon set used by the rest of the design system.
 */
export function IconPlaceholder({
  remixicon,
  lucide: _lucide,
  tabler: _tabler,
  hugeicons: _hugeicons,
  phosphor: _phosphor,
  ...props
}: IconPlaceholderProps) {
  const Icon = remixicon
    ? ICONS[remixicon as keyof typeof ICONS]
    : undefined
  return Icon ? <Icon {...props} /> : null
}
