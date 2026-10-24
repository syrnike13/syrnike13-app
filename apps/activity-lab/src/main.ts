import './style.css'

import {
  ActivityError,
  connect,
  type Activity,
  type ActivityParticipant,
  type EndReason,
  type JsonValue,
  type Leaderboard,
  type PlayerData,
  type SharedState,
} from '@syrnike13/activity-sdk'

import { h } from './dom'
import { translator, type Translate } from './i18n'
import { readLabState, toJson, type LabState, type RoundResult } from './lab-state'
import { ReactionGame } from './reaction'

const SCORE_REACTION = 'reaction-ms'
const SCORE_WINS = 'wins'
const EXTERNAL_LINK = 'https://syrnike13.ru'
const LOG_SIZE = 30

const root = document.getElementById('app') as HTMLElement

void main()

async function main(): Promise<void> {
  const t = translator(navigator.language)
  root.replaceChildren(h('p', { class: 'screen' }, t('connecting')))
  try {
    const activity = await connect()
    new Lab(activity).mount()
  } catch (error) {
    const unsupported = error instanceof ActivityError && error.code === 'unsupported'
    root.replaceChildren(
      h(
        'p',
        { class: 'screen' },
        unsupported ? t('unsupported') : t('connectFailed', { error: describe(error) }),
      ),
    )
  }
}

class Lab {
  private t: Translate
  private readonly game: ReactionGame
  private readonly log: { from: string; payload: JsonValue; at: Date }[] = []
  private target = ''
  private status = ''
  private boards: Record<string, Leaderboard | null> = { [SCORE_REACTION]: null, [SCORE_WINS]: null }
  private player: PlayerData | null = null
  private readonly processedRounds = new Set<string>()

  // Shared note with explicit compare-and-set.
  private noteBase: SharedState
  private noteDirty = false
  private noteStatus = ''
  private noteConflict = false
  private hostId: string

  // Persistent elements; boxes are re-rendered, the textarea keeps focus.
  private readonly header = h('header', { class: 'header' })
  private readonly participantsBox = h('section', { class: 'card' })
  private readonly messagesBox = h('section', { class: 'card' })
  private readonly stateTop = h('div')
  private readonly noteInput = h('textarea', { rows: 3, maxLength: 2000 })
  private readonly noteBox = h('div')
  private readonly reactionBox = h('section', { class: 'card reaction' })
  private readonly boardsBox = h('section', { class: 'card' })
  private readonly playerBox = h('section', { class: 'card' })
  private readonly platformBox = h('section', { class: 'card' })

  constructor(private readonly activity: Activity) {
    this.t = translator(activity.locale)
    this.hostId = activity.hostId
    this.noteBase = activity.state
    this.noteInput.value = readLabState(activity.state.data).note
    this.noteInput.addEventListener('input', () => {
      this.noteDirty = true
      this.renderNote()
    })
    this.game = new ReactionGame(
      activity,
      () => this.renderReaction(),
      (error) => this.fail(error),
    )
  }

  mount(): void {
    const activity = this.activity
    activity.applyTheme()
    root.replaceChildren(
      this.header,
      h(
        'main',
        { class: 'grid' },
        this.reactionBox,
        this.participantsBox,
        this.messagesBox,
        h('section', { class: 'card' }, this.stateTop, this.noteInput, this.noteBox),
        this.boardsBox,
        this.playerBox,
        this.platformBox,
      ),
    )

    activity.on('participants', () => {
      if (!activity.participants.some((p) => p.id === this.target)) this.target = ''
      // A new host never finishes the previous host's round.
      if (activity.hostId !== this.hostId) this.game.reset()
      this.hostId = activity.hostId
      this.render()
    })
    activity.on('message', ({ from, payload }) => {
      this.log.unshift({ from, payload, at: new Date() })
      this.log.length = Math.min(this.log.length, LOG_SIZE)
      this.game.handleMessage(from, payload)
      this.renderMessages()
    })
    activity.on('state', (state) => this.onState(state))
    activity.on('locale', ({ locale }) => {
      this.t = translator(locale)
      this.render()
    })
    activity.on('layout', () => this.render())
    activity.on('connection', () => this.renderHeader())
    activity.on('ended', ({ reason }) => this.showEnded(reason))

    this.render()
    this.onState(activity.state)
    void this.refreshBoards()
    void this.refreshPlayer()
  }

  // -------------------------------------------------------------------------
  // State

  private onState(state: SharedState): void {
    const lab = readLabState(state.data)
    if (!this.noteDirty) {
      this.noteInput.value = lab.note
      this.noteBase = state
    }
    this.game.sync(lab.reaction)
    if (lab.reaction) void this.recordResult(lab.reaction)
    this.renderState()
    this.renderNote()
    this.renderReaction()
  }

  private async increment(): Promise<void> {
    try {
      await this.activity.updateState((current) => {
        const lab = readLabState(current)
        return toJson({ ...lab, counter: lab.counter + 1 })
      })
    } catch (error) {
      this.fail(error)
    }
  }

  private async saveNote(): Promise<void> {
    const base = this.noteBase
    const next: LabState = { ...readLabState(base.data), note: this.noteInput.value }
    try {
      const result = await this.activity.setState(toJson(next), base.version)
      this.noteConflict = !result.ok
      if (result.ok) {
        this.noteDirty = false
        this.noteBase = result.state
        this.noteStatus = this.t('noteSaved', { version: result.state.version })
      } else {
        this.noteStatus = this.t('noteConflict', { version: result.state.version })
      }
    } catch (error) {
      this.fail(error)
    }
    this.renderNote()
  }

  private loadLatestNote(): void {
    this.noteBase = this.activity.state
    this.noteInput.value = readLabState(this.noteBase.data).note
    this.noteDirty = false
    this.noteStatus = ''
    this.noteConflict = false
    this.renderNote()
  }

  /**
   * Each player records their own result once per round. Player data remembers
   * the last processed round, so reloaded frames do not count it twice.
   */
  private async recordResult(result: RoundResult): Promise<void> {
    const me = this.activity.user.id
    const roundKey = `${this.activity.context.instance.id}:${result.round}`
    const mine = result.times.find((entry) => entry.userId === me)
    if (!mine && !result.falseStarts.includes(me)) return
    if (this.processedRounds.has(roundKey)) return
    this.processedRounds.add(roundKey)
    try {
      const current = await this.activity.playerData.get()
      if (current.data.lastRound === roundKey) {
        this.player = current
        this.renderPlayer()
        return
      }
      const won = result.winnerId === me
      const wins = numberOr(current.data.wins, 0) + (won ? 1 : 0)
      this.player = await this.activity.playerData.set({
        ...current.data,
        roundsPlayed: numberOr(current.data.roundsPlayed, 0) + 1,
        wins,
        lastRound: roundKey,
      })
      this.renderPlayer()
      if (mine) await this.activity.scores.submit(SCORE_REACTION, mine.ms, 'min')
      if (won) await this.activity.scores.submit(SCORE_WINS, wins, 'max')
      await this.refreshBoards()
    } catch (error) {
      this.fail(error)
    }
  }

  private async refreshBoards(): Promise<void> {
    try {
      const [reaction, wins] = await Promise.all([
        this.activity.scores.leaderboard(SCORE_REACTION, { ascending: true, limit: 10 }),
        this.activity.scores.leaderboard(SCORE_WINS, { limit: 10 }),
      ])
      this.boards = { [SCORE_REACTION]: reaction, [SCORE_WINS]: wins }
    } catch (error) {
      this.fail(error)
    }
    this.renderBoards()
  }

  private async refreshPlayer(): Promise<void> {
    try {
      this.player = await this.activity.playerData.get()
    } catch (error) {
      this.fail(error)
    }
    this.renderPlayer()
  }

  private async platformAction(action: () => Promise<string | void>): Promise<void> {
    try {
      const message = await action()
      if (message) this.status = message
    } catch (error) {
      this.fail(error)
      return
    }
    this.renderPlatform()
  }

  private fail(error: unknown): void {
    this.status = this.t('error', { error: describe(error) })
    this.renderPlatform()
  }

  private showEnded(reason: EndReason): void {
    this.game.dispose()
    root.replaceChildren(
      h(
        'div',
        { class: 'screen' },
        h('h1', {}, this.t('ended')),
        h('p', { class: 'muted' }, this.t('endedReason', { reason })),
      ),
    )
  }

  // -------------------------------------------------------------------------
  // Rendering

  private render(): void {
    document.documentElement.lang = this.activity.locale
    document.body.dataset.layout = this.activity.layout
    this.renderHeader()
    this.renderParticipants()
    this.renderMessages()
    this.renderState()
    this.renderNote()
    this.renderReaction()
    this.renderBoards()
    this.renderPlayer()
    this.renderPlatform()
  }

  private renderHeader(): void {
    const { activity, t } = this
    const online = activity.connection === 'connected'
    this.header.replaceChildren(
      h('h1', {}, activity.context.application.name),
      h(
        'span',
        { class: online ? 'pill ok' : 'pill warn' },
        online ? t('connected') : t('reconnecting'),
      ),
      h('span', { class: 'pill' }, t('layout', { layout: activity.layout })),
      activity.isHost && h('span', { class: 'pill accent' }, t('host')),
    )
  }

  private renderParticipants(): void {
    const { activity, t } = this
    this.participantsBox.replaceChildren(
      h('h2', {}, t('participants', { count: activity.participants.length })),
      h(
        'ul',
        { class: 'people' },
        ...activity.participants.map((p) =>
          h(
            'li',
            {},
            avatar(p),
            h('span', { class: 'grow' }, p.displayName),
            p.id === activity.user.id && h('span', { class: 'muted' }, t('you')),
            p.id === activity.hostId && h('span', { class: 'pill accent' }, t('host')),
          ),
        ),
      ),
    )
  }

  private renderMessages(): void {
    const { activity, t } = this
    const others = activity.participants.filter((p) => p.id !== activity.user.id)
    if (!others.some((p) => p.id === this.target)) this.target = others[0]?.id ?? ''
    const ping = (to?: string[]) =>
      activity
        .send({ type: 'ping', text: `ping from ${activity.user.displayName}` }, { to })
        .catch((error: unknown) => this.fail(error))
    this.messagesBox.replaceChildren(
      h('h2', {}, t('messages')),
      h(
        'div',
        { class: 'row' },
        h('button', { onclick: () => ping() }, t('pingAll')),
        others.length > 0
          ? h(
              'select',
              {
                onchange: (event: Event) => {
                  this.target = (event.target as HTMLSelectElement).value
                },
              },
              ...others.map((p) =>
                h('option', { value: p.id, selected: p.id === this.target }, p.displayName),
              ),
            )
          : h('span', { class: 'muted' }, t('noOneElse')),
        h(
          'button',
          { disabled: !this.target, onclick: () => ping([this.target]) },
          t('pingSelected'),
        ),
      ),
      h('h3', {}, t('messageLog')),
      this.log.length === 0
        ? h('p', { class: 'muted' }, t('noMessages'))
        : h(
            'ol',
            { class: 'log' },
            ...this.log.map((entry) =>
              h(
                'li',
                {},
                h('time', { class: 'muted' }, entry.at.toLocaleTimeString(activity.locale)),
                ' ',
                t('pingFrom', {
                  name: this.nameOf(entry.from),
                  payload: JSON.stringify(entry.payload),
                }),
              ),
            ),
          ),
    )
  }

  private renderState(): void {
    const { activity, t } = this
    const state = activity.state
    this.stateTop.replaceChildren(
      h('h2', {}, t('sharedState')),
      h(
        'p',
        { class: 'muted' },
        state.version === 0
          ? t('stateEmpty')
          : t('stateVersion', { version: state.version, name: this.nameOf(state.updatedBy) }),
      ),
      h(
        'div',
        { class: 'row' },
        h('span', {}, t('counter')),
        h('strong', { class: 'counter' }, readLabState(state.data).counter),
        h('button', { onclick: () => void this.increment() }, t('increment')),
      ),
      h('h3', {}, t('note')),
    )
  }

  private renderNote(): void {
    const { activity, t } = this
    this.noteInput.placeholder = t('notePlaceholder')
    const newer = activity.state.version > this.noteBase.version
    this.noteBox.replaceChildren(
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          { class: 'primary', onclick: () => void this.saveNote() },
          t('saveNote', { version: this.noteBase.version }),
        ),
        h('button', { disabled: !newer, onclick: () => this.loadLatestNote() }, t('loadLatest')),
      ),
      this.noteStatus && h('p', { class: this.noteConflict ? 'danger' : 'muted' }, this.noteStatus),
      !this.noteStatus &&
        newer &&
        h('p', { class: 'muted' }, t('noteRemote', { version: activity.state.version })),
    )
  }

  private renderReaction(): void {
    const { activity, game, t } = this
    const last = readLabState(activity.state.data).reaction
    let stage: HTMLElement
    switch (game.phase) {
      case 'armed':
        stage = h('button', { class: 'stage wait', onpointerdown: () => game.click() }, t('wait'))
        break
      case 'go':
        stage = h('button', { class: 'stage go', onpointerdown: () => game.click() }, t('go'))
        break
      case 'clicked':
        stage = h(
          'div',
          { class: 'stage' },
          game.myMs === null ? t('falseStart') : t('yourTime', { ms: game.myMs }),
          h('small', { class: 'muted' }, t('waitingResults')),
        )
        break
      default:
        stage = activity.isHost
          ? h('button', { class: 'stage primary', onclick: () => game.start() }, t('start'))
          : h('div', { class: 'stage muted' }, t('waitHost'))
    }
    this.reactionBox.replaceChildren(
      h('h2', {}, t('reaction')),
      h('p', { class: 'muted hint' }, t('reactionHint')),
      stage,
      last && this.renderResult(last),
    )
  }

  private renderResult(result: RoundResult): HTMLElement {
    const { t } = this
    return h(
      'div',
      { class: 'result' },
      h('h3', {}, t('lastRound', { round: result.round })),
      h(
        'p',
        {},
        result.winnerId
          ? t('winner', { name: this.nameOf(result.winnerId) })
          : t('noWinner'),
      ),
      h(
        'ol',
        {},
        ...result.times.map((entry) => h('li', {}, `${this.nameOf(entry.userId)} — ${entry.ms} ms`)),
      ),
      result.falseStarts.length > 0 &&
        h(
          'p',
          { class: 'muted' },
          t('falseStarts', { names: result.falseStarts.map((id) => this.nameOf(id)).join(', ') }),
        ),
    )
  }

  private renderBoards(): void {
    const { t } = this
    const board = (title: string, key: string) => {
      const value = this.boards[key]
      const entries = value?.entries ?? []
      return h(
        'div',
        {},
        h('h3', {}, title),
        entries.length === 0
          ? h('p', { class: 'muted' }, t('empty'))
          : h(
              'ol',
              { class: 'board' },
              ...entries.map((score) =>
                h(
                  'li',
                  { class: score.user.id === this.activity.user.id ? 'own' : undefined },
                  h('span', { class: 'grow' }, score.user.displayName),
                  h('strong', {}, score.value),
                  !score.trusted && h('span', { class: 'pill warn' }, t('untrusted')),
                ),
              ),
            ),
      )
    }
    this.boardsBox.replaceChildren(
      h(
        'div',
        { class: 'row' },
        h('h2', { class: 'grow' }, t('leaderboards')),
        h('button', { onclick: () => void this.refreshBoards() }, t('refresh')),
      ),
      board(t('bestReaction'), SCORE_REACTION),
      board(t('wins'), SCORE_WINS),
    )
  }

  private renderPlayer(): void {
    const { t } = this
    const data = this.player?.data ?? {}
    this.playerBox.replaceChildren(
      h(
        'div',
        { class: 'row' },
        h('h2', { class: 'grow' }, t('playerData')),
        this.player && !this.player.trusted && h('span', { class: 'pill warn' }, t('untrusted')),
        h('button', { onclick: () => void this.refreshPlayer() }, t('refresh')),
      ),
      h('p', {}, t('roundsPlayed', { count: numberOr(data.roundsPlayed, 0) })),
      h('pre', {}, JSON.stringify(this.player, null, 2)),
    )
  }

  private renderPlatform(): void {
    const { activity, t } = this
    this.platformBox.replaceChildren(
      h('h2', {}, t('platform')),
      h(
        'div',
        { class: 'row wrap' },
        h(
          'button',
          {
            onclick: () =>
              void this.platformAction(async () => {
                const { code } = await activity.authorize(['identify', 'storage'])
                return t('authorizeCode', { code })
              }),
          },
          t('authorize'),
        ),
        h(
          'button',
          {
            onclick: () =>
              void this.platformAction(async () =>
                (await activity.openExternalLink(EXTERNAL_LINK))
                  ? t('linkOpened')
                  : t('linkNotOpened'),
              ),
          },
          t('openLink'),
        ),
        h('button', { onclick: () => void this.platformAction(() => activity.leave()) }, t('leave')),
        h(
          'button',
          {
            class: 'danger',
            disabled: !activity.isHost,
            onclick: () => void this.platformAction(() => activity.end()),
          },
          t('endForAll'),
        ),
      ),
      this.status && h('p', { class: 'status' }, this.status),
    )
  }

  private nameOf(userId: string | null): string {
    if (!userId) return '—'
    return this.activity.participants.find((p) => p.id === userId)?.displayName ?? userId
  }
}

function avatar(user: ActivityParticipant): HTMLElement {
  if (user.avatarUrl) return h('img', { class: 'avatar', src: user.avatarUrl, alt: '' })
  return h('span', { class: 'avatar' }, user.displayName.slice(0, 1).toUpperCase())
}

function numberOr(value: JsonValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function describe(error: unknown): string {
  if (error instanceof ActivityError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}
