import { useTranslations } from '@syrnike13/ui/i18n'
import { FxImage } from '#/components/ui/fx-image'
import { useAppearance } from '#/features/appearance/appearance-context'
import {
  getThemeTokens,
  type ThemeVariant,
} from '@syrnike13/ui/tokens'
import { normalizeRoleColour } from '#/lib/server-permissions'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'

type RoleColourPreviewProps = {
  name: string
  colour: string
  iconUrl?: string | null
  className?: string
}

function chatPaletteFromTheme(
  themeId: string,
  variant: ThemeVariant,
  label: string,
) {
  const tokens = getThemeTokens(
    { themeId, colorMode: variant },
    variant === 'dark',
  )
  return {
    id: variant,
    label,
    surface: tokens.background,
    text: tokens.foreground,
    muted: tokens['muted-foreground'],
  }
}

export function RoleColourPreview({
  name,
  colour,
  iconUrl,
  className,
}: RoleColourPreviewProps) {
  const t = useTranslations('servers.roles')
  const { settings } = useAppearance()
  const displayName = name.trim() || t('newRole')
  const roleColour = colour.trim() ? normalizeRoleColour(colour) : undefined

  const palettes = (['light', 'dark'] as const).map((variant) => {
    const label = variant === 'light' ? t('lightTheme') : t('darkTheme')
    return chatPaletteFromTheme(settings.themeId, variant, label)
  })

  return (
    <div className={cn('space-y-3', className)}>
      <div>
        <p className="text-sm font-medium">{t('previewTitle')}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('previewHint')}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {palettes.map((palette) => (
          <div
            key={palette.id}
            className="overflow-hidden rounded-md border border-border"
          >
            <div className="border-b border-border bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground">
              {palette.label}
            </div>
            <div
              className="space-y-2 bg-(--palette-surface) px-3 py-3 text-sm text-(--palette-text)"
              style={
                {
                  '--palette-surface': palette.surface,
                  '--palette-text': palette.text,
                  '--palette-muted': palette.muted,
                } as CSSVars
              }
            >
              <div className="flex items-center gap-2">
                {iconUrl ? (
                  <FxImage
                    src={iconUrl}
                    rounded="full"
                    wrapperClassName="size-6 shrink-0"
                    className="size-6"
                  />
                ) : (
                  <span
                    className="size-2.5 rounded-full bg-(--role-dot)"
                    style={
                      { '--role-dot': normalizeRoleColour(colour) } as CSSVars
                    }
                  />
                )}
                <span
                  className={cn(
                    'font-semibold',
                    roleColour && 'text-(--role-color)',
                  )}
                  style={
                    roleColour
                      ? ({ '--role-color': roleColour } as CSSVars)
                      : undefined
                  }
                >
                  {displayName}
                </span>
              </div>
              <p>
                <span className="font-medium">{t('member')}</span>
                <span className="text-(--palette-muted)"> — </span>
                <span
                  className={cn(roleColour && 'text-(--role-color)')}
                  style={
                    roleColour
                      ? ({ '--role-color': roleColour } as CSSVars)
                      : undefined
                  }
                >
                  @{displayName}
                </span>
                <span className="text-(--palette-muted)">
                  {t('welcome')}
                </span>
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
