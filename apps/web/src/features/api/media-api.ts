import { config } from '#/lib/config'

export type UploadProgressHandler = (progress: number) => void

export function uploadAttachment(
  token: string,
  file: File,
  onProgress?: UploadProgressHandler,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = new FormData()
    body.set('file', file)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${config.mediaUrl}/attachments`, true)
    xhr.setRequestHeader('X-Session-Token', token)
    xhr.responseType = 'json'

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded / event.total)
      }
    })

    xhr.addEventListener('loadend', () => {
      if (xhr.readyState === 4 && xhr.status >= 200 && xhr.status < 300) {
        const response = xhr.response as { id?: string }
        if (response?.id) {
          resolve(response.id)
          return
        }
      }
      reject(new Error('Не удалось загрузить файл'))
    })

    xhr.addEventListener('error', () => {
      reject(new Error('Ошибка сети при загрузке'))
    })

    xhr.send(body)
  })
}

export type MediaUploadTag = 'avatars' | 'backgrounds'

export function uploadMediaFile(
  token: string,
  tag: MediaUploadTag,
  file: File,
  onProgress?: UploadProgressHandler,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = new FormData()
    body.set('file', file)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${config.mediaUrl}/${tag}`, true)
    xhr.setRequestHeader('X-Session-Token', token)
    xhr.responseType = 'json'

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded / event.total)
      }
    })

    xhr.addEventListener('loadend', () => {
      if (xhr.readyState === 4 && xhr.status >= 200 && xhr.status < 300) {
        const response = xhr.response as { id?: string }
        if (response?.id) {
          resolve(response.id)
          return
        }
      }
      reject(new Error('Не удалось загрузить файл'))
    })

    xhr.addEventListener('error', () => {
      reject(new Error('Ошибка сети при загрузке'))
    })

    xhr.send(body)
  })
}

export function uploadEmoji(token: string, file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = new FormData()
    body.set('file', file)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${config.mediaUrl}/emojis`, true)
    xhr.setRequestHeader('X-Session-Token', token)
    xhr.responseType = 'json'

    xhr.addEventListener('loadend', () => {
      if (xhr.readyState === 4 && xhr.status >= 200 && xhr.status < 300) {
        const response = xhr.response as { id?: string }
        if (response?.id) {
          resolve(response.id)
          return
        }
      }
      reject(new Error('Не удалось загрузить emoji'))
    })

    xhr.addEventListener('error', () => {
      reject(new Error('Ошибка сети при загрузке'))
    })

    xhr.send(body)
  })
}
