import { EyeIcon, EyeOffIcon } from '#/components/icons'
import { Input } from '#/components/ui/input'
import { cn } from '#/lib/utils'
import { useState } from 'react'

type PasswordInputProps = Omit<
  React.ComponentProps<typeof Input>,
  'type'
>

export function PasswordInput({
  className,
  disabled,
  ...props
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="relative">
      <Input
        type={visible ? 'text' : 'password'}
        className={cn('auth-input pr-12', className)}
        disabled={disabled}
        {...props}
      />
      <button
        type="button"
        className="auth-password-toggle"
        aria-label={visible ? 'Скрыть пароль' : 'Показать пароль'}
        aria-pressed={visible}
        disabled={disabled}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? (
          <EyeOffIcon aria-hidden="true" />
        ) : (
          <EyeIcon aria-hidden="true" />
        )}
      </button>
    </div>
  )
}
