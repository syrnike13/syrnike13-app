import type * as React from 'react'

import { Button } from '../button'

function IconButton({
  size = 'icon',
  ...props
}: React.ComponentProps<typeof Button>) {
  return <Button size={size} {...props} />
}

export { IconButton }
