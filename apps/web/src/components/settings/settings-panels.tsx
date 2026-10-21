import type { ReactNode } from 'react'
import {
  APPEARANCE_SCALE_MAX,
  APPEARANCE_SCALE_MIN,
  APPEARANCE_SCALE_STEP,
  DEFAULT_APPEARANCE_SETTINGS,
} from '@syrnike13/platform'
import {
  useLocale,
  useTranslations,
  type Translator,
} from '@syrnike13/ui/i18n'
import { useState } from 'react'
import { Effect } from 'effect'
import { toast } from 'sonner'

import { SettingsDesktopPanel } from '#/components/settings/settings-desktop-panel'
import { SettingsHotkeysPanel } from '#/components/settings/settings-hotkeys-panel'
import { SettingsOverlayPanel } from '#/components/settings/settings-overlay-panel'
import { NotificationSettings } from '#/components/notifications/notification-settings'
import { SettingsProfilePanel } from '#/components/settings/settings-profile-panel'
import { SettingsVoicePanel } from '#/components/settings/settings-voice-panel'
import { SettingsSessionsPanel } from '#/components/settings/settings-sessions-panel'
import { ColorModeSegment } from '#/components/appearance/color-mode-segment'
import { ThemePickerGrid } from '#/components/appearance/theme-picker-grid'
import { PresetSlider } from '#/components/ui/preset-slider'
import { useAppearance } from '#/features/appearance/appearance-context'
import { Button } from '@syrnike13/ui/primitives/button'
import { Input } from '@syrnike13/ui/primitives/input'
import { Label } from '@syrnike13/ui/primitives/label'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { Switch } from '@syrnike13/ui/primitives/switch'
import type { SettingsSection } from '#/features/settings/settings-modal-context'
import { changeAccountPasswordEffect } from '#/features/api/account-api'
import { useAuth } from '#/features/auth/auth-context'
import { cn } from '#/lib/utils'
import { usePlatform } from '#/platform/use-platform'
import { apiErrorMessage } from '#/lib/api/error-message'
import {
  readBrowserDiagnosticReportsEnabled,
  writeBrowserDiagnosticReportsEnabled,
} from '#/features/diagnostics/diagnostic-preferences'
import { sendDiagnosticReport } from '#/features/diagnostics/diagnostic-reporter'

const SECTION_TITLE_KEYS: Record<SettingsSection, string> = {
  profile: 'sections.profile',
  account: 'sections.account',
  voice: 'sections.voice',
  sessions: 'sections.sessions',
  notifications: 'sections.notifications',
  appearance: 'sections.appearance',
  language: 'sections.language',
  hotkeys: 'sections.hotkeys',
  overlay: 'sections.overlay',
  desktop: 'sections.desktop',
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
    <section className="border-b border-border py-6 last:border-b-0">
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

export function settingsSectionTitle(
  section: SettingsSection,
  t: Translator,
) {
  return t(SECTION_TITLE_KEYS[section])
}

export function SettingsAccountPanel() {
  const t = useTranslations('settings.account')
  const auth = useAuth()
  const { desktop } = usePlatform()
  const user = auth.user
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [diagnosticReports, setDiagnosticReports] = useState(
    readBrowserDiagnosticReportsEnabled,
  )
  const [sendingDiagnosticReport, setSendingDiagnosticReport] = useState(false)

  return (
    <div className="space-y-2">
      <SettingsBlock title={t('accountInfo')}>
        <SettingsRow label={t('username')} value={`@${user?.username}`} />
        <SettingsRow
          label={t('displayName')}
          value={user?.display_name?.trim() || '—'}
        />
      </SettingsBlock>

      <SettingsBlock title={t('password')}>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            const token = auth.session?.token
            if (!token) return
            if (newPassword.length < 8) {
              toast.error(t('passwordMin'))
              return
            }
            if (!currentPassword) {
              toast.error(t('currentPasswordRequired'))
              return
            }
            setPasswordSaving(true)
            Effect.runFork(
              changeAccountPasswordEffect(
                token,
                newPassword,
                currentPassword,
              ).pipe(
                Effect.matchEffect({
                  onFailure: (error) =>
                    Effect.sync(() => {
                      toast.error(
                        apiErrorMessage(error, t('passwordChangeError')),
                      )
                    }),
                  onSuccess: () =>
                    Effect.sync(() => {
                      setCurrentPassword('')
                      setNewPassword('')
                      toast.success(t('passwordChanged'))
                    }),
                }),
                Effect.ensuring(
                  Effect.sync(() => {
                    setPasswordSaving(false)
                  }),
                ),
              ),
            )
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="settings-current-password">
              {t('currentPassword')}
            </Label>
            <Input
              id="settings-current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-new-password">{t('newPassword')}</Label>
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
              <Spinner className="size-4" />
            ) : (
              t('changePassword')
            )}
          </Button>
        </form>
      </SettingsBlock>

      <SettingsBlock title={t('system')}>
        <SettingsRow label={t('accountId')} stacked>
          <code className="block w-full break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">
            {user?._id}
          </code>
        </SettingsRow>
      </SettingsBlock>

      {!desktop ? (
        <SettingsBlock
          title={t('privacy')}
          description={t('privacyDescription')}
        >
          <SettingsToggleRow
            label={t('autoReports')}
            hint={t('autoReportsHint')}
            checked={diagnosticReports}
            onCheckedChange={(checked) => {
              setDiagnosticReports(checked)
              if (!writeBrowserDiagnosticReportsEnabled(checked)) {
                toast.warning(t('storageDenied'))
              }
            }}
          />
          <SettingsRow
            label={t('sendReport')}
            hint={t('sendReportHint')}
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!auth.session?.token || sendingDiagnosticReport}
              onClick={() => {
                if (!auth.session?.token) return
                setSendingDiagnosticReport(true)
                Effect.runFork(
                  sendDiagnosticReport({
                    token: auth.session.token,
                    desktop: null,
                    area: 'client',
                    severity: 'warning',
                    triggerCode: 'manual_report',
                    description: 'Manual diagnostic report',
                  }).pipe(
                    Effect.matchEffect({
                      onFailure: (error) =>
                        Effect.sync(() => {
                          toast.error(
                            apiErrorMessage(error, t('reportError')),
                          )
                        }),
                      onSuccess: (report) =>
                        Effect.sync(() => {
                          if (report) {
                            toast.success(t('reportSent', { id: report.id }))
                          }
                        }),
                    }),
                    Effect.ensuring(
                      Effect.sync(() => {
                        setSendingDiagnosticReport(false)
                      }),
                    ),
                  ),
                )
              }}
            >
              {sendingDiagnosticReport ? t('sending') : t('send')}
            </Button>
          </SettingsRow>
        </SettingsBlock>
      ) : null}
    </div>
  )
}

const SCALE_MAJOR_VALUES = new Set([
  APPEARANCE_SCALE_MIN,
  DEFAULT_APPEARANCE_SETTINGS.scale,
  APPEARANCE_SCALE_MAX,
])

const SCALE_STOPS = Array.from(
  {
    length:
      Math.floor(
        (APPEARANCE_SCALE_MAX - APPEARANCE_SCALE_MIN) /
          APPEARANCE_SCALE_STEP,
      ) + 1,
  },
  (_, index) => {
    const value = APPEARANCE_SCALE_MIN + index * APPEARANCE_SCALE_STEP
    return { value, major: SCALE_MAJOR_VALUES.has(value) }
  },
)

export function SettingsAppearancePanel() {
  const t = useTranslations('settings.appearance')
  const { setColorMode, setScale, settings } = useAppearance()

  return (
    <div className="space-y-6">
      <SettingsBlock title={t('themes')}>
        <ThemePickerGrid />
      </SettingsBlock>
      <SettingsBlock title={t('displayMode')}>
        <SettingsRow
          label={t('lightDark')}
          hint={t('colorModeHint')}
        >
          <ColorModeSegment
            value={settings.colorMode}
            onChange={setColorMode}
          />
        </SettingsRow>
      </SettingsBlock>
      <SettingsBlock title={t('scale')}>
        <SettingsRow
          label={t('interfaceScale')}
          hint={t('interfaceScaleHint')}
          stacked
        >
          <PresetSlider
            stops={SCALE_STOPS}
            value={settings.scale}
            drag="release"
            onValueChange={setScale}
            formatValue={(value) => `${value}%`}
            aria-label={t('interfaceScale')}
          />
        </SettingsRow>
      </SettingsBlock>
    </div>
  )
}

export function SettingsLanguagePanel() {
  const { locale, setLocale } = useLocale()
  const t = useTranslations('settings.language')

  return (
    <div className="space-y-6">
      <SettingsBlock title={t('title')} description={t('description')}>
        <div className="flex flex-wrap gap-2">
          {(['ru', 'en'] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={locale === value ? 'default' : 'outline'}
              onClick={() => setLocale(value)}
            >
              {t(value)}
            </Button>
          ))}
        </div>
      </SettingsBlock>
    </div>
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
    case 'language':
      return <SettingsLanguagePanel />
    case 'hotkeys':
      return <SettingsHotkeysPanel />
    case 'overlay':
      return <SettingsOverlayPanel />
    case 'desktop':
      return <SettingsDesktopPanel />
    default:
      return <SettingsAccountPanel />
  }
}
