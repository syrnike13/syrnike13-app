import type { ReactNode } from 'react'
import { Loader2Icon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { SettingsDesktopPanel } from '#/components/settings/settings-desktop-panel'
import { SettingsHotkeysPanel } from '#/components/settings/settings-hotkeys-panel'
import { NotificationSettings } from '#/components/notifications/notification-settings'
import { SettingsProfilePanel } from '#/components/settings/settings-profile-panel'
import { SettingsVoicePanel } from '#/components/settings/settings-voice-panel'
import { SettingsSessionsPanel } from '#/components/settings/settings-sessions-panel'
import { ThemeToggle } from '#/components/theme-toggle'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Switch } from '#/components/ui/switch'
import type { SettingsSection } from '#/features/settings/settings-modal-context'
import { changeAccountPassword } from '#/features/api/account-api'
import { useAuth } from '#/features/auth/auth-context'
import { cn } from '#/lib/utils'

const SECTION_TITLES: Record<SettingsSection, string> = {
  profile: 'Профиль',
  account: 'Аккаунт',
  voice: 'Голос и видео',
  sessions: 'Устройства',
  notifications: 'Уведомления',
  appearance: 'Оформление',
  hotkeys: 'Горячие клавиши',
  desktop: 'Приложение',
}

export function SettingsBlock({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <section className="border-b border-border/40 py-6 last:border-b-0">
      <div className="mb-1">
        <h3 className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
          {title}
        </h3>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

export function SettingsRow({
  label,
  hint,
  value,
  children,
  stacked,
  className,
}: {
  label: string
  hint?: string
  value?: ReactNode
  children?: ReactNode
  stacked?: boolean
  className?: string
}) {
  const alignStart = !stacked && Boolean(hint)

  return (
    <div
      className={cn(
        'gap-x-6 gap-y-3 py-3',
        stacked
          ? 'flex flex-col'
          : cn(
              'flex justify-between',
              alignStart ? 'items-start' : 'min-h-16 items-center',
            ),
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-base font-medium leading-snug">{label}</p>
        {hint ? (
          <p className="mt-1 text-sm leading-snug text-muted-foreground">
            {hint}
          </p>
        ) : null}
        {value ? (
          <p className="mt-1 text-sm text-muted-foreground">{value}</p>
        ) : null}
      </div>
      {children ? (
        <div
          className={cn(
            'flex shrink-0 items-center gap-2',
            stacked ? 'w-full' : alignStart && 'pt-0.5',
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

export function SettingsToggleRow({
  label,
  hint,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string
  hint?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <SettingsRow label={label} hint={hint}>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      />
    </SettingsRow>
  )
}

export function settingsSectionTitle(section: SettingsSection) {
  return SECTION_TITLES[section]
}

export function SettingsAccountPanel() {
  const auth = useAuth()
  const user = auth.user
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')

  return (
    <div className="space-y-2">
      <SettingsBlock title="Информация об аккаунте">
        <SettingsRow label="Имя пользователя" value={`@${user?.username}`} />
        <SettingsRow
          label="Отображаемое имя"
          value={user?.display_name?.trim() || '—'}
        />
      </SettingsBlock>

      <SettingsBlock title="Пароль">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            const token = auth.session?.token
            if (!token) return
            if (newPassword.length < 8) {
              toast.error('Новый пароль: минимум 8 символов')
              return
            }
            if (!currentPassword) {
              toast.error('Введите текущий пароль')
              return
            }
            setPasswordSaving(true)
            void changeAccountPassword(token, newPassword, currentPassword)
              .then(() => {
                setCurrentPassword('')
                setNewPassword('')
                toast.success('Пароль изменён')
              })
              .catch((error) => {
                toast.error(
                  error instanceof Error
                    ? error.message
                    : 'Не удалось сменить пароль',
                )
              })
              .finally(() => setPasswordSaving(false))
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="settings-current-password">Текущий пароль</Label>
            <Input
              id="settings-current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-new-password">Новый пароль</Label>
            <Input
              id="settings-new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={passwordSaving}>
            {passwordSaving ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              'Сменить пароль'
            )}
          </Button>
        </form>
      </SettingsBlock>

      <SettingsBlock title="Система">
        <SettingsRow label="ID аккаунта" stacked>
          <code className="block w-full break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">
            {user?._id}
          </code>
        </SettingsRow>
      </SettingsBlock>
    </div>
  )
}

export function SettingsAppearancePanel() {
  return (
    <SettingsBlock title="Тема">
      <SettingsRow label="Режим отображения">
        <ThemeToggle />
      </SettingsRow>
    </SettingsBlock>
  )
}

export function SettingsNotificationsPanel() {
  return <NotificationSettings layout="settings" />
}

export function SettingsPanelContent({ section }: { section: SettingsSection }) {
  switch (section) {
    case 'profile':
      return <SettingsProfilePanel />
    case 'account':
      return <SettingsAccountPanel />
    case 'voice':
      return <SettingsVoicePanel />
    case 'sessions':
      return <SettingsSessionsPanel />
    case 'notifications':
      return <SettingsNotificationsPanel />
    case 'appearance':
      return <SettingsAppearancePanel />
    case 'hotkeys':
      return <SettingsHotkeysPanel />
    case 'desktop':
      return <SettingsDesktopPanel />
    default:
      return <SettingsAccountPanel />
  }
}
