import { useEffect, useState } from 'react'
import type { Member, Server, User } from '@syrnike13/api-types'
import { SearchIcon } from 'lucide-react'

import { MemberRolesEditor } from '#/components/servers/member-roles-editor'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { ScrollArea } from '#/components/ui/scroll-area'

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
  const nickname = targetUser.display_name ?? targetUser.username
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid w-full max-w-md gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="gap-2.5 border-b border-border px-5 py-3.5 pr-12 text-left sm:text-left">
          <DialogTitle className="truncate text-base leading-snug">
            Роли «{nickname}»
          </DialogTitle>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              placeholder="Поиск ролей"
              aria-label="Поиск ролей"
              className="h-8 border-0 bg-muted/50 pl-8 text-sm shadow-none focus-visible:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring/40"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </DialogHeader>

        <ScrollArea className="max-h-[min(16rem,calc(90vh-10rem))] px-2 py-1.5">
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
