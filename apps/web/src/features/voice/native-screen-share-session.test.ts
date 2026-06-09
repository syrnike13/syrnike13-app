import { describe, expect, it } from 'vitest'

import {
  clearNativePickerSelection,
  rejectNativePickerSelection,
  resolveNativePickerSelection,
  waitForNativePickerSelection,
} from './native-screen-share-session'

describe('native screen share picker session', () => {
  it('resolves source and audio selection together', async () => {
    const selectionPromise = waitForNativePickerSelection()

    resolveNativePickerSelection({
      requestId: 'request-1',
      sourceId: 'window:1234',
      audioRequested: false,
    })

    await expect(selectionPromise).resolves.toEqual({
      requestId: 'request-1',
      sourceId: 'window:1234',
      audioRequested: false,
    })
  })

  it('rejects pending selections', async () => {
    const selectionPromise = waitForNativePickerSelection()

    rejectNativePickerSelection(new Error('Screen share picker cancelled'))

    await expect(selectionPromise).rejects.toThrow('Screen share picker cancelled')
  })

  it('rejects pending selections when cleared', async () => {
    const selectionPromise = waitForNativePickerSelection()

    clearNativePickerSelection()

    await expect(selectionPromise).rejects.toThrow('Screen share picker cleared')
  })

  it('keeps the first resolution when resolve is called twice', async () => {
    const selectionPromise = waitForNativePickerSelection()

    resolveNativePickerSelection({
      requestId: 'request-1',
      sourceId: 'window:1234',
      audioRequested: false,
    })
    resolveNativePickerSelection({
      requestId: 'request-2',
      sourceId: 'screen:1',
      audioRequested: true,
    })

    await expect(selectionPromise).resolves.toEqual({
      requestId: 'request-1',
      sourceId: 'window:1234',
      audioRequested: false,
    })
  })

  it('resolves concurrent waiters with the same selection', async () => {
    const first = waitForNativePickerSelection()
    const second = waitForNativePickerSelection()

    resolveNativePickerSelection({
      requestId: 'request-1',
      sourceId: 'window:1234',
      audioRequested: true,
    })

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        requestId: 'request-1',
        sourceId: 'window:1234',
        audioRequested: true,
      },
      {
        requestId: 'request-1',
        sourceId: 'window:1234',
        audioRequested: true,
      },
    ])
  })
})
