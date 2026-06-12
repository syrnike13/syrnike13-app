import { useEffect, useState } from 'react'
import type { User } from '@syrnike13/api-types'

import { PlusIcon } from '#/components/icons'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { FxImage } from '#/components/ui/fx-image'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { UserAvatar } from '#/components/user/user-avatar'
import { UserProfileStatusBubble } from '#/components/user/user-profile-status-bubble'
import { userProfileBannerClassName } from '#/lib/user-profile-banner'
import { cn } from '#/lib/utils'

const STATUS_MAX_LENGTH = 128

type SettingsProfileStatusDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  statusText: string
  onApply: (statusText: string) => void
  user: User
  displayName: string
  username: string
  avatarUrl: string | null
  bannerUrl: string | null
}

export function SettingsProfileStatusDialog({
  open,
  onOpenChange,
  statusText,
  onApply,
  user,
  displayName,
  username,
  avatarUrl,
  bannerUrl,
}: SettingsProfileStatusDialogProps) {
  const [draft, setDraft] = useState('')
  const [baseline, setBaseline] = useState('')
  const [dirty, setDirty] = useState(false)
  const [cleared, setCleared] = useState(false)

  useEffect(() => {
    if (!open) return

    setBaseline(statusText.trim() || user.status?.text?.trim() || '')
    setDraft('')
    setDirty(false)
    setCleared(false)
  }, [open, statusText, user.status?.text])

  function handleReset() {
    setDraft('')
    setCleared(true)
    setDirty(true)
  }

  function handleApply() {
    if (!dirty) {
      onOpenChange(false)
      return
    }

    onApply(cleared ? '' : draft.trim())
    onOpenChange(false)
  }

  const previewStatus = cleared ? '' : draft.trim() || baseline
  const canReset = Boolean(baseline || draft)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Кастомный статус</DialogTitle>
          <DialogDescription>
            Короткая фраза рядом с аватаром — её увидят другие пользователи.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Предпросмотр
          </p>
          <ProfileStatusLivePreview
            user={user}
            displayName={displayName}
            username={username}
            statusText={previewStatus}
            avatarUrl={avatarUrl}
            bannerUrl={bannerUrl}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="profile-status-edit">Текст статуса</Label>
          <Input
            id="profile-status-edit"
            value={draft}
            maxLength={STATUS_MAX_LENGTH}
            onChange={(event) => {
              setDraft(event.target.value)
              setCleared(false)
              setDirty(true)
            }}
            placeholder="Чем заняты?"
            autoFocus
          />
          <p className="text-right text-xs text-muted-foreground">
            {draft.length}/{STATUS_MAX_LENGTH}
          </p>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            disabled={!canReset}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive disabled:text-muted-foreground"
            onClick={handleReset}
          >
            Сбросить
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="button" onClick={handleApply}>
              Готово
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ProfileStatusLivePreview({
  user,
  displayName,
  username,
  statusText,
  avatarUrl,
  bannerUrl,
}: {
  user: User
  displayName: string
  username: string
  statusText: string
  avatarUrl: string | null
  bannerUrl: string | null
}) {
  return (
    <div className="overflow-visible rounded-xl border border-border bg-card shadow-sm">
      <div className="relative overflow-visible">
        <div
          className={userProfileBannerClassName(
            'overflow-hidden rounded-t-xl',
            !bannerUrl &&
              'bg-gradient-to-br from-primary/30 via-chart-4/20 to-sidebar-primary/40',
          )}
        >
          {bannerUrl ? (
            <FxImage
              src={bannerUrl}
              wrapperClassName="block h-full w-full"
              className="h-full w-full"
            />
          ) : null}
        </div>
        <div className="absolute -bottom-8 left-4 z-10">
          {statusText ? (
            <UserProfileStatusBubble
              status={statusText}
              className="left-full top-[46%] ml-2.5"
            />
          ) : null}
          <UserAvatar
            user={avatarUrl ? user : { ...user, avatar: null }}
            imageSrc={avatarUrl}
            className="size-20"
            fallbackClassName="size-20 bg-card text-xl ring-[5px] ring-card"
            animated="always"
            showPresence
            presenceRingClassName="border-card"
          />
        </div>
      </div>
      <div className="px-4 pt-14 pb-3">
        <p className="truncate text-2xl font-bold leading-tight">{displayName}</p>
        <p className="truncate text-sm text-muted-foreground">@{username}</p>
      </div>
    </div>
  )
}

export function ProfileStatusBubbleTrigger({
  status,
  onClick,
  className,
}: {
  status: string
  onClick: () => void
  className?: string
}) {
  const text = status.trim()

  return (
    <button
      type="button"
      title={text ? 'Изменить статус' : 'Добавить статус'}
      aria-label={text ? 'Изменить статус' : 'Добавить статус'}
      onClick={onClick}
      className={cn(
        'group/status-trigger absolute z-20 cursor-pointer rounded-2xl outline-none transition-[filter] hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {text ? (
        <UserProfileStatusBubble status={text} className="static" />
      ) : (
        <ProfileStatusEmptyBubble />
      )}
    </button>
  )
}

function ProfileStatusEmptyBubble() {
  return (
    <div className="relative">
      <span
        aria-hidden
        className="absolute -top-3.5 -left-0.5 size-2.5 rounded-full bg-popover shadow-sm transition-colors group-hover/status-trigger:bg-muted"
      />
      <span
        aria-hidden
        className="absolute -top-1.5 left-1.5 size-5 rounded-full bg-popover shadow-sm transition-colors group-hover/status-trigger:bg-muted"
      />
      <div className="relative flex w-max items-center gap-1.5 rounded-2xl bg-popover px-3 py-1.5 text-sm text-muted-foreground shadow-md transition-colors group-hover/status-trigger:bg-muted group-hover/status-trigger:text-foreground">
        <PlusIcon
          className="size-3.5 shrink-0 opacity-70 group-hover/status-trigger:opacity-100"
          aria-hidden
        />
        <span>Добавить статус</span>
      </div>
    </div>
  )
}
