import { config } from '#/lib/config'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export type ApiRequestOptions = Omit<RequestInit, 'body'> & {
  body?: unknown
  token?: string | null
}

/**
 * Минимальный HTTP-клиент к syrnike13 API.
 * Позже сюда добавим WebSocket и типы из @syrnike13/api-types.
 */
export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const { body, token, headers: initHeaders, ...init } = options
  const headers = new Headers(initHeaders)

  if (body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  if (token) {
    headers.set('X-Session-Token', token)
  }

  const response = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (response.status === 204) {
    return undefined as T
  }

  const text = await response.text()
  const contentType = response.headers.get('Content-Type') ?? ''
  const parsed =
    text && contentType.includes('application/json')
      ? (JSON.parse(text) as unknown)
      : undefined

  if (!response.ok) {
    let message = response.statusText || `HTTP ${response.status}`

    if (typeof parsed === 'object' && parsed !== null) {
      if ('type' in parsed && typeof parsed.type === 'string') {
        message = parsed.type
      } else if (
        'message' in parsed &&
          typeof parsed.message === 'string'
      ) {
        message = parsed.message
      }
    } else if (text) {
      message = text
    }

    throw new ApiError(message, response.status, parsed ?? text)
  }

  return parsed as T
}

/** GET / — проверка доступности API. */
export function fetchApiRoot() {
  return apiRequest<{ syrnike?: string }>('/')
}
