import { useEffect } from 'react'

/** Опт-аут: элемент с этим атрибутом сохраняет нативное меню браузера. */
export const NATIVE_CONTEXT_MENU_ATTRIBUTE = 'data-native-context-menu'

/**
 * Подавляет системное контекстное меню браузера, чтобы открывались только
 * меню приложения. Правый клик по элементу с `data-native-context-menu`
 * оставляет нативное меню — это нужно для отладки и будущих встраиваемых
 * поверхностей вроде редакторов с проверкой орфографии.
 */
export function useNativeContextMenuGuard(
  targetDocument: Document | null = typeof document === 'undefined'
    ? null
    : document,
) {
  useEffect(() => {
    if (!targetDocument) return

    function onContextMenu(event: MouseEvent) {
      const target = event.target
      if (
        target instanceof Element &&
        target.closest(`[${NATIVE_CONTEXT_MENU_ATTRIBUTE}]`)
      ) {
        return
      }
      event.preventDefault()
    }

    targetDocument.addEventListener('contextmenu', onContextMenu)
    return () =>
      targetDocument.removeEventListener('contextmenu', onContextMenu)
  }, [targetDocument])
}

export function NativeContextMenuGuard() {
  useNativeContextMenuGuard()
  return null
}
