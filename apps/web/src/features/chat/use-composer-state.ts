import { useEffect, useLayoutEffect, useReducer, useRef } from 'react'
import { Effect, Fiber } from 'effect'

import {
  readComposerDraft,
  writeComposerDraft,
} from '#/features/chat/composer-draft-store'

type ComposerState = {
  scope: string
  composeValue: string
  editMessageId: string | null
  editValue: string
}

type ComposerStateAction =
  | { type: 'scope'; scope: string; value: string }
  | { type: 'edit'; messageId: string | null; value?: string }
  | { type: 'value'; value: string }
  | { type: 'clear-compose' }

export function composerStateReducer(
  state: ComposerState,
  action: ComposerStateAction,
): ComposerState {
  switch (action.type) {
    case 'scope':
      return {
        scope: action.scope,
        composeValue: action.value,
        editMessageId: null,
        editValue: '',
      }
    case 'edit':
      return {
        ...state,
        editMessageId: action.messageId,
        editValue: action.messageId ? (action.value ?? '') : '',
      }
    case 'value':
      return state.editMessageId
        ? { ...state, editValue: action.value }
        : { ...state, composeValue: action.value }
    case 'clear-compose':
      return { ...state, composeValue: '' }
  }
}

type UseComposerStateOptions = {
  userId?: string
  channelId?: string
  editingMessage?: { _id: string; content?: string | null } | null
}

export function useComposerState({
  userId,
  channelId,
  editingMessage,
}: UseComposerStateOptions) {
  const scope = userId && channelId ? `${userId}:${channelId}` : ''
  const [state, dispatch] = useReducer(composerStateReducer, undefined, () => ({
    scope,
    composeValue:
      userId && channelId ? readComposerDraft(userId, channelId) : '',
    editMessageId: editingMessage?._id ?? null,
    editValue: editingMessage?.content ?? '',
  }))
  const stateRef = useRef(state)
  stateRef.current = state

  function persistScopedDraft(current: ComposerState) {
    if (!current.scope) return
    const separator = current.scope.indexOf(':')
    if (separator < 1) return
    writeComposerDraft(
      current.scope.slice(0, separator),
      current.scope.slice(separator + 1),
      current.composeValue,
    )
  }

  useLayoutEffect(() => {
    if (state.scope === scope) return
    persistScopedDraft(state)
    dispatch({
      type: 'scope',
      scope,
      value: userId && channelId ? readComposerDraft(userId, channelId) : '',
    })
  }, [channelId, scope, state.scope, userId])

  useEffect(() => {
    if (state.editMessageId || !state.scope) return
    const fiber = Effect.runFork(
      Effect.sleep(250).pipe(
        Effect.andThen(Effect.sync(() => persistScopedDraft(state))),
      ),
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [state.composeValue, state.editMessageId, state.scope])

  useEffect(() => () => persistScopedDraft(stateRef.current), [])

  useLayoutEffect(() => {
    const messageId = editingMessage?._id ?? null
    if (state.editMessageId === messageId) return
    dispatch({
      type: 'edit',
      messageId,
      value: editingMessage?.content ?? '',
    })
  }, [editingMessage?._id, editingMessage?.content, state.editMessageId])

  const editing = state.editMessageId != null
  const value = editing ? state.editValue : state.composeValue

  function setValue(value: string) {
    dispatch({ type: 'value', value })
  }

  function clearCompose() {
    dispatch({ type: 'clear-compose' })
    if (userId && channelId) writeComposerDraft(userId, channelId, '')
  }

  return { value, editing, setValue, clearCompose }
}
