/** Keys for the connection screen facts ("Did you know"). */
export const GATEWAY_LOADING_FACT_KEYS = [
  'facts.1',
  'facts.2',
  'facts.3',
  'facts.4',
  'facts.5',
  'facts.6',
  'facts.7',
  'facts.8',
  'facts.9',
  'facts.10',
] as const

export function pickGatewayLoadingFactKey() {
  const index = Math.floor(Math.random() * GATEWAY_LOADING_FACT_KEYS.length)
  return GATEWAY_LOADING_FACT_KEYS[index]!
}
