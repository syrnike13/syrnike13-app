const activity = window.syrnikeActivity

const elements = {
  phaseLabel: document.querySelector('#phase-label'),
  connectionDot: document.querySelector('#connection-dot'),
  connectionLabel: document.querySelector('#connection-label'),
  revision: document.querySelector('#revision'),
  participantCount: document.querySelector('#participant-count'),
  round: document.querySelector('#round'),
  hitsRemaining: document.querySelector('#hits-remaining'),
  error: document.querySelector('#error'),
  lobby: document.querySelector('#lobby'),
  lobbyPlayers: document.querySelector('#lobby-players'),
  readyButton: document.querySelector('#ready-button'),
  startButton: document.querySelector('#start-button'),
  ownerHint: document.querySelector('#owner-hint'),
  playing: document.querySelector('#playing'),
  arena: document.querySelector('#arena'),
  target: document.querySelector('#target'),
  finished: document.querySelector('#finished'),
  winner: document.querySelector('#winner'),
  resetButton: document.querySelector('#reset-button'),
  resetHint: document.querySelector('#reset-hint'),
  scoreboard: document.querySelector('#scoreboard'),
  events: document.querySelector('#events'),
}

const phaseLabels = {
  lobby: 'Лобби готовности',
  playing: 'Раунд идёт',
  finished: 'Раунд завершён',
}

const transportLabels = {
  connected: 'Realtime подключён',
  reconnecting: 'Переподключение…',
  disconnected: 'Нет соединения',
}

const errorLabels = {
  invalid_command:
    'Команда отклонена: состояние уже изменилось или не все готовы.',
  not_owner: 'Эту команду может выполнить только владелец Активности.',
  not_in_voice_channel: 'Команды доступны только из голосового канала.',
  not_participant: 'Вы больше не участник этой Активности.',
  instance_not_found: 'Сессия Активности уже завершена.',
  internal: 'Сервер не смог обработать команду.',
}

let snapshot = null
let transport = activity.getTransport()
let pendingTargetId = null
const eventLog = []

function shortUserId(userId) {
  return userId.length > 10 ? `…${userId.slice(-8)}` : userId
}

function contextUserId() {
  return activity.getContext()?.currentUserId ?? null
}

function renderList(container, rows) {
  container.replaceChildren(
    ...rows.map(({ label, value, active = false }) => {
      const item = document.createElement('li')
      if (active) item.dataset.active = 'true'
      const name = document.createElement('span')
      const detail = document.createElement('strong')
      name.textContent = label
      detail.textContent = value
      item.append(name, detail)
      return item
    }),
  )
}

function renderSnapshot(nextSnapshot, recordEvent = true) {
  snapshot = nextSnapshot
  const state = nextSnapshot?.state ?? {}
  const phase = phaseLabels[state.phase] ? state.phase : 'lobby'
  const userId = contextUserId()
  const participantIds = Array.isArray(nextSnapshot?.participant_ids)
    ? nextSnapshot.participant_ids
    : []
  const readyIds = new Set(state.ready_user_ids ?? [])
  const scores = state.scores ?? {}
  const isOwner = userId === nextSnapshot?.owner_id
  const allReady =
    participantIds.length > 0 &&
    participantIds.every((participantId) => readyIds.has(participantId))

  elements.phaseLabel.textContent = phaseLabels[phase]
  elements.revision.textContent = String(nextSnapshot?.revision ?? 0)
  elements.participantCount.textContent = String(participantIds.length)
  elements.round.textContent = String(state.round ?? 0)
  elements.hitsRemaining.textContent = String(state.hits_remaining ?? 0)

  elements.lobby.hidden = phase !== 'lobby'
  elements.playing.hidden = phase !== 'playing'
  elements.finished.hidden = phase !== 'finished'

  renderList(
    elements.lobbyPlayers,
    participantIds.map((participantId) => ({
      label: shortUserId(participantId),
      value: readyIds.has(participantId) ? 'готов' : 'ожидаем',
      active: participantId === userId,
    })),
  )

  elements.readyButton.textContent = readyIds.has(userId)
    ? 'Отменить готовность'
    : 'Я готов'
  elements.readyButton.disabled = transport !== 'connected'
  elements.startButton.disabled =
    transport !== 'connected' || !isOwner || !allReady
  elements.ownerHint.textContent = isOwner
    ? allReady
      ? 'Все готовы — можно начинать.'
      : 'Запуск станет доступен, когда будут готовы все участники.'
    : `Раунд запускает владелец ${shortUserId(nextSnapshot?.owner_id ?? '')}.`

  const target = state.target
  const hasTarget =
    phase === 'playing' &&
    Number.isSafeInteger(target?.id) &&
    Number.isFinite(target?.x) &&
    Number.isFinite(target?.y)
  elements.target.hidden = !hasTarget
  if (hasTarget) {
    if (pendingTargetId !== target.id) pendingTargetId = null
    elements.target.style.left = `${target.x}%`
    elements.target.style.top = `${target.y}%`
    elements.target.disabled =
      transport !== 'connected' || pendingTargetId === target.id
    elements.target.dataset.targetId = String(target.id)
  }

  const scoreRows = Object.entries(scores)
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .map(([participantId, score]) => ({
      label: shortUserId(participantId),
      value: String(score),
      active: participantId === userId,
    }))
  renderList(elements.scoreboard, scoreRows)

  const bestScore = Math.max(0, ...Object.values(scores))
  const winners = Object.entries(scores)
    .filter(([, score]) => score === bestScore)
    .map(([participantId]) => shortUserId(participantId))
  elements.winner.textContent = winners.length
    ? `Победитель: ${winners.join(', ')}`
    : 'Раунд завершён'
  elements.resetButton.disabled = transport !== 'connected' || !isOwner
  elements.resetHint.textContent = isOwner
    ? 'Вы можете открыть следующее лобби.'
    : 'Новое лобби открывает текущий владелец Активности.'

  if (recordEvent) {
    const targetLabel = hasTarget ? `цель ${target.id}` : phaseLabels[phase]
    eventLog.unshift(`rev ${nextSnapshot.revision}: ${targetLabel}`)
    eventLog.splice(8)
  }
  elements.events.replaceChildren(
    ...eventLog.map((entry) => {
      const item = document.createElement('li')
      item.textContent = entry
      return item
    }),
  )
}

function renderTransport(nextTransport) {
  transport = nextTransport
  elements.connectionLabel.textContent =
    transportLabels[nextTransport] ?? transportLabels.disconnected
  elements.connectionDot.dataset.state = nextTransport
  if (snapshot) renderSnapshot(snapshot, false)
}

function renderError(error) {
  elements.error.hidden = !error
  elements.error.textContent = error
    ? (errorLabels[error] ?? `Команда отклонена: ${error}`)
    : ''
}

elements.readyButton.addEventListener('click', () => {
  activity.command({ type: 'toggle_ready' })
})

elements.startButton.addEventListener('click', () => {
  activity.command({ type: 'start_round' })
})

elements.target.addEventListener('click', () => {
  const targetId = Number(elements.target.dataset.targetId)
  if (!Number.isSafeInteger(targetId) || pendingTargetId === targetId) return
  pendingTargetId = targetId
  elements.target.disabled = true
  activity.command({ type: 'hit_target', target_id: targetId })
})

elements.resetButton.addEventListener('click', () => {
  activity.command({ type: 'reset_lobby' })
})

activity.subscribe(renderSnapshot)
activity.subscribeError(renderError)
activity.subscribeTransport(renderTransport)
