import { describe, expect, it } from 'vitest'

import { appRoutePrefixForPath } from './route-prefix'

describe('appRoutePrefixForPath', () => {
  it('returns the mobile prefix for /m routes', () => {
    expect(appRoutePrefixForPath('/m')).toBe('/m')
    expect(appRoutePrefixForPath('/m/')).toBe('/m')
    expect(appRoutePrefixForPath('/m/c/channel-1')).toBe('/m')
  })

  it('does not treat non-/m prefixes as mobile routes', () => {
    expect(appRoutePrefixForPath('/mobile')).toBe('/app')
    expect(appRoutePrefixForPath('/meetings')).toBe('/app')
    expect(appRoutePrefixForPath('/m-admin')).toBe('/app')
  })
})
