import { Effect, Option, Schema } from 'effect'

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

export class ApiNetworkError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
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

export const apiRequestEffect = Effect.fn('admin.api.request')(
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
      headers.set('Content-Type', 'application/json')
    }

    if (token) {
      headers.set('X-Session-Token', token)
    }

    const { response, text } = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(`${config.apiUrl}${path}`, {
          ...init,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
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
          ? new ApiNetworkError(
              'Не удалось прочитать ответ API',
              cause.cause,
            )
          : new ApiNetworkError('Не удалось подключиться к API', cause),
    })
    const contentType = response.headers.get('Content-Type') ?? ''
    const parsed =
      text && contentType.includes('application/json')
        ? Option.getOrElse(
            Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(
              text,
            ),
            () => text,
          )
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

      return yield* Effect.fail(
        new ApiError(message, response.status, parsed ?? text),
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
            'API вернул ответ, не соответствующий контракту',
            response.status,
            text || undefined,
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
