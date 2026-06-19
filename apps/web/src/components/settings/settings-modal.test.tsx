// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SettingsModal } from '#/components/settings/settings-modal'
import {
  SettingsModalProvider,
  useSettingsModal,
} from '#/features/settings/settings-modal-context'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@tanstack/react-router')>()

  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useRouterState: ({
      select,
    }: {
      select: (state: { location: { pathname: string } }) => string
    }) => select({ location: { pathname: '/app' } }),
  }
})

vi.mock('#/components/settings/settings-panels', () => {
  const titles = {
    profile: 'Профиль',
    account: 'Аккаунт',
    voice: 'Голос и видео',
    sessions: 'Устройства',
    notifications: 'Уведомления',
    appearance: 'Оформление',
    hotkeys: 'Горячие клавиши',
    overlay: 'Оверлей',
    desktop: 'Приложение',
  } as const

  return {
    SettingsPanelContent: ({ section }: { section: keyof typeof titles }) => (
      <div data-testid="settings-panel">{section}</div>
    ),
    settingsSectionTitle: (section: keyof typeof titles) => titles[section],
  }
})

vi.mock('#/components/settings/profile-draft-context', () => ({
  ProfileDraftProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}))

vi.mock('#/components/settings/profile-unsaved-changes-bar', () => ({
  ProfileUnsavedChangesBar: () => null,
}))

vi.mock('#/components/settings/settings-mobile-modal', () => ({
  SettingsMobileModal: () => null,
}))

vi.mock('#/components/user/user-avatar', () => ({
  UserAvatar: () => <span data-testid="user-avatar" />,
}))

vi.mock('#/features/auth/auth-context', () => ({
  useAuth: () => ({
    user: { _id: 'user-1', username: 'tiredisa' },
    logout: vi.fn(),
  }),
}))

vi.mock('#/platform/use-platform', () => ({
  usePlatform: () => ({ isDesktop: true }),
}))

vi.mock('#/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) =>
    open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
}))

function OpenSettingsHarness() {
  const { openSettings } = useSettingsModal()

  useEffect(() => {
    openSettings('account')
  }, [openSettings])

  return <SettingsModal />
}

function renderSettingsModal() {
  render(
    <SettingsModalProvider>
      <OpenSettingsHarness />
    </SettingsModalProvider>,
  )
}

describe('SettingsModal', () => {
  afterEach(() => {
    cleanup()
  })

  it('filters desktop settings navigation from the search field', () => {
    renderSettingsModal()

    const search = screen.getByRole('textbox', { name: 'Поиск настроек' })

    fireEvent.change(search, { target: { value: 'голос' } })

    expect(
      screen.getByRole('button', { name: 'Голос и видео' }),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Аккаунт' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Голос и видео' }))

    expect(
      screen.getByRole('heading', { name: 'Голос и видео' }),
    ).toBeTruthy()
  })
})
