import type { Activity, JsonValue } from '@syrnike13/activity-sdk'

import { isObject, readLabState, toJson, type RoundResult } from './lab-state'

/**
 * Host-authoritative Reaction game.
 *
 * Host: `armed` → random delay → `go` → collects `click` intents → writes the
 * round result to shared state. Players only send intents; the result in
 * shared state is the single source of truth (late joiners read it there).
 */
export type ReactionPhase = 'idle' | 'armed' | 'go' | 'clicked'

type ReactionMessage =
  | { type: 'reaction:armed'; round: number }
  | { type: 'reaction:go'; round: number }
  | { type: 'reaction:click'; round: number; ms: number | null }

const MIN_DELAY_MS = 1500
const MAX_DELAY_MS = 4000
const COLLECT_MS = 3000

export class ReactionGame {
  phase: ReactionPhase = 'idle'
  round = 0
  /** Own reaction in the current round; null means a false start. */
  myMs: number | null = null
  private goAt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  /** Host only: intents of the current round. */
  private readonly clicks = new Map<string, number | null>()

  constructor(
    private readonly activity: Activity,
    private readonly onChange: () => void,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Host: starts a new round. */
  start(): void {
    if (!this.activity.isHost || this.phase === 'armed' || this.phase === 'go') return
    const last = readLabState(this.activity.state.data).reaction?.round ?? 0
    this.round = Math.max(last, this.round) + 1
    this.clicks.clear()
    this.goAt = 0
    this.myMs = null
    this.setPhase('armed')
    this.broadcast({ type: 'reaction:armed', round: this.round })
    const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS)
    this.timer = setTimeout(() => {
      this.goAt = performance.now()
      if (this.phase === 'armed') this.setPhase('go')
      this.broadcast({ type: 'reaction:go', round: this.round })
      this.timer = setTimeout(() => void this.finish(), COLLECT_MS)
    }, delay)
  }

  click(): void {
    if (this.phase !== 'armed' && this.phase !== 'go') return
    this.myMs = this.phase === 'go' ? Math.round(performance.now() - this.goAt) : null
    this.setPhase('clicked')
    const intent = { round: this.round, ms: this.myMs }
    if (this.activity.isHost) {
      this.record(this.activity.user.id, intent)
    } else {
      this.activity
        .send({ type: 'reaction:click', ...intent }, { to: [this.activity.hostId] })
        .catch(this.onError)
    }
  }

  /** Returns true when the payload belonged to the game. */
  handleMessage(from: string, payload: JsonValue): boolean {
    if (!isObject(payload) || typeof payload.type !== 'string') return false
    const message = payload as unknown as ReactionMessage
    if (!message.type.startsWith('reaction:')) return false
    const fromHost = from === this.activity.hostId
    if (message.type === 'reaction:armed' && fromHost) {
      this.round = message.round
      this.myMs = null
      this.setPhase('armed')
    } else if (message.type === 'reaction:go' && fromHost && message.round === this.round) {
      // Players measure from their own receipt of GO, so relay latency is not counted.
      this.goAt = performance.now()
      if (this.phase === 'armed') this.setPhase('go')
    } else if (message.type === 'reaction:click' && this.activity.isHost) {
      this.record(from, message)
    }
    return true
  }

  /** Called when shared state carries a new result or the host changes. */
  sync(result: RoundResult | null): void {
    if (result && result.round >= this.round && this.phase !== 'idle') {
      this.reset()
    }
  }

  /** The host left mid-round: nobody will finish it. */
  reset(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.goAt = 0
    this.clicks.clear()
    this.setPhase('idle')
  }

  dispose(): void {
    clearTimeout(this.timer)
  }

  private record(userId: string, intent: { round: number; ms: number | null }): void {
    if (intent.round !== this.round || this.clicks.has(userId)) return
    const ms = typeof intent.ms === 'number' && intent.ms >= 0 ? intent.ms : null
    this.clicks.set(userId, ms)
    const everyone = this.activity.participants.every((p) => this.clicks.has(p.id))
    if (everyone && this.timer !== undefined && this.phaseAllowsFinish()) {
      clearTimeout(this.timer)
      void this.finish()
    }
  }

  private phaseAllowsFinish(): boolean {
    // Everyone false-started before GO, or GO was already sent.
    return this.goAt > 0 || [...this.clicks.values()].every((ms) => ms === null)
  }

  private async finish(): Promise<void> {
    if (!this.activity.isHost) return
    this.timer = undefined
    const times = [...this.clicks]
      .filter((entry): entry is [string, number] => entry[1] !== null)
      .map(([userId, ms]) => ({ userId, ms }))
      .sort((a, b) => a.ms - b.ms)
    const result: RoundResult = {
      round: this.round,
      hostId: this.activity.user.id,
      finishedAt: new Date().toISOString(),
      times,
      falseStarts: [...this.clicks].filter(([, ms]) => ms === null).map(([id]) => id),
      winnerId: times[0]?.userId ?? null,
    }
    this.goAt = 0
    this.clicks.clear()
    try {
      await this.activity.updateState((current) =>
        toJson({ ...readLabState(current), reaction: result }),
      )
    } catch (error) {
      this.onError(error)
    }
    this.setPhase('idle')
  }

  private broadcast(message: ReactionMessage): void {
    this.activity.send(message).catch(this.onError)
  }

  private setPhase(phase: ReactionPhase): void {
    this.phase = phase
    this.onChange()
  }
}
