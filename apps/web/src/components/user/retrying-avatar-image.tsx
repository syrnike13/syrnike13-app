import type { ComponentProps } from 'react'
import { AvatarImage } from '@syrnike13/ui/primitives/avatar'

import { useImageRetry } from '#/hooks/use-image-retry'

type RetryingAvatarImageProps = ComponentProps<typeof AvatarImage>

/**
 * `AvatarImage` из `@syrnike13/ui` запрашивает картинку один раз: после ошибки
 * загрузки он не перезапрашивает тот же URL, и долгоживущие аватары (тайлы
 * войса, строки участников) остаются на инициалах до ремаунта. Здесь к
 * примитиву добавляются повторные попытки: новое значение `attempt`
 * перемонтирует его через `key` и создаёт свежий запрос.
 */
export function RetryingAvatarImage({
  onLoadingStatusChange,
  ...props
}: RetryingAvatarImageProps) {
  const retry = useImageRetry(props.src)

  return (
    <AvatarImage
      key={retry.attempt}
      onLoadingStatusChange={(status) => {
        onLoadingStatusChange?.(status)
        if (status === 'error') retry.onError()
      }}
      {...props}
    />
  )
}
