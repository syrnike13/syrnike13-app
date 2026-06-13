import { describe, expect, it, vi } from 'vitest'

import { createVoiceSessionController } from './voice-session-controller'

describe('voice session controller', () => {
  it('records a requested join as the desired voice session and notifies subscribers', () => {
    const listener = vi.fn()
    const controller = createVoiceSessionController({
      createOperationId: () => 'op-a',
    })
    controller.subscribe(listener)

    const operationId = controller.requestJoin('voice-a', {
      reason: 'manual_join',
    })

    expect(operationId).toBe('op-a')
    expect(controller.getState()).toMatchObject({
      desired: {
        kind: 'channel',
        channelId: 'voice-a',
        operationId: 'op-a',
        reason: 'manual_join',
      },
      phase: 'preparing',
      activeOperationId: 'op-a',
    })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps the latest join operation when stale events arrive', () => {
    const operationIds = ['op-a', 'op-b']
    const controller = createVoiceSessionController({
      createOperationId: () => operationIds.shift() ?? 'op-extra',
    })

    controller.requestJoin('voice-a', { reason: 'manual_join' })
    controller.requestJoin('voice-b', { reason: 'switch' })
    controller.handleServerPrepareSucceeded('op-a')
    controller.handleRoomConnectFailed('op-a', 'stale failure')

    expect(controller.getState()).toMatchObject({
      desired: {
        kind: 'channel',
        channelId: 'voice-b',
        operationId: 'op-b',
        reason: 'switch',
      },
      phase: 'preparing',
      activeOperationId: 'op-b',
      lastError: null,
    })
  })

  it('keeps the previous connected channel when target handoff fails', () => {
    const operationIds = ['op-a', 'op-b']
    const controller = createVoiceSessionController({
      createOperationId: () => operationIds.shift() ?? 'op-extra',
    })

    controller.requestJoin('voice-a', { reason: 'manual_join' })
    controller.handleServerCommitObserved('op-a', 'voice-a')
    controller.requestJoin('voice-b', { reason: 'switch' })
    controller.handleRoomConnectFailed('op-b', 'LiveKit timeout')

    expect(controller.getState()).toMatchObject({
      desired: {
        kind: 'channel',
        channelId: 'voice-b',
        operationId: 'op-b',
      },
      phase: 'failed_retrying',
      connectedChannelId: 'voice-a',
      previousChannelId: 'voice-a',
      lastError: 'LiveKit timeout',
    })
  })

  it('does not regress when the server commit is observed before room connect resolves', () => {
    const controller = createVoiceSessionController({
      createOperationId: () => 'op-a',
    })

    controller.requestJoin('voice-a', { reason: 'manual_join' })
    controller.handleServerPrepareSucceeded('op-a')
    controller.handleServerCommitObserved('op-a', 'voice-a')
    controller.handleRoomConnected('op-a')

    expect(controller.getState()).toMatchObject({
      phase: 'connected',
      connectedChannelId: 'voice-a',
      activeOperationId: 'op-a',
      lastError: null,
    })
  })

  it('lets explicit leave cancel desired voice and ignore stale join commit', () => {
    const operationIds = ['op-a', 'op-leave']
    const controller = createVoiceSessionController({
      createOperationId: () => operationIds.shift() ?? 'op-extra',
    })

    controller.requestJoin('voice-a', { reason: 'manual_join' })
    controller.requestLeave()
    controller.handleServerCommitObserved('op-a', 'voice-a')

    expect(controller.getState()).toMatchObject({
      desired: { kind: 'none', operationId: 'op-leave' },
      phase: 'leaving',
      connectedChannelId: null,
      activeOperationId: 'op-leave',
    })
  })
})
