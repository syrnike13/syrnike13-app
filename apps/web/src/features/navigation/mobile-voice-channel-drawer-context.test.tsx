// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  MobileVoiceChannelDrawerProvider,
  useMobileVoiceChannelDrawer,
  useOptionalMobileVoiceChannelDrawer,
} from './mobile-voice-channel-drawer-context'

function StrictConsumer() {
  useMobileVoiceChannelDrawer()
  return <div>strict</div>
}

function OptionalConsumer() {
  const drawer = useOptionalMobileVoiceChannelDrawer()
  return <div>{drawer ? 'available' : 'missing'}</div>
}

describe('mobile voice channel drawer context', () => {
  it('keeps the strict hook guarded by the provider', () => {
    expect(() => render(<StrictConsumer />)).toThrow(
      'useMobileVoiceChannelDrawer must be used within MobileVoiceChannelDrawerProvider',
    )
  })

  it('allows shared desktop/mobile consumers to treat the drawer as unavailable', () => {
    render(<OptionalConsumer />)

    expect(screen.getByText('missing')).toBeTruthy()
  })

  it('returns drawer controls from the optional hook inside the provider', () => {
    render(
      <MobileVoiceChannelDrawerProvider>
        <OptionalConsumer />
      </MobileVoiceChannelDrawerProvider>,
    )

    expect(screen.getByText('available')).toBeTruthy()
  })
})
