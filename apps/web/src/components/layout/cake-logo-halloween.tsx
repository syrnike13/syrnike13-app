import type { CSSProperties, ReactElement } from 'react'

import {
  HALLOWEEN_SPRITES,
  type PixelSprite,
} from './cake-logo-halloween-data'

function Sprite({
  sprite,
  x,
  y,
  className,
  style,
}: {
  sprite: PixelSprite
  x: number
  y: number
  className?: string
  style?: CSSProperties
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

  return (
    <g className={className} style={style}>
      {cells}
    </g>
  )
}

/**
 * Halloween set dressing: a corner web, the spider that walks down it and a
 * bat crossing the stage. The logo itself stays whole and untouched.
 */
export function HalloweenDecor() {
  return (
    <g className="cake-halloween-decor" aria-hidden="true">
      <Sprite
        sprite={HALLOWEEN_SPRITES.cobweb}
        x={-11}
        y={-3}
        className="cake-cobweb"
      />
      <rect
        className="cake-spider-thread"
        x={-8}
        y={-3}
        width={1}
        height={12}
      />
      <Sprite
        sprite={HALLOWEEN_SPRITES.spider}
        x={-10}
        y={1}
        className="cake-spider"
      />
      <Sprite
        sprite={HALLOWEEN_SPRITES.bat}
        x={22}
        y={-3}
        className="cake-bat"
      />
    </g>
  )
}
