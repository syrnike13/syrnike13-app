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

import { SettingsDesktopPanel } from '#/components/settings/settings-desktop-panel'
import { SettingsHotkeysPanel } from '#/components/settings/settings-hotkeys-panel'
import { SettingsOverlayPanel } from '#/components/settings/settings-overlay-panel'
import { NotificationSettings } from '#/components/notifications/notification-settings'
import { SettingsProfilePanel } from '#/components/settings/settings-profile-panel'
import { SettingsVoicePanel } from '#/components/settings/settings-voice-panel'
import { SettingsPrivacyPanel } from '#/components/settings/settings-privacy-panel'
import { SettingsSessionsPanel } from '#/components/settings/settings-sessions-panel'
import { ColorModeSegment } from '#/components/appearance/color-mode-segment'
import { ThemePickerGrid } from '#/components/appearance/theme-picker-grid'
import { PresetSlider } from '#/components/ui/preset-slider'
import { useAppearance } from '#/features/appearance/appearance-context'
import { Button } from '@syrnike13/ui/primitives/button'
import { Input } from '@syrnike13/ui/primitives/input'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@syrnike13/ui/primitives/field'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { Switch } from '@syrnike13/ui/primitives/switch'
import type { SettingsSection } from '#/features/settings/settings-modal-context'
import { changeAccountPasswordEffect } from '#/features/api/account-api'
import { useAuth } from '#/features/auth/auth-context'
import { usePlatform } from '#/platform/use-platform'
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
  privacy: 'sections.privacy',
  notifications: 'sections.notifications',
  appearance: 'sections.appearance',
  language: 'sections.language',
  hotkeys: 'sections.hotkeys',
  overlay: 'sections.overlay',
  desktop: 'sections.desktop',
}

/**
 * A settings section: legend, optional description, then rows. Sections are
 * split by a hairline. Built on `FieldSet`, so rows line up with every form.
 */
export function SettingsBlock({
  title,
  description,
  children,
}: {
  /** Omit for a section of a single self-describing row. */
  title?: string
  description?: string
  children: ReactNode
}) {
  return (
    <FieldSet className="border-b border-border py-6 last:border-b-0">
      {title ? <FieldLegend>{title}</FieldLegend> : null}
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldGroup>{children}</FieldGroup>
    </FieldSet>
  )
}

/**
 * One setting: title, hint or current value on the left, the control on the
 * right (`stacked`: the control spans the row below).
 */
export function SettingsRow({
  label,
  hint,
  value,
  children,
  stacked,
}: {
  label: string
  hint?: string
  value?: ReactNode
  children?: ReactNode
  stacked?: boolean
}) {
  return (
    <Field orientation={stacked ? 'vertical' : 'horizontal'}>
      <FieldContent>
        <FieldTitle>{label}</FieldTitle>
        {hint ? <FieldDescription>{hint}</FieldDescription> : null}
        {value ? <FieldDescription>{value}</FieldDescription> : null}
      </FieldContent>
      {children}
    </Field>
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
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            const token = auth.session?.token
            if (!token) return
            if (newPassword.length < 8) {
              return
            }
            if (!currentPassword) {
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
                  onFailure: () =>
                    Effect.sync(() => {
                    }),
                  onSuccess: () =>
                    Effect.sync(() => {
                      setCurrentPassword('')
                      setNewPassword('')
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
          <Field>
            <FieldLabel htmlFor="settings-current-password">{t('currentPassword')}</FieldLabel>
            <Input
              id="settings-current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="settings-new-password">{t('newPassword')}</FieldLabel>
            <Input
              id="settings-new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </Field>
          <Button type="submit" className="self-start" disabled={passwordSaving}>
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
          <Input readOnly value={user?._id ?? ''} className="font-mono" />
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
                      onFailure: () =>
                        Effect.sync(() => {
                        }),
                      onSuccess: (report) =>
                        Effect.sync(() => {
                          if (report) {
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
    case 'privacy':
      return <SettingsPrivacyPanel />
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
