import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect, Option, Schema } from 'effect'

import { config } from '#/lib/config'

export type ApiErrorCode =
  | 'http'
  | 'network'
  | 'read'
  | 'contract'
  | 'email-taken'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
    readonly code: ApiErrorCode = 'http',
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export class ApiNetworkError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
    readonly code: ApiErrorCode = 'network',
  ) {
    super(message)
    this.name = 'ApiNetworkError'
  }
}

class ApiResponseReadError extends Error {
  constructor(readonly cause: unknown) {
    super('Failed to read API response')
    this.name = 'ApiResponseReadError'
  }
}

/** Stable code for mapping API failures to localized UI copy. */
export function apiErrorCode(error: unknown): ApiErrorCode | null {
  return error instanceof ApiError || error instanceof ApiNetworkError
    ? error.code
    : null
}

export type ApiRequestOptions = Omit<RequestInit, 'body'> & {
  body?: unknown
  token?: string | null
}

type ApiRequestEffectOptions = Omit<ApiRequestOptions, 'signal'>

type MutableResponse<T> = T extends ReadonlyArray<infer Item>
  ? Array<MutableResponse<Item>>
  : T extends object
    ? { -readonly [Key in keyof T]: MutableResponse<T[Key]> }
    : T

function mutableResponseSchema<
  ResponseSchema extends Schema.ConstraintDecoder<unknown, never>,
>(responseSchema: ResponseSchema) {
  const isResponse = Schema.is(responseSchema)
  return Schema.declare<MutableResponse<ResponseSchema['Type']>>(
    (input): input is MutableResponse<ResponseSchema['Type']> =>
      isResponse(input),
  )
}

/**
 * Минимальный HTTP-клиент к syrnike13 API.
 * Позже сюда добавим WebSocket и типы из @syrnike13/api-types.
 */
export const apiRequestEffect = Effect.fn('api.request')(
  function*<
    ResponseSchema extends Schema.ConstraintDecoder<unknown, never>,
  >(
    path: string,
    responseSchema: ResponseSchema,
    options: ApiRequestEffectOptions = {},
  ) {
    const { body, token, headers: initHeaders, ...init } = options
    const headers = new Headers(initHeaders)

    if (body !== undefined && !headers.has('Content-Type')) {
      headers.set(
        'Content-Type',
        body instanceof Blob ? body.type : 'application/json',
      )
    }

    if (token) {
      headers.set('X-Session-Token', token)
    }

    const { response, text } = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(`${config.apiUrl}${path}`, {
          ...init,
          headers,
          body:
            body === undefined
              ? undefined
              : body instanceof Blob
                ? body
                : JSON.stringify(body),
          signal,
        })
        try {
          return { response, text: await response.text() }
        } catch (cause) {
          throw new ApiResponseReadError(cause)
        }
      },
      catch: (cause) =>
        cause instanceof ApiResponseReadError
          ? new ApiNetworkError('Could not read the API response', cause.cause, 'read')
          : new ApiNetworkError('Could not reach the API', cause, 'network'),
    })
    const contentType = response.headers.get('Content-Type') ?? ''

    if (!response.ok) {
      const parsed =
        text && contentType.includes('application/json')
          ? Option.getOrElse(
              Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(
                text,
              ),
              () => text,
            )
          : text || undefined
      let message = response.statusText || `HTTP ${response.status}`

      if (typeof parsed === 'object' && parsed !== null) {
        if ('type' in parsed && typeof parsed.type === 'string') {
          message = parsed.type

          if (
            parsed.type === 'IncorrectData' &&
            'with' in parsed &&
            parsed.with === 'email'
          ) {
            message = 'An account with this email already exists'
          }
        } else if (
          'message' in parsed &&
          typeof parsed.message === 'string'
        ) {
          message = parsed.message
        }
      } else if (text) {
        message = text
      }

      return yield* Effect.fail(
        new ApiError(
          message,
          response.status,
          parsed ?? text,
          typeof parsed === 'object' &&
            parsed !== null &&
            'type' in parsed &&
            parsed.type === 'IncorrectData' &&
            'with' in parsed &&
            parsed.with === 'email'
            ? 'email-taken'
            : 'http',
        ),
      )
    }

    const decodedResponseSchema = mutableResponseSchema(responseSchema)
    const decodeResponse =
      text && contentType.includes('application/json')
        ? Schema.decodeUnknownEffect(
            Schema.fromJsonString(decodedResponseSchema),
          )(text)
        : Schema.decodeUnknownEffect(decodedResponseSchema)(undefined)

    return yield* decodeResponse.pipe(
      Effect.mapError(
        () =>
          new ApiError(
            'The API response does not match the contract',
            response.status,
            text || undefined,
            'contract',
          ),
      ),
    )
  },
)

export function apiRequest<
  ResponseSchema extends Schema.ConstraintDecoder<unknown, never>,
>(
  path: string,
  responseSchema: ResponseSchema,
  options: ApiRequestOptions = {},
): Promise<MutableResponse<ResponseSchema['Type']>> {
  const { signal, ...effectOptions } = options
  return Effect.runPromise(
    apiRequestEffect(path, responseSchema, effectOptions),
    signal ? { signal } : undefined,
  )
}

export function apiBlobRequest(path: string, options: ApiRequestOptions = {}) {
  const { signal, token, headers: initHeaders, ...init } = options
  const headers = new Headers(initHeaders)
  if (token) headers.set('X-Session-Token', token)
  return Effect.runPromise(
    Effect.gen(function* () {
      const { response, blob } = yield* Effect.tryPromise({
        try: async (requestSignal) => {
          const response = await fetch(`${config.apiUrl}${path}`, {
            ...init,
            body: undefined,
            headers,
            signal: requestSignal,
          })
          try {
            return {
              response,
              blob: response.ok ? await response.blob() : null,
            }
          } catch (cause) {
            throw new ApiResponseReadError(cause)
          }
        },
        catch: (cause) =>
          cause instanceof ApiResponseReadError
            ? new ApiNetworkError('Could not read the API response', cause.cause, 'read')
            : new ApiNetworkError('Could not reach the API', cause, 'network'),
      })
      if (response.status === 404) return null
      if (!response.ok) {
        return yield* Effect.fail(
          new ApiError(response.statusText, response.status),
        )
      }
      return blob
    }),
    signal ? { signal } : undefined,
  )
}

/** GET / — проверка доступности API. */
export const fetchApiRootEffect = Effect.fn('api.fetchRoot')(function*() {
  return yield* apiRequestEffect('/', ApiSchema.RootRoot200)
})

export function fetchApiRoot(signal?: AbortSignal) {
  return Effect.runPromise(
    fetchApiRootEffect(),
    signal ? { signal } : undefined,
  )
}
