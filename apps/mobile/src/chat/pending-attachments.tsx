import { useTranslations } from '@syrnike13/ui/i18n'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { MessageAttachment } from '@syrnike13/ui-native/primitives/message'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { Image, ScrollView, View } from 'react-native'

import { FileIcon, XIcon } from '../components/icons/registry'
import type { PendingAttachment } from './use-composer-attachments'

/**
 * Files waiting to be sent, as 80dp tiles above the composer: an image
 * thumbnail or the file name, the upload percentage, and a remove button.
 */
export function PendingAttachments({
  pending,
  onRemove,
}: {
  pending: PendingAttachment[]
  onRemove: (id: string) => void
}) {
  const t = useTranslations('mobile.media')
  if (!pending.length) return null
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 pb-2">
      {pending.map((item) => (
        <MessageAttachment key={item.id} className="size-20">
          {item.previewUri ? (
            <Image source={{ uri: item.previewUri }} className="size-full" resizeMode="cover" />
          ) : (
            <View className="size-full items-center justify-center gap-1 p-2">
              <FileIcon size={24} className="text-muted-foreground" />
              <Text className="text-xs" numberOfLines={2}>
                {item.name}
              </Text>
            </View>
          )}
          {item.error || !item.attachmentId ? (
            <View className="absolute inset-0 items-center justify-center bg-background/70 p-1">
              <Text
                className={item.error ? 'text-center text-xs text-destructive' : 'text-sm font-semibold'}
                numberOfLines={3}
              >
                {item.error ?? `${Math.round(item.progress * 100)}%`}
              </Text>
            </View>
          ) : null}
          <Button
            variant="secondary"
            size="icon-sm"
            shape="circle"
            className="absolute top-1 right-1"
            accessibilityLabel={t('remove', { name: item.name })}
            onPress={() => onRemove(item.id)}
          >
            <XIcon size={14} />
          </Button>
        </MessageAttachment>
      ))}
    </ScrollView>
  )
}
