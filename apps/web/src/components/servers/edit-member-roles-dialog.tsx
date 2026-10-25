import { useEffect, useState } from 'react'
import { SearchInput } from '#/components/ui/search-input'
import type { Member, Server, User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'

import { MemberRolesEditor } from '#/components/servers/member-roles-editor'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { Separator } from '@syrnike13/ui/primitives/separator'

type EditMemberRolesDialogProps = {
  server: Server
  targetMember: Member
  targetUser: User
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function EditMemberRolesDialog({
  server,
  targetMember,
  targetUser,
  open,
  onOpenChange,
}: EditMemberRolesDialogProps) {
  const t = useTranslations('servers.editMemberRoles')
  const nickname =
    targetMember.nickname?.trim() ||
    targetUser.display_name ||
    targetUser.username
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid w-full max-w-md gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="gap-2.5 px-5 py-3.5 pr-12 text-left sm:text-left">
          <DialogTitle className="truncate">
            {t('title', { name: nickname })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('description')}
          </DialogDescription>
          <SearchInput
            value={query}
            placeholder={t('searchRoles')}
            aria-label={t('searchRolesAria')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </DialogHeader>
        <Separator />

        <ScrollArea className="max-h-roles-dialog">
          <MemberRolesEditor
            server={server}
            targetMember={targetMember}
            showHeading={false}
            compact
            roleSearch={query}
            className="px-3 pt-1.5 pb-3.5"
          />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
