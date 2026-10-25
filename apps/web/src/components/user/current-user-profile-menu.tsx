import { useTranslations } from '@syrnike13/ui/i18n'
import { ChevronDownIcon, CopyIcon, PencilFillIcon, SettingsIcon } from '#/components/icons'
import { Effect } from 'effect'
import { useState } from 'react'
import { writeClipboardTextEffect } from '#/lib/clipboard'
import { useNavigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import type { User } from '@syrnike13/api-types'

import { Button } from '@syrnike13/ui/primitives/button'
import {
  Item,
  ItemContent,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from '@syrnike13/ui/primitives/item'
import { CurrentUserStatusDialog } from '#/components/user/current-user-status-dialog'
import {
  ProfileBody,
  ProfileHeader,
  ProfileName,
  ProfileSurface,
} from '#/components/user/profile/profile-parts'
import { PresenceStatusSelect } from '#/components/user/presence-status-select'
import { useUserProfileData } from '#/components/user/use-user-profile-data'
import { canAccessAdmin } from '#/features/authorization/authorization'
import { useSettingsModal } from '#/features/settings/settings-modal-context'

type CurrentUserProfileMenuProps = {
  user: User
  onClose?: () => void
  onOpenGlobalProfile?: () => void
  /** По тапу на аватар (например, drawer статуса на мобильной странице профиля). */
  onAvatarPress?: () => void
  /** Скрыть строку выбора presence в меню (если статус открывается с аватара). */
  hidePresenceRow?: boolean
  /** Кнопки поверх баннера (например, закрыть на мобильной странице профиля). */
  bannerOverlay?: ReactNode
}

/** Поповер панели пользователя — отдельная вёрстка, не общая карточка чужого профиля. */
export function CurrentUserProfileMenu({
  user,
  onClose,
  onOpenGlobalProfile,
  onAvatarPress,
  hidePresenceRow = false,
  bannerOverlay,
}: CurrentUserProfileMenuProps) {
  const t = useTranslations('users')
  const navigate = useNavigate()
  const { openSettings } = useSettingsModal()
  const displayName = user.display_name ?? user.username
  const [statusDialogOpen, setStatusDialogOpen] = useState(false)

  async function copyUserId() {
    try {
      await Effect.runPromise(writeClipboardTextEffect(user._id))
    } catch {
    }
  }

  const { bio } = useUserProfileData(user._id)

  return (
    <ProfileSurface surface="popover">
      <ProfileHeader
        user={user}
        actions={bannerOverlay}
        onStatusClick={() => setStatusDialogOpen(true)}
        avatarLabel={onAvatarPress ? t('selectStatus') : t('openProfile')}
        onAvatarClick={onAvatarPress ?? onOpenGlobalProfile}
      />

      <ProfileBody>
        <ProfileName
          user={user}
          nameSlot={
            onAvatarPress ? (
              <Button
                type="button"
                variant="plain"
                size="inline"
                title={t('selectStatus')}
                aria-label={t('selectStatus')}
                className="group/name max-w-full min-w-0 gap-0.5"
                onClick={onAvatarPress}
              >
                <span className="truncate text-xl leading-6 font-semibold text-foreground">
                  {displayName}
                </span>
                <ChevronDownIcon
                  aria-hidden
                  className="size-4 shrink-0 text-muted-foreground group-hover/name:text-foreground"
                />
              </Button>
            ) : undefined
          }
        />
        {bio ? (
          <p className="line-clamp-2 text-sm leading-4.5 text-muted-foreground">
            {bio}
          </p>
        ) : null}

        {hidePresenceRow ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => openSettings('profile')}
          >
            <PencilFillIcon />
            {t('editProfile')}
          </Button>
        ) : (
          <>
            <ProfileMenuCard>
              <ProfileMenuRow
                icon={<PencilFillIcon />}
                label={t('editProfile')}
                onClick={() => {
                  onClose?.()
                  openSettings('profile')
                }}
              />
              <ItemSeparator className="my-0" />
              <PresenceStatusSelect />
              {canAccessAdmin() ? (
                <>
                  <ItemSeparator className="my-0" />
                  <ProfileMenuRow
                    icon={<SettingsIcon />}
                    label={t('admin')}
                    onClick={() => {
                      onClose?.()
                      void navigate({ to: '/admin' })
                    }}
                  />
                </>
              ) : null}
            </ProfileMenuCard>
            <ProfileMenuCard>
              <ProfileMenuRow
                icon={<CopyIcon />}
                label={t('copyUserId')}
                onClick={() => void copyUserId()}
              />
            </ProfileMenuCard>
          </>
        )}
      </ProfileBody>
      <CurrentUserStatusDialog
        open={statusDialogOpen}
        onOpenChange={setStatusDialogOpen}
      />
    </ProfileSurface>
  )
}

/** Discord self-popout menu block: a card of rows split by hairlines. */
function ProfileMenuCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col rounded-lg bg-secondary p-1">{children}</div>
  )
}

function ProfileMenuRow({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <Item size="sm" render={<button type="button" />} onClick={onClick}>
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
      </ItemContent>
    </Item>
  )
}
