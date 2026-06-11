import { describe, expect, it } from 'vitest'
import type { File } from '@syrnike13/api-types'

import {
  isAnimatedGifFile,
  userAvatarUrl,
  userBannerUrl,
} from '#/lib/media'

function imageFile(overrides: Partial<File> = {}) {
  return {
    _id: 'file-1',
    tag: 'avatars',
    filename: 'avatar.gif',
    content_type: 'image/gif',
    size: 1024,
    metadata: {
      type: 'Image',
      width: 128,
      height: 128,
      animated: true,
    },
    ...overrides,
  } satisfies File
}

describe('isAnimatedGifFile', () => {
  it('accepts only animated GIF images', () => {
    expect(isAnimatedGifFile(imageFile())).toBe(true)
    expect(
      isAnimatedGifFile(
        imageFile({
          metadata: {
            type: 'Image',
            width: 128,
            height: 128,
            animated: false,
          },
        }),
      ),
    ).toBe(false)
    expect(
      isAnimatedGifFile(imageFile({ content_type: 'image/webp' })),
    ).toBe(false)
    expect(isAnimatedGifFile(null)).toBe(false)
  })
})

describe('profile media urls', () => {
  it('uses static preview unless animation is explicitly requested', () => {
    const avatar = imageFile()

    expect(userAvatarUrl(avatar)).toBe(
      'https://syrnike13.ru/autumn/avatars/file-1',
    )
    expect(userAvatarUrl(avatar, { animated: true })).toBe(
      'https://syrnike13.ru/autumn/avatars/file-1/avatar.gif',
    )
  })

  it('uses canonical encoded filenames for original media URLs', () => {
    const avatar = imageFile({
      filename: 'space cat.gif',
    })

    expect(userAvatarUrl(avatar, { animated: true })).toBe(
      'https://syrnike13.ru/autumn/avatars/file-1/space%20cat.gif',
    )
  })

  it('does not use original URL for non-GIF images', () => {
    const banner = imageFile({
      _id: 'banner-1',
      tag: 'backgrounds',
      content_type: 'image/png',
    })

    expect(userBannerUrl(banner, { animated: true })).toBe(
      'https://syrnike13.ru/autumn/backgrounds/banner-1',
    )
  })
})
