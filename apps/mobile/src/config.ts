/** Dev builds talk to the nightly backend; release builds target production only. */
const HOST = __DEV__ ? 'beta.syrnike13.ru' : 'syrnike13.ru'

export const API_URL = `https://${HOST}/api`
export const WS_URL = `wss://${HOST}/ws`
/** Sessions are per backend, so switching builds never reuses a foreign token. */
export const SESSION_KEY = `session.${HOST}`
