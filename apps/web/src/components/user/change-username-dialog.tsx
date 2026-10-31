import { useTranslations } from '@syrnike13/ui/i18n'
import { Effect } from 'effect'
import { useState } from 'react'

import { changeUsernameEffect } from '@syrnike13/client/api/users-api'
import { useAuth } from '#/features/auth/auth-context'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'
import { Field, FieldError, FieldLabel } from '@syrnike13/ui/primitives/field'
import { Input } from '@syrnike13/ui/primitives/input'
import { Spinner } from '@syrnike13/ui/primitives/spinner'

/**
 * Change the unique username. `reset` explains that the name was changed by
 * the unique username migration; saving any name, even the same, clears it.
 */
export function ChangeUsernameDialog({
  open,
  onOpenChange,
  reset = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  reset?: boolean
}) {
  const t = useTranslations('users.changeUsername')
  const auth = useAuth()
  const user = auth.user
  const [username, setUsername] = useState(user?.username ?? '')
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  function save() {
    const token = auth.session?.token
    if (!token || !username.trim() || !password) return
    setSaving(true)
    setFailed(false)
    void Effect.runPromise(
      changeUsernameEffect(token, username.trim(), password).pipe(
        Effect.andThen(auth.refreshUser()),
        Effect.tap(() => Effect.sync(() => onOpenChange(false))),
        Effect.catch(() => Effect.sync(() => setFailed(true))),
        Effect.ensuring(Effect.sync(() => setSaving(false))),
      ),
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setUsername(user?.username ?? '')
          setPassword('')
          setFailed(false)
        }
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{reset ? t('resetTitle') : t('title')}</DialogTitle>
          <DialogDescription>
            {reset
              ? t('resetDescription', { username: user?.username ?? '' })
              : t('description')}
          </DialogDescription>
        </DialogHeader>
        <form
          id="change-username-form"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <Field>
            <FieldLabel htmlFor="change-username">{t('username')}</FieldLabel>
            <Input
              id="change-username"
              value={username}
              minLength={2}
              maxLength={32}
              autoComplete="username"
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="change-username-password">
              {t('password')}
            </FieldLabel>
            <Input
              id="change-username-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {failed ? <FieldError>{t('failed')}</FieldError> : null}
          </Field>
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            {reset ? t('later') : t('cancel')}
          </Button>
          <Button
            type="submit"
            form="change-username-form"
            disabled={saving || !username.trim() || !password}
          >
            {saving ? <Spinner className="size-4" /> : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const RESET_PROMPT_DISMISSED_KEY = 'username-reset-prompt-dismissed'

function readPromptDismissed() {
  try {
    return sessionStorage.getItem(RESET_PROMPT_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Asks users renamed by the unique username migration to pick a name, once
 * per session, until they do.
 */
export function UsernameResetPrompt() {
  const auth = useAuth()
  const flags = auth.user?.flags ?? 0
  // UserFlags.UsernameReset
  const needsUsername = (flags & 16) !== 0
  const [dismissed, setDismissed] = useState(readPromptDismissed)

  if (!needsUsername) return null

  return (
    <ChangeUsernameDialog
      reset
      open={!dismissed}
      onOpenChange={(open) => {
        if (open) return
        setDismissed(true)
        try {
          sessionStorage.setItem(RESET_PROMPT_DISMISSED_KEY, '1')
        } catch {
          // The prompt simply shows again next session.
        }
      }}
    />
  )
}
