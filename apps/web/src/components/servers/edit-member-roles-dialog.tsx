import { useEffect, useState } from 'react'
import type { Member, Server, User } from '@syrnike13/api-types'
import { SearchIcon } from '#/components/icons'
import { useTranslations } from '@syrnike13/ui/i18n'

import { MemberRolesEditor } from '#/components/servers/member-roles-editor'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'
import { Input } from '@syrnike13/ui/primitives/input'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'

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
        <DialogHeader className="gap-2.5 border-b border-border px-5 py-3.5 pr-12 text-left sm:text-left">
          <DialogTitle className="truncate text-base leading-snug">
            {t('title', { name: nickname })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('description')}
          </DialogDescription>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              placeholder={t('searchRoles')}
              aria-label={t('searchRolesAria')}
              className="h-8 pl-8 text-sm"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </DialogHeader>

        <ScrollArea className="max-h-roles-dialog px-2 py-1.5">
          <MemberRolesEditor
            server={server}
            targetMember={targetMember}
            showHeading={false}
            compact
            roleSearch={query}
            className="px-1 pb-2"
          />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
