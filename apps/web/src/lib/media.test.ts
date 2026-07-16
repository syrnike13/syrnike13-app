import { describe, expect, it } from 'vitest'
import type { File } from '@syrnike13/api-types'

import {
  attachmentOriginalUrl,
  isAnimatedGifFile,
  serverBannerUrl,
  serverIconUrl,
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

  it('falls back to original token when original filename is empty', () => {
    const avatar = imageFile({
      filename: '',
    })

    expect(userAvatarUrl(avatar, { animated: true })).toBe(
      'https://syrnike13.ru/autumn/avatars/file-1/original',
    )
  })

  it('falls back to original token when original filename is missing', () => {
    expect(attachmentOriginalUrl({ _id: 'file-1', tag: 'avatars' })).toBe(
      'https://syrnike13.ru/autumn/avatars/file-1/original',
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

describe('server media urls', () => {
  it('uses static previews for server icons and animated originals for banners when requested', () => {
    const icon = imageFile()
    const banner = imageFile({
      _id: 'banner-1',
      tag: 'backgrounds',
      filename: 'server banner.gif',
    })

    expect(serverIconUrl(icon)).toBe(
      'https://syrnike13.ru/autumn/avatars/file-1',
    )
    expect(serverBannerUrl(banner, { animated: true })).toBe(
      'https://syrnike13.ru/autumn/backgrounds/banner-1/server%20banner.gif',
    )
  })
})
