import { FxImage } from '#/components/ui/fx-image'
import { useAppearance } from '#/features/appearance/appearance-context'
import {
  getThemeById,
  themeHasVariant,
  type ThemeVariant,
} from '#/features/appearance/theme-registry'
import { normalizeRoleColour, roleColourStyle } from '#/lib/server-permissions'
import { cn } from '#/lib/utils'

type RoleColourPreviewProps = {
  name: string
  colour: string
  iconUrl?: string | null
  className?: string
}

function chatPaletteFromTheme(themeId: string, variant: ThemeVariant) {
  const theme = getThemeById(themeId)
  const tokens = theme.variants[variant]
  if (!tokens) return null
  return {
    id: variant,
    label: variant === 'light' ? 'Светлая тема' : 'Тёмная тема',
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
  const { settings } = useAppearance()
  const theme = getThemeById(settings.themeId)
  const displayName = name.trim() || 'Новая роль'
  const roleStyle = roleColourStyle(colour.trim() || null)

  const palettes = (['light', 'dark'] as const).flatMap((variant) => {
    if (!themeHasVariant(theme, variant)) return []
    const palette = chatPaletteFromTheme(settings.themeId, variant)
    return palette ? [palette] : []
  })

  return (
    <div className={cn('space-y-3', className)}>
      <div>
        <p className="text-sm font-medium">Предпросмотр в чате</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Как имя роли выглядит в сообщениях в разных режимах палитры.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {palettes.map((palette) => (
          <div
            key={palette.id}
            className="overflow-hidden rounded-md border border-border"
          >
            <div className="border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground">
              {palette.label}
            </div>
            <div
              className="space-y-2 px-3 py-3 text-sm"
              style={{
                backgroundColor: palette.surface,
                color: palette.text,
              }}
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
                    className="size-2.5 rounded-full"
                    style={{ backgroundColor: normalizeRoleColour(colour) }}
                  />
                )}
                <span className="font-semibold" style={roleStyle}>
                  {displayName}
                </span>
              </div>
              <p>
                <span className="font-medium" style={{ color: palette.text }}>
                  Участник
                </span>
                <span style={{ color: palette.muted }}> — </span>
                <span style={roleStyle}>@{displayName}</span>
                <span style={{ color: palette.muted }}>
                  , добро пожаловать на сервер!
                </span>
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
