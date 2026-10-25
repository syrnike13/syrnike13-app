import { describe, expect, it, vi } from 'vitest'

import {
  clearSystemProfile,
  readSystemProfile,
  writeSystemProfile,
} from './system-profile'

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key)
    }),
  }
}

const profile = {
  system: {
    os: 'Windows 11 24H2 (build 26100)',
    cpu: 'AMD Ryzen 7 5800X3D',
    cpu_threads: 16,
    gpu: 'NVIDIA GeForce RTX 3070',
    memory_bytes: 34_359_738_368,
    display: '2560x1440 @ 165 Hz',
  },
  peripherals: [
    { device: 'HyperX Cloud II', connection: 'wireless_2_4_ghz' as const },
    { device: 'Keychron K8', connection: 'bluetooth' as const },
  ],
}

describe('feedback system profile', () => {
  it('round-trips the saved hardware summary and devices', () => {
    const storage = memoryStorage()
    expect(writeSystemProfile(profile, storage)).toBe(true)

    const restored = readSystemProfile(storage)
    expect(restored?.system).toMatchObject({
      cpu: 'AMD Ryzen 7 5800X3D',
      memory_bytes: 34_359_738_368,
    })
    expect(restored?.peripherals).toEqual(profile.peripherals)
  })

  it('ignores corrupted storage', () => {
    const storage = memoryStorage({
      'syrnike.feedback.system-profile.v1': '{"system": 4}',
    })
    expect(readSystemProfile(storage)).toBeNull()
  })

  it('does not store an empty profile', () => {
    const storage = memoryStorage()
    expect(writeSystemProfile({ system: null, peripherals: [] }, storage)).toBe(
      false,
    )
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('keeps the dialog working when storage throws', () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('blocked')
      }),
      setItem: vi.fn(() => {
        throw new Error('blocked')
      }),
      removeItem: vi.fn(() => {
        throw new Error('blocked')
      }),
    }

    expect(readSystemProfile(storage)).toBeNull()
    expect(writeSystemProfile(profile, storage)).toBe(false)
    expect(() => clearSystemProfile(storage)).not.toThrow()
  })

  it('clears the stored profile', () => {
    const storage = memoryStorage()
    writeSystemProfile(profile, storage)
    clearSystemProfile(storage)
    expect(readSystemProfile(storage)).toBeNull()
  })
})
