// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import {
  composerDraftStorageKey,
  readComposerDraft,
  writeComposerDraft,
} from './composer-draft-store'

describe('composer draft persistence', () => {
  beforeEach(() => window.localStorage.clear())

  it('keeps drafts isolated by user and channel', () => {
    writeComposerDraft('user-a', 'channel-a', 'first')
    writeComposerDraft('user-a', 'channel-b', 'second')

    expect(readComposerDraft('user-a', 'channel-a')).toBe('first')
    expect(readComposerDraft('user-a', 'channel-b')).toBe('second')
    expect(readComposerDraft('user-b', 'channel-a')).toBe('')
  })

  it('removes an empty draft and tolerates invalid storage', () => {
    writeComposerDraft('user-a', 'channel-a', 'draft')
    writeComposerDraft('user-a', 'channel-a', '')
    expect(readComposerDraft('user-a', 'channel-a')).toBe('')

    window.localStorage.setItem(composerDraftStorageKey, '{broken')
    expect(readComposerDraft('user-a', 'channel-a')).toBe('')
  })
})
