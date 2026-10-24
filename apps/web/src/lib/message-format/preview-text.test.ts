import { describe, expect, it } from 'vitest'

import { messagePreviewText } from '#/lib/message-format/preview-text'

const users = {
  '01KW5NEH92C4QMDZGT4Q8ZPEEN': { _id: '01KW5NEH92C4QMDZGT4Q8ZPEEN', username: 'tiredisa', display_name: null },
} as never

describe('messagePreviewText', () => {
  it('reads user mentions as @name', () => {
    expect(messagePreviewText('<@01KW5NEH92C4QMDZGT4Q8ZPEEN> 123', { users })).toBe('@tiredisa 123')
  })

  it('drops formatting marks and joins lines', () => {
    expect(messagePreviewText('**bold**\nnext', { users })).toBe('bold next')
  })

  it('keeps unknown mentions readable', () => {
    expect(messagePreviewText('<@01KW5NEH92C4QMDZGT4Q8ZPEEX>', { users })).toBe('@01KW5NEH92C4QMDZGT4Q8ZPEEX')
  })
})
