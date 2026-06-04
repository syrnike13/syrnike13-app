import { useState } from 'react'
import { Link2Icon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog'
import { useAuth } from '#/features/auth/auth-context'
import {
  createChannelInvite,
  fetchServerInvites,
} from '#/features/api/servers-api'
import { deleteInvite } from '#/features/api/invites-api'
import { listServerChannels } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'

type ServerInviteDialogProps = {
  serverId: string
}

function inviteLink(code: string) {
  if (typeof window === 'undefined') return code
  return `${window.location.origin}/invite/${code}`
}

export function ServerInviteDialog({ serverId }: ServerInviteDialogProps) {
  const auth = useAuth()
  const token = auth.session?.token
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [codes, setCodes] = useState<string[]>([])

  const textChannels = useSyncStore((s) =>
    listServerChannels(s, serverId).filter(
      (channel) => channel.channel_type === 'TextChannel',
    ),
  )
  const defaultChannelId = textChannels[0]?._id

  async function loadInvites() {
    if (!token) return
    setLoading(true)
    try {
      const invites = await fetchServerInvites(token, serverId)
      setCodes(
        invites
          .map((invite) => ('_id' in invite ? invite._id : ''))
          .filter(Boolean),
      )
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось загрузить',
      )
    } finally {
      setLoading(false)
    }
  }

  async function createInvite() {
    if (!token || !defaultChannelId) {
      toast.error('Нет текстового канала для приглашения')
      return
    }

    setLoading(true)
    try {
      const invite = await createChannelInvite(token, defaultChannelId)
      const code = '_id' in invite ? invite._id : ''
      if (code) {
        setCodes((current) => [code, ...current])
        await navigator.clipboard.writeText(inviteLink(code))
        toast.success('Ссылка скопирована в буфер')
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось создать',
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void loadInvites()
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          title="Приглашения"
        >
          <Link2Icon className="size-4" />
          <span className="sr-only">Приглашения</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Приглашения на сервер</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Button
            type="button"
            disabled={loading || !defaultChannelId}
            onClick={() => void createInvite()}
          >
            Создать и скопировать ссылку
          </Button>
          {codes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {loading ? 'Загрузка…' : 'Приглашений пока нет'}
            </p>
          ) : (
            <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto text-sm">
              {codes.map((code) => (
                <li
                  key={code}
                  className="flex items-center gap-2 rounded-md border px-2 py-1.5"
                >
                  <code className="min-w-0 flex-1 truncate text-xs">
                    {inviteLink(code)}
                  </code>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={() => {
                      void navigator.clipboard.writeText(inviteLink(code))
                      toast.success('Скопировано')
                    }}
                  >
                    <Link2Icon className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={() => {
                      if (!token) return
                      void deleteInvite(token, code)
                        .then(() =>
                          setCodes((current) =>
                            current.filter((entry) => entry !== code),
                          ),
                        )
                        .catch((error) =>
                          toast.error(
                            error instanceof Error
                              ? error.message
                              : 'Ошибка',
                          ),
                        )
                    }}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
