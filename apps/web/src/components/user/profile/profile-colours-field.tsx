import type { ProfileColours } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { useRef } from 'react'

import { PencilIcon } from '#/components/icons'
import { Button } from '@syrnike13/ui/primitives/button'
import { Label } from '@syrnike13/ui/primitives/label'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'

/** Default theme when the user picks the first colour: Discord blurple. */
const DEFAULT_COLOUR = '#5865f2'

function ColourSwatch({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string
  value: string | null
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div className="flex flex-col items-center gap-1">
      {/* eslint-disable-next-line design/no-lookalike -- colour swatch */}
      <button
        type="button"
        disabled={disabled}
        title={label}
        aria-label={label}
        className={cn(
          'relative m-0 box-border size-14 shrink-0 appearance-none overflow-hidden rounded-lg border-2 border-transparent p-0',
          value ? 'bg-(--swatch-color)' : 'bg-role-default',
          disabled && 'cursor-not-allowed opacity-50',
        )}
        style={value ? ({ '--swatch-color': value } as CSSVars) : undefined}
        onClick={() => inputRef.current?.click()}
      >
        <span className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-sm bg-scrim text-on-scrim">
          <PencilIcon className="size-3" />
        </span>
        {/* eslint-disable-next-line design/no-lookalike -- native colour input behind the swatch */}
        <input
          ref={inputRef}
          type="color"
          className="sr-only"
          disabled={disabled}
          value={value ?? DEFAULT_COLOUR}
          onChange={(event) => onChange(event.target.value)}
        />
      </button>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

/** Profile theme: a primary and an accent colour, or none. */
export function ProfileColoursField({
  value,
  onChange,
  disabled,
}: {
  value: ProfileColours | null
  onChange: (value: ProfileColours | null) => void
  disabled?: boolean
}) {
  const t = useTranslations('settings.profile')

  return (
    <div className="flex flex-col gap-2">
      <Label>{t('colours')}</Label>
      <div className="flex items-end gap-4">
        <ColourSwatch
          label={t('primaryColour')}
          value={value?.primary ?? null}
          disabled={disabled}
          onChange={(primary) =>
            onChange({ primary, accent: value?.accent ?? primary })
          }
        />
        <ColourSwatch
          label={t('accentColour')}
          value={value?.accent ?? null}
          disabled={disabled}
          onChange={(accent) =>
            onChange({ primary: value?.primary ?? accent, accent })
          }
        />
        {value ? (
          <Button
            type="button"
            variant="link"
            size="inline"
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            {t('resetColours')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
