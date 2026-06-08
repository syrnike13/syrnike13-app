import { describe, expect, it } from 'vitest'

import {
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
})
