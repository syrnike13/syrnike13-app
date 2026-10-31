/**
 * UUID v4 that also works outside secure contexts.
 *
 * `crypto.randomUUID` is only exposed on HTTPS and `localhost`; opening the dev
 * server over a LAN address or embedding the app in an insecure context makes
 * it `undefined`. `crypto.getRandomValues` stays available there, so the
 * fallback still produces a random v4 identifier.
 */
export function randomUuid(): string {
  const webCrypto = globalThis.crypto as Crypto | undefined
  if (typeof webCrypto?.randomUUID === 'function') {
    return webCrypto.randomUUID()
  }

  const bytes = new Uint8Array(16)
  if (typeof webCrypto?.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-')
}
