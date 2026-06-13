export function createVoiceOperationId() {
  const id =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `voice-op-${id}`
}

export function isCurrentVoiceOperation(
  currentOperationId: string | null | undefined,
  incomingOperationId: string | null | undefined,
) {
  return Boolean(
    currentOperationId &&
      incomingOperationId &&
      currentOperationId === incomingOperationId,
  )
}
