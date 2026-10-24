import { useTranslations } from '@syrnike13/ui/i18n'

import { CheckIcon, MinusIcon, XIcon } from '#/components/icons'
import { Switch } from '@syrnike13/ui/primitives/switch'
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@syrnike13/ui/primitives/toggle-group'
import {
  PERMISSION_TRI_STATE_ORDER,
  type PermissionTriState,
} from '#/lib/server-permissions'

const STATE_KEYS: Record<PermissionTriState, string> = {
  neutral: 'permissionInherited',
  allow: 'permissionAllowed',
  deny: 'permissionDenied',
}

const STATE_ICONS: Record<PermissionTriState, typeof CheckIcon> = {
  deny: XIcon,
  neutral: MinusIcon,
  allow: CheckIcon,
}

/** Deny, inherit, allow — left to right, like Discord. */
const DISPLAY_ORDER: PermissionTriState[] = ['deny', 'neutral', 'allow']

/**
 * A permission's value. `switch`: on/off (role defaults). `tri`: deny,
 * inherit and allow side by side (channel and role overrides); states the
 * actor may not set are disabled instead of skipped.
 */
export function PermissionStateButton({
  label,
  state,
  disabled,
  allowedStates = PERMISSION_TRI_STATE_ORDER,
  mode = 'tri',
  onChange,
}: {
  label: string
  state: PermissionTriState
  disabled?: boolean
  allowedStates?: readonly PermissionTriState[]
  mode?: 'switch' | 'tri'
  onChange: (next: PermissionTriState) => void
}) {
  const t = useTranslations('servers.roles')

  if (mode === 'switch') {
    return (
      <Switch
        checked={state === 'allow'}
        disabled={
          disabled ||
          !allowedStates.includes(state === 'allow' ? 'neutral' : 'allow')
        }
        aria-label={label}
        onCheckedChange={(checked) => onChange(checked ? 'allow' : 'neutral')}
      />
    )
  }

  return (
    <ToggleGroup
      variant="outline"
      size="sm"
      aria-label={label}
      value={[state]}
      disabled={disabled}
      onValueChange={(next) => {
        const value = next[0] as PermissionTriState | undefined
        if (value && value !== state) onChange(value)
      }}
    >
      {DISPLAY_ORDER.map((option) => {
        const Icon = STATE_ICONS[option]
        const stateLabel = t(STATE_KEYS[option])
        return (
          <ToggleGroupItem
            key={option}
            value={option}
            aria-label={`${label}: ${stateLabel.toLowerCase()}`}
            title={stateLabel}
            disabled={option !== state && !allowedStates.includes(option)}
          >
            <Icon />
          </ToggleGroupItem>
        )
      })}
    </ToggleGroup>
  )
}
