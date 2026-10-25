import type { CSSProperties, ReactElement } from 'react'

/**
 * Pixel artwork on the logo's unit grid: each character of a row is one cell,
 * `.` (or any character missing from the palette) is transparent. Colours are
 * fixed artwork values, like the sampled brand pixels, not theme tokens.
 */
export type PixelSprite = {
  readonly rows: readonly string[]
  readonly palette: Readonly<Record<string, string>>
}

export type SceneStyle = CSSProperties & Record<`--${string}`, string>

export function Sprite({
  sprite,
  x,
  y,
  className,
}: {
  sprite: PixelSprite
  x: number
  y: number
  className?: string
}) {
  const cells: ReactElement[] = []

  sprite.rows.forEach((row, rowIndex) => {
    for (let column = 0; column < row.length; column += 1) {
      const fill = sprite.palette[row[column] ?? '']
      if (!fill) continue

      cells.push(
        <rect
          key={`${column}:${rowIndex}`}
          x={x + column}
          y={y + rowIndex}
          width={1}
          height={1}
          fill={fill}
        />,
      )
    }
  })

  return <g className={className}>{cells}</g>
}
