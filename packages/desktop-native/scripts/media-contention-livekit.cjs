const LIVEKIT_PARTICIPANT_EPOCHS = 16
const JOIN_TOKEN_TIMEOUT_MS = 20_000

function parseLiveKitJoinToken(output) {
  const match = String(output).match(/(?:^|\r?\n)Token:\s+(\S+)/)
  if (!match) throw new Error('local LiveKit join token was not emitted')
  return match[1]
}

function liveKitParticipantIdentities(epoch) {
  return {
    publisherIdentity: `contention-publisher-${epoch}`,
    viewerIdentity: `contention-viewer-${epoch}`,
  }
}

function validateLiveKitSession(session) {
  if (typeof session?.roomName !== 'string' || !session.roomName) {
    throw new Error('LiveKit session is missing a room name')
  }
  if (!Array.isArray(session.participants) ||
      session.participants.length !== LIVEKIT_PARTICIPANT_EPOCHS) {
    throw new Error('LiveKit session must contain 16 participant epochs')
  }
  for (const [index, participant] of session.participants.entries()) {
    const expected = liveKitParticipantIdentities(index + 1)
    if (participant?.publisherIdentity !== expected.publisherIdentity ||
        participant?.viewerIdentity !== expected.viewerIdentity ||
        typeof participant.publisherToken !== 'string' ||
        !participant.publisherToken ||
        typeof participant.viewerToken !== 'string' ||
        !participant.viewerToken) {
      throw new Error(`LiveKit session epoch ${index + 1} is invalid`)
    }
  }
  return {
    roomName: session.roomName,
    participants: session.participants.map((participant) => ({
      publisherIdentity: participant.publisherIdentity,
      publisherToken: participant.publisherToken,
      viewerIdentity: participant.viewerIdentity,
      viewerToken: participant.viewerToken,
    })),
  }
}

function loadLiveKitSession(raw) {
  return validateLiveKitSession(
    typeof raw === 'string' ? JSON.parse(raw) : raw,
  )
}

async function mintLocalLiveKitSession(liveKitServerExecutable, options = {}) {
  const runChild = options.runChild
  if (typeof runChild !== 'function') {
    throw new Error('mintLocalLiveKitSession requires runChild')
  }
  if (typeof liveKitServerExecutable !== 'string' || !liveKitServerExecutable) {
    throw new Error('LiveKit server executable is required to mint tokens')
  }
  const roomName = options.roomName ??
    `issue83-${process.pid}-${Date.now()}`
  const timeoutMs = Number.isSafeInteger(options.timeoutMs)
    ? options.timeoutMs
    : JOIN_TOKEN_TIMEOUT_MS
  const participants = []
  for (let epoch = 1; epoch <= LIVEKIT_PARTICIPANT_EPOCHS; epoch += 1) {
    const identities = liveKitParticipantIdentities(epoch)
    const mint = async (identity) => parseLiveKitJoinToken((
      await runChild(
        liveKitServerExecutable,
        [
          '--dev',
          'create-join-token',
          '--room',
          roomName,
          '--identity',
          identity,
        ],
        timeoutMs,
      )
    ).stdout)
    participants.push({
      ...identities,
      publisherToken: await mint(identities.publisherIdentity),
      viewerToken: await mint(identities.viewerIdentity),
    })
  }
  return validateLiveKitSession({ roomName, participants })
}

module.exports = {
  JOIN_TOKEN_TIMEOUT_MS,
  LIVEKIT_PARTICIPANT_EPOCHS,
  loadLiveKitSession,
  liveKitParticipantIdentities,
  mintLocalLiveKitSession,
  parseLiveKitJoinToken,
  validateLiveKitSession,
}
