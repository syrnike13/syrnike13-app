import { useState } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'

import { EyeIcon, EyeOffIcon } from '#/components/icons'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@syrnike13/ui/primitives/input-group'

type PasswordInputProps = Omit<
  React.ComponentProps<typeof InputGroupInput>,
  'type'
>

/** Password field with a show/hide toggle at the end. */
export function PasswordInput({ disabled, ...props }: PasswordInputProps) {
  const [visible, setVisible] = useState(false)
  const t = useTranslations('auth')

  return (
    <InputGroup>
      <InputGroupInput
        type={visible ? 'text' : 'password'}
        disabled={disabled}
        {...props}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          aria-label={visible ? t('password.hide') : t('password.show')}
          aria-pressed={visible}
          disabled={disabled}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}
