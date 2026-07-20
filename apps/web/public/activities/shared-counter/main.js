const activity = window.syrnikeActivity

const count = document.querySelector('#count')
const participants = document.querySelector('#participants')
const revision = document.querySelector('#revision')

activity.subscribe((snapshot) => {
  const value = Number(snapshot?.state?.count)
  count.textContent = Number.isFinite(value) ? String(value) : '0'
  const participantCount = snapshot?.participant_ids?.length ?? 0
  participants.textContent = `Участников: ${participantCount}`
  revision.textContent = `Серверная ревизия: ${snapshot?.revision ?? 0}`
})

document.querySelector('#increment').addEventListener('click', () => {
  activity.command({ type: 'increment' })
})

document.querySelector('#decrement').addEventListener('click', () => {
  activity.command({ type: 'decrement' })
})
