import type { JsonValue } from '@syrnike13/activity-sdk'

/** Result of one Reaction round, written by the host. */
export type RoundResult = {
  readonly round: number
  readonly hostId: string
  readonly finishedAt: string
  /** Valid reactions, fastest first. */
  readonly times: readonly { readonly userId: string; readonly ms: number }[]
  readonly falseStarts: readonly string[]
  readonly winnerId: string | null
}

/** The whole shared state document of the lab. */
export type LabState = {
  readonly counter: number
  readonly note: string
  readonly reaction: RoundResult | null
}

export function readLabState(data: JsonValue): LabState {
  const value = isObject(data) ? data : {}
  return {
    counter: typeof value.counter === 'number' ? value.counter : 0,
    note: typeof value.note === 'string' ? value.note : '',
    reaction: isObject(value.reaction) ? (value.reaction as unknown as RoundResult) : null,
  }
}

export function toJson(state: LabState): JsonValue {
  return state as unknown as JsonValue
}

export function isObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
