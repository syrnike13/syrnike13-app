export type VoiceJoinReason = 'manual_join' | 'switch' | 'dm_answer' | 'rejoin'

export type VoiceDirectorPhase = 'idle' | 'leaving' | 'joining' | 'connected'

export type VoiceIntent =
  | { kind: 'none' }
  | { kind: 'channel'; channelId: string }

export type VoiceStep =
  | { kind: 'hard_leave'; operationId: string; channelId: string }
  | {
      kind: 'join'
      operationId: string
      channelId: string
      reason: VoiceJoinReason
    }

export type VoiceDirectorState = {
  desired: VoiceIntent
  committed: string | null
  committedOperationId: string | null
  phase: VoiceDirectorPhase
  steps: VoiceStep[]
  activeOperationId: string | null
  supersededOperationIds: string[]
  lastError: string | null
}

export type VoiceDirectorEvent =
  | { type: 'intent'; channelId: string; reason: VoiceJoinReason }
  | { type: 'force_rejoin'; channelId: string; error?: string }
  | { type: 'clear_intent' }
  | { type: 'commit'; operationId: string; channelId: string }
  | { type: 'leave_observed'; operationId: string | null }
  | { type: 'step_progress'; operationId: string; phase: VoiceDirectorPhase }
  | { type: 'step_awaiting_commit'; operationId: string }
  | { type: 'step_failed'; operationId: string; error: string }
  | { type: 'disconnected'; operationId: string | null; expected: boolean; error?: string }
  | {
      type: 'restore_source'
      channelId: string
      supersededOperationId?: string | null
    }
  | { type: 'reset' }

type ReplanOptions = {
  desired: VoiceIntent
  reason: VoiceJoinReason
  lastError?: string | null
  supersededOperationIds?: string[]
}

export function createInitialDirectorState(): VoiceDirectorState {
  return {
    desired: { kind: 'none' },
    committed: null,
    committedOperationId: null,
    phase: 'idle',
    steps: [],
    activeOperationId: null,
    supersededOperationIds: [],
    lastError: null,
  }
}

export function reduceDirector(
  state: VoiceDirectorState,
  event: VoiceDirectorEvent,
  createOperationId: () => string,
): VoiceDirectorState {
  switch (event.type) {
    case 'intent':
      if (isSameIntent(state.desired, { kind: 'channel', channelId: event.channelId })) {
        return state
      }
      return replan(state, createOperationId, {
        desired: { kind: 'channel', channelId: event.channelId },
        reason: event.reason,
        lastError: null,
      })

    case 'force_rejoin':
      return replan(
        {
          ...state,
          desired: { kind: 'channel', channelId: event.channelId },
          committed: null,
          committedOperationId: null,
          steps: [],
          activeOperationId: null,
          phase: 'idle',
        },
        createOperationId,
        {
          desired: { kind: 'channel', channelId: event.channelId },
          reason: 'rejoin',
          lastError: event.error ?? null,
        },
      )

    case 'clear_intent':
      if (state.desired.kind === 'none' && state.steps.length === 0) {
        return state
      }
      return replan(state, createOperationId, {
        desired: { kind: 'none' },
        reason: reasonFromSteps(state.steps),
        lastError: null,
      })

    case 'commit':
      return reduceCommit(state, event)

    case 'leave_observed':
      return reduceLeaveObserved(state, event)

    case 'step_progress':
      if (state.activeOperationId !== event.operationId) {
        return state
      }
      return withRuntimeFields({ ...state, phase: event.phase })

    case 'step_awaiting_commit':
      if (state.activeOperationId !== event.operationId) {
        return state
      }
      return state

    case 'step_failed':
      return reduceStepFailed(state, event, createOperationId)

    case 'disconnected':
      return reduceDisconnected(state, event, createOperationId)

    case 'restore_source':
      return withRuntimeFields({
        ...state,
        desired: { kind: 'channel', channelId: event.channelId },
        steps: [],
        supersededOperationIds: appendUnique(
          state.supersededOperationIds,
          state.steps.map((step) => step.operationId),
          event.supersededOperationId ? [event.supersededOperationId] : [],
        ),
        lastError: null,
      })

    case 'reset':
      return createInitialDirectorState()

    default:
      return state
  }
}

function reduceCommit(
  state: VoiceDirectorState,
  event: Extract<VoiceDirectorEvent, { type: 'commit' }>,
): VoiceDirectorState {
  const head = state.steps[0]
  if (
    !head ||
    head.kind !== 'join' ||
    head.operationId !== event.operationId ||
    head.channelId !== event.channelId ||
    state.desired.kind !== 'channel' ||
    state.desired.channelId !== event.channelId
  ) {
    return state
  }

  return withRuntimeFields({
    ...state,
    committed: event.channelId,
    committedOperationId: event.operationId,
    steps: state.steps.slice(1),
    lastError: null,
  })
}

function reduceLeaveObserved(
  state: VoiceDirectorState,
  event: Extract<VoiceDirectorEvent, { type: 'leave_observed' }>,
): VoiceDirectorState {
  const head = state.steps[0]
  if (!head || head.kind !== 'hard_leave') {
    if (event.operationId === null && state.committed !== null) {
      return withRuntimeFields({
        ...state,
        committed: null,
        committedOperationId: null,
      })
    }
    return state
  }
  if (event.operationId !== null && head.operationId !== event.operationId) {
    return state
  }

  return withRuntimeFields({
    ...state,
    committed: null,
    committedOperationId: null,
    steps: state.steps.slice(1),
    lastError: null,
  })
}

function reduceStepFailed(
  state: VoiceDirectorState,
  event: Extract<VoiceDirectorEvent, { type: 'step_failed' }>,
  createOperationId: () => string,
): VoiceDirectorState {
  const head = state.steps[0]
  if (!head || head.operationId !== event.operationId) {
    return state
  }

  const baseState = {
    ...state,
    steps: [],
    activeOperationId: null,
    phase: phaseFor([], state.committed),
  }

  return replan(baseState, createOperationId, {
    desired: state.desired,
    reason: reasonFromSteps(state.steps),
    lastError: event.error,
  })
}

function reduceDisconnected(
  state: VoiceDirectorState,
  event: Extract<VoiceDirectorEvent, { type: 'disconnected' }>,
  createOperationId: () => string,
): VoiceDirectorState {
  if (event.operationId === null) {
    if (event.expected || state.committed === null) {
      return state
    }
    const baseState = {
      ...state,
      committed: null,
      committedOperationId: null,
      steps: [],
      activeOperationId: null,
      phase: 'idle' as VoiceDirectorPhase,
    }
    return replan(baseState, createOperationId, {
      desired: state.desired,
      reason: 'rejoin',
      lastError: event.error ?? 'Disconnected',
    })
  }
  if (
    !event.expected &&
    state.committedOperationId === event.operationId &&
    state.committed !== null
  ) {
    const baseState = {
      ...state,
      committed: null,
      committedOperationId: null,
      steps: [],
      activeOperationId: null,
      phase: 'idle' as VoiceDirectorPhase,
    }
    return replan(baseState, createOperationId, {
      desired: state.desired,
      reason: 'rejoin',
      lastError: event.error ?? 'Disconnected',
    })
  }
  if (state.activeOperationId !== event.operationId) {
    return state
  }
  if (event.expected) {
    return state
  }

  return reduceStepFailed(
    state,
    {
      type: 'step_failed',
      operationId: event.operationId,
      error: event.error ?? 'Disconnected',
    },
    createOperationId,
  )
}

function replan(
  state: VoiceDirectorState,
  createOperationId: () => string,
  options: ReplanOptions,
): VoiceDirectorState {
  const preservedHead = state.steps[0]?.kind === 'hard_leave' ? state.steps[0] : null
  const fromPosition = preservedHead ? null : state.committed
  const steps: VoiceStep[] = preservedHead ? [preservedHead] : []

  if (options.desired.kind === 'channel') {
    if (fromPosition !== null && fromPosition !== options.desired.channelId) {
      steps.push({
        kind: 'hard_leave',
        operationId: createOperationId(),
        channelId: fromPosition,
      })
    }
    if (fromPosition !== options.desired.channelId) {
      steps.push({
        kind: 'join',
        operationId: createOperationId(),
        channelId: options.desired.channelId,
        reason: options.reason,
      })
    }
  } else if (fromPosition !== null) {
    steps.push({
      kind: 'hard_leave',
      operationId: createOperationId(),
      channelId: fromPosition,
    })
  }

  const retainedOperationIds = new Set(steps.map((step) => step.operationId))
  const supersededOperationIds = appendUnique(
    state.supersededOperationIds,
    state.steps
      .filter((step) => !retainedOperationIds.has(step.operationId))
      .map((step) => step.operationId),
    options.supersededOperationIds ?? [],
  )

  return withRuntimeFields({
    ...state,
    desired: options.desired,
    steps,
    supersededOperationIds,
    lastError: options.lastError ?? state.lastError,
  })
}

function withRuntimeFields(state: VoiceDirectorState): VoiceDirectorState {
  return {
    ...state,
    activeOperationId: state.steps[0]?.operationId ?? null,
    phase: phaseFor(state.steps, state.committed),
  }
}

function phaseFor(steps: VoiceStep[], committed: string | null): VoiceDirectorPhase {
  const head = steps[0]
  if (head?.kind === 'hard_leave') {
    return 'leaving'
  }
  if (head?.kind === 'join') {
    return 'joining'
  }
  return committed === null ? 'idle' : 'connected'
}

function isSameIntent(left: VoiceIntent, right: VoiceIntent): boolean {
  if (left.kind === 'none' || right.kind === 'none') {
    return left.kind === right.kind
  }
  return left.channelId === right.channelId
}

function reasonFromSteps(steps: VoiceStep[]): VoiceJoinReason {
  return steps.find((step) => step.kind === 'join')?.reason ?? 'manual_join'
}

function appendUnique(
  existing: string[],
  superseded: string[],
  extraSuperseded: string[],
): string[] {
  const seen = new Set(existing)
  const next = [...existing]
  for (const operationId of [...superseded, ...extraSuperseded]) {
    if (!seen.has(operationId)) {
      seen.add(operationId)
      next.push(operationId)
    }
  }
  return next
}
