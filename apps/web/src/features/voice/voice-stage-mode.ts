export type VoiceStageLayoutMode = 'grid' | 'focus'

export function resolveStageLayoutMode({
  requestedMode,
  focusedMediaId,
  visibleMediaIds,
}: {
  requestedMode: VoiceStageLayoutMode
  focusedMediaId: string | null
  visibleMediaIds: readonly string[]
}): VoiceStageLayoutMode {
  if (requestedMode === 'grid') return 'grid'

  return focusedMediaId && visibleMediaIds.includes(focusedMediaId)
    ? 'focus'
    : 'grid'
}

export function nextStageLayoutModeForMediaClick(
  {
    clickedMediaId,
    currentMode,
    focusedMediaId,
  }: {
    clickedMediaId: string
    currentMode: VoiceStageLayoutMode
    focusedMediaId: string | null
  },
): { mode: VoiceStageLayoutMode; focusedMediaId: string | null } {
  if (currentMode === 'focus' && focusedMediaId === clickedMediaId) {
    return {
      mode: 'grid',
      focusedMediaId: null,
    }
  }

  return {
    mode: 'focus',
    focusedMediaId: clickedMediaId,
  }
}
