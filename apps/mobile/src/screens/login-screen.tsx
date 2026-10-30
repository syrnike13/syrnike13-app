import { useTranslations } from '@syrnike13/ui/i18n'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Input } from '@syrnike13/ui-native/primitives/input'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { useState } from 'react'
import { KeyboardAvoidingView } from 'react-native'

import { login, type Session } from '../auth/session'

export function LoginScreen({ onLogin }: { onLogin: (session: Session) => void }) {
  const t = useTranslations('mobile.login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit() {
    setPending(true)
    setError(null)
    try {
      const result = await login(email.trim(), password)
      if (result.type === 'success') onLogin(result.session)
      else setError(t(result.type === 'mfa' ? 'mfaUnsupported' : 'disabled'))
    } catch {
      setError(t('failed'))
    } finally {
      setPending(false)
    }
  }

  return (
    // Edge-to-edge windows do not resize for the keyboard, so pad the form up.
    <KeyboardAvoidingView behavior="padding" className="flex-1 justify-center gap-3 px-4">
      <Text className="mb-2 text-2xl font-semibold">{t('title')}</Text>
      <Input
        value={email}
        onChangeText={setEmail}
        placeholder={t('email')}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
      />
      <Input
        value={password}
        onChangeText={setPassword}
        placeholder={t('password')}
        autoComplete="current-password"
        secureTextEntry
      />
      {error ? <Text className="text-destructive">{error}</Text> : null}
      <Button size="lg" disabled={pending || !email || !password} onPress={submit}>
        <Text>{t('submit')}</Text>
      </Button>
    </KeyboardAvoidingView>
  )
}
