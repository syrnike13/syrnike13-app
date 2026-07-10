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
      gatewayDispatched: boolean
      expectedCurrentOperationId?: string
      retainFinalized?: true
    }

export type VoiceOperationRecord = Readonly<{
  operationId: string
  channelId: string
  kind: 'join' | 'retain' | 'hard_leave'
  expectedCurrentOperationId: string | null
  gatewayDispatched: boolean
  authority: 'unknown' | 'accepted' | 'rejected'
  lifecycle: 'active' | 'superseded' | 'failed' | 'committed'
}>

export type VoiceDirectorState = {
  desired: VoiceIntent
  committed: string | null
  committedOperationId: string | null
  controlOperationId: string | null
  phase: VoiceDirectorPhase
  steps: VoiceStep[]
  activeOperationId: string | null
  operationJournal: VoiceOperationRecord[]
  lastError: string | null
}

export type VoiceDirectorEvent =
  | { type: 'intent'; channelId: string; reason: VoiceJoinReason }
  | { type: 'force_rejoin'; channelId: string; error?: string }
  | { type: 'clear_intent' }
  | { type: 'commit'; operationId: string; channelId: string }
  | { type: 'leave_observed'; operationId: string }
  | { type: 'step_progress'; operationId: string; phase: VoiceDirectorPhase }
  | { type: 'gateway_dispatched'; operationId: string }
  | { type: 'gateway_accepted'; operationId: string }
  | {
      type: 'gateway_rejected'
      operationId: string
      authoritativeOperationId: string | null
    }
  | { type: 'step_awaiting_commit'; operationId: string }
  | { type: 'step_failed'; operationId: string; error: string }
  | { type: 'disconnected'; operationId: string | null; expected: boolean; error?: string }
  | {
      type: 'restore_source'
      channelId: string
      supersededOperationId?: string | null
    }
  | {
      type: 'restore_source_after_dispatch'
      channelId: string
      retainedOperationId: string
      expectedCurrentOperationId: string
      reason: VoiceJoinReason
    }
  | { type: 'reset' }

type ReplanOptions = {
  desired: VoiceIntent
  reason: VoiceJoinReason
  lastError?: string | null
  supersededOperationIds?: string[]
  expectedCurrentOperationId?: string | null
}

export function createInitialDirectorState(): VoiceDirectorState {
  return {
    desired: { kind: 'none' },
    committed: null,
    committedOperationId: null,
    controlOperationId: null,
    phase: 'idle',
    steps: [],
    activeOperationId: null,
    operationJournal: [],
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
        if (
          state.steps.length > 0 ||
          (state.committed === event.channelId && state.lastError === null)
        ) {
          return state
        }
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
          expectedCurrentOperationId: authoritativeOperationId(state),
          supersededOperationIds: state.steps.map((step) => step.operationId),
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
      return reduceCommit(state, event, createOperationId)

    case 'leave_observed':
      return reduceLeaveObserved(state, event, createOperationId)

    case 'step_progress':
      if (state.activeOperationId !== event.operationId) {
        return state
      }
      return withRuntimeFields({ ...state, phase: event.phase })

    case 'gateway_dispatched':
      return markGatewayDispatched(state, event.operationId)

    case 'gateway_accepted':
      return applyGatewayAuthority(
        state,
        event.operationId,
        event.operationId,
        'accepted',
      )

    case 'gateway_rejected':
      return applyGatewayAuthority(
        state,
        event.operationId,
        event.authoritativeOperationId,
        'rejected',
      )

    case 'step_awaiting_commit':
      if (state.activeOperationId !== event.operationId) {
        return state
      }
      return state

    case 'step_failed':
      return reduceStepFailed(state, event)

    case 'disconnected':
      return reduceDisconnected(state, event, createOperationId)

    case 'restore_source': {
      const supersededOperationIds = [
        ...state.steps.map((step) => step.operationId),
        ...(event.supersededOperationId ? [event.supersededOperationId] : []),
      ]
      return withRuntimeFields({
        ...state,
        desired: { kind: 'channel', channelId: event.channelId },
        steps: [],
        operationJournal: replaceOperationSteps(
          state,
          [],
          supersededOperationIds,
        ),
        lastError: null,
      })
    }

    case 'restore_source_after_dispatch': {
      const steps: VoiceStep[] = [
        {
          kind: 'join',
          operationId: event.retainedOperationId,
          channelId: event.channelId,
          reason: event.reason,
          gatewayDispatched: false,
          expectedCurrentOperationId: event.expectedCurrentOperationId,
          retainFinalized: true,
        },
      ]
      return withRuntimeFields({
        ...state,
        desired: { kind: 'channel', channelId: event.channelId },
        steps,
        operationJournal: replaceOperationSteps(
          state,
          steps,
          state.steps.map((step) => step.operationId),
        ),
        lastError: null,
      })
    }

    case 'reset':
      return createInitialDirectorState()

    default:
      return state
  }
}

function reduceCommit(
  state: VoiceDirectorState,
  event: Extract<VoiceDirectorEvent, { type: 'commit' }>,
  createOperationId: () => string,
): VoiceDirectorState {
  const head = state.steps[0]
  const isCurrentJoin =
    head?.kind === 'join' &&
    head.operationId === event.operationId &&
    head.channelId === event.channelId &&
    state.desired.kind === 'channel' &&
    state.desired.channelId === event.channelId

  if (isCurrentJoin) {
    return withRuntimeFields({
      ...state,
      committed: event.channelId,
      committedOperationId: event.operationId,
      controlOperationId: event.operationId,
      steps: state.steps.slice(1),
      operationJournal: updateOperationRecord(
        state.operationJournal,
        event.operationId,
        { authority: 'accepted', lifecycle: 'committed' },
      ),
      lastError: null,
    })
  }

  const knownRecord = state.operationJournal.find(
    (record) =>
      record.operationId === event.operationId &&
      record.channelId === event.channelId,
  )
  const isKnownServerOperation = Boolean(knownRecord)
  if (!isKnownServerOperation) {
    return state
  }

  if (
    head?.kind === 'join' &&
    head.retainFinalized &&
    head.expectedCurrentOperationId === event.operationId
  ) {
    const observed = withRuntimeFields({
      ...state,
      committed: event.channelId,
      committedOperationId: event.operationId,
      controlOperationId: event.operationId,
      steps: [],
      activeOperationId: null,
      operationJournal: updateOperationRecord(
        updateOperationRecord(
          state.operationJournal,
          event.operationId,
          { authority: 'accepted', lifecycle: 'committed' },
        ),
        head.operationId,
        { lifecycle: 'superseded' },
      ),
      lastError: null,
    })
    return replan(observed, createOperationId, {
      desired: state.desired,
      reason: 'switch',
      expectedCurrentOperationId: event.operationId,
      lastError: null,
    })
  }

  const observed = withRuntimeFields({
    ...state,
    committed: event.channelId,
    committedOperationId: event.operationId,
    controlOperationId:
      head?.kind === 'join' && state.controlOperationId === head.operationId
        ? state.controlOperationId
        : event.operationId,
    operationJournal: updateOperationRecord(
      state.operationJournal,
      event.operationId,
      { authority: 'accepted', lifecycle: 'committed' },
    ),
  })
  if (
    state.steps.length === 0 &&
    (knownRecord?.lifecycle === 'failed' ||
      !isSameIntent(state.desired, {
        kind: 'channel',
        channelId: event.channelId,
      }))
  ) {
    return replan(observed, createOperationId, {
      desired: state.desired,
      reason: knownRecord?.lifecycle === 'failed' ? 'rejoin' : 'switch',
      expectedCurrentOperationId: event.operationId,
      lastError: null,
    })
  }
  return observed
}

function reduceLeaveObserved(
  state: VoiceDirectorState,
  event: Extract<VoiceDirectorEvent, { type: 'leave_observed' }>,
  createOperationId: () => string,
): VoiceDirectorState {
  const head = state.steps[0]
  if (head?.kind === 'hard_leave') {
    if (
      event.operationId !== head.operationId &&
      event.operationId !== state.committedOperationId
    ) {
      return state
    }
    return withRuntimeFields({
      ...state,
      committed: null,
      committedOperationId: null,
      controlOperationId: null,
      steps: state.steps.slice(1),
      operationJournal: updateOperationRecord(
        state.operationJournal,
        head.operationId,
        { lifecycle: 'committed' },
      ),
      lastError: null,
    })
  }

  if (
    !state.committedOperationId ||
    event.operationId !== state.committedOperationId
  ) {
    return state
  }

  const observed = withRuntimeFields({
    ...state,
    committed: null,
    committedOperationId: null,
    controlOperationId:
      state.controlOperationId === event.operationId
        ? null
        : state.controlOperationId,
    operationJournal: updateOperationRecord(
      state.operationJournal,
      event.operationId,
      { lifecycle: 'failed' },
    ),
    lastError: 'Voice session left the committed channel',
  })
  if (observed.steps.length > 0 || observed.desired.kind !== 'channel') {
    return observed
  }
  return replan(observed, createOperationId, {
    desired: observed.desired,
    reason: 'rejoin',
    expectedCurrentOperationId: null,
    lastError: observed.lastError,
  })
}

function reduceStepFailed(
  state: VoiceDirectorState,
  event: Extract<VoiceDirectorEvent, { type: 'step_failed' }>,
): VoiceDirectorState {
  const head = state.steps[0]
  if (!head || head.operationId !== event.operationId) {
    return state
  }

  return withRuntimeFields({
    ...state,
    steps: [],
    activeOperationId: null,
    phase: phaseFor([], state.committed),
    operationJournal: updateOperationRecord(
      state.operationJournal,
      event.operationId,
      { lifecycle: 'failed' },
    ),
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
      expectedCurrentOperationId: authoritativeOperationId(state),
      supersededOperationIds: state.steps.map((step) => step.operationId),
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
      expectedCurrentOperationId: authoritativeOperationId(state),
      supersededOperationIds: state.steps.map((step) => step.operationId),
    })
  }
  if (state.activeOperationId !== event.operationId) {
    return state
  }
  if (event.expected) {
    return state
  }

  return reduceStepFailed(state, {
    type: 'step_failed',
    operationId: event.operationId,
    error: event.error ?? 'Disconnected',
  })
}

function replan(
  state: VoiceDirectorState,
  createOperationId: () => string,
  options: ReplanOptions,
): VoiceDirectorState {
  const preservedHead = state.steps[0]?.kind === 'hard_leave' ? state.steps[0] : null
  const fromPosition = preservedHead ? null : state.committed
  const steps: VoiceStep[] = preservedHead ? [preservedHead] : []
  const expectedCurrentOperationId = preservedHead
    ? null
    : options.expectedCurrentOperationId === undefined
      ? authoritativeOperationId(state)
      : options.expectedCurrentOperationId

  if (options.desired.kind === 'channel') {
    if (fromPosition !== options.desired.channelId) {
      steps.push({
        kind: 'join',
        operationId: createOperationId(),
        channelId: options.desired.channelId,
        reason: options.reason,
        gatewayDispatched: false,
        ...(expectedCurrentOperationId
          ? { expectedCurrentOperationId }
          : {}),
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
  const supersededOperationIds = [
    ...state.steps
      .filter((step) => !retainedOperationIds.has(step.operationId))
      .map((step) => step.operationId),
    ...(options.supersededOperationIds ?? []),
  ]

  return withRuntimeFields({
    ...state,
    desired: options.desired,
    steps,
    operationJournal: replaceOperationSteps(
      state,
      steps,
      supersededOperationIds,
    ),
    lastError: options.lastError ?? state.lastError,
  })
}

function authoritativeOperationId(state: VoiceDirectorState): string | null {
  return state.controlOperationId
}

function applyGatewayAuthority(
  state: VoiceDirectorState,
  operationId: string,
  authoritativeOperationId: string | null,
  outcome: VoiceOperationRecord['authority'],
): VoiceDirectorState {
  const head = state.steps[0]
  const knownOperation = state.operationJournal.some(
    (record) => record.operationId === operationId,
  )
  if (!knownOperation && head?.operationId !== operationId) {
    return state
  }
  let operationJournal = updateOperationRecord(
    state.operationJournal,
    operationId,
    { authority: outcome },
  )
  if (authoritativeOperationId) {
    operationJournal = updateOperationRecord(
      operationJournal,
      authoritativeOperationId,
      { authority: 'accepted' },
    )
  }
  if (!head || head.kind !== 'join') {
    return withRuntimeFields({
      ...state,
      controlOperationId: authoritativeOperationId,
      operationJournal,
    })
  }
  if (
    head.operationId !== operationId &&
    head.retainFinalized &&
    head.operationId === authoritativeOperationId
  ) {
    return withRuntimeFields({
      ...state,
      controlOperationId: authoritativeOperationId,
      steps: [],
      operationJournal: updateOperationRecord(
        operationJournal,
        head.operationId,
        { lifecycle: 'committed' },
      ),
      lastError: null,
    })
  }
  if (head.operationId === operationId) {
    return withRuntimeFields({
      ...state,
      controlOperationId: authoritativeOperationId,
      operationJournal,
    })
  }

  const { expectedCurrentOperationId: _ignored, ...withoutExpected } = head
  const updatedHead: VoiceStep = authoritativeOperationId
    ? { ...withoutExpected, expectedCurrentOperationId: authoritativeOperationId }
    : withoutExpected
  return withRuntimeFields({
    ...state,
    controlOperationId: authoritativeOperationId,
    steps: [updatedHead, ...state.steps.slice(1)],
    operationJournal: updateOperationRecord(
      operationJournal,
      updatedHead.operationId,
      {
        expectedCurrentOperationId:
          updatedHead.kind === 'join'
            ? updatedHead.expectedCurrentOperationId ?? null
            : null,
      },
    ),
  })
}

function markGatewayDispatched(
  state: VoiceDirectorState,
  operationId: string,
): VoiceDirectorState {
  const head = state.steps[0]
  if (
    !head ||
    head.kind !== 'join' ||
    head.operationId !== operationId ||
    head.gatewayDispatched
  ) {
    return state
  }

  return withRuntimeFields({
    ...state,
    steps: [{ ...head, gatewayDispatched: true }, ...state.steps.slice(1)],
    operationJournal: updateOperationRecord(
      state.operationJournal,
      operationId,
      { gatewayDispatched: true },
    ),
  })
}

function withRuntimeFields(state: VoiceDirectorState): VoiceDirectorState {
  const next = {
    ...state,
    activeOperationId: state.steps[0]?.operationId ?? null,
    phase: phaseFor(state.steps, state.committed),
  }
  return {
    ...next,
    operationJournal: normalizeOperationJournal(next),
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

const MAX_OPERATION_JOURNAL_RECORDS = 32

function operationRecordForStep(step: VoiceStep): VoiceOperationRecord {
  return {
    operationId: step.operationId,
    channelId: step.channelId,
    kind:
      step.kind === 'hard_leave'
        ? 'hard_leave'
        : step.retainFinalized
          ? 'retain'
          : 'join',
    expectedCurrentOperationId:
      step.kind === 'join' ? step.expectedCurrentOperationId ?? null : null,
    gatewayDispatched:
      step.kind === 'join' ? step.gatewayDispatched : false,
    authority: 'unknown',
    lifecycle: 'active',
  }
}

function replaceOperationSteps(
  state: VoiceDirectorState,
  steps: VoiceStep[],
  supersededOperationIds: readonly string[],
) {
  let journal = state.operationJournal
  for (const operationId of supersededOperationIds) {
    const oldStep = state.steps.find((step) => step.operationId === operationId)
    if (
      oldStep &&
      !journal.some((record) => record.operationId === operationId)
    ) {
      journal = [...journal, operationRecordForStep(oldStep)]
    }
    journal = updateOperationRecord(journal, operationId, {
      lifecycle: 'superseded',
    })
  }
  for (const step of steps) {
    const existing = journal.find(
      (record) => record.operationId === step.operationId,
    )
    const planned = operationRecordForStep(step)
    journal = existing
      ? updateOperationRecord(journal, step.operationId, {
          channelId: planned.channelId,
          kind: planned.kind,
          expectedCurrentOperationId: planned.expectedCurrentOperationId,
          gatewayDispatched:
            existing.gatewayDispatched || planned.gatewayDispatched,
          lifecycle: 'active',
        })
      : [...journal, planned]
  }
  return journal
}

function updateOperationRecord(
  journal: VoiceOperationRecord[],
  operationId: string,
  patch: Partial<Omit<VoiceOperationRecord, 'operationId'>>,
) {
  return journal.map((record) =>
    record.operationId === operationId ? { ...record, ...patch } : record,
  )
}

function normalizeOperationJournal(state: VoiceDirectorState) {
  if (state.operationJournal.length <= MAX_OPERATION_JOURNAL_RECORDS) {
    return state.operationJournal
  }
  const protectedIds = new Set(
    [
      state.committedOperationId,
      state.controlOperationId,
      ...state.steps.map((step) => step.operationId),
    ].filter((operationId): operationId is string => Boolean(operationId)),
  )
  const selectedIds = new Set(protectedIds)
  for (let index = state.operationJournal.length - 1; index >= 0; index -= 1) {
    const record = state.operationJournal[index]
    if (selectedIds.size >= MAX_OPERATION_JOURNAL_RECORDS) break
    selectedIds.add(record.operationId)
  }
  return state.operationJournal.filter((record) =>
    selectedIds.has(record.operationId),
  )
}
