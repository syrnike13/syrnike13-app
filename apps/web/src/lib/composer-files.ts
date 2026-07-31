export type PendingComposerFile = {
  id: string
  file: File
  previewUrl?: string
  attachmentId?: string
  progress?: number
  status: 'pending' | 'uploading' | 'uploaded' | 'error'
  error?: string
  /** Discord-style spoiler: upload as `SPOILER_${filename}`. */
  spoiler?: boolean
}

const SPOILER_PREFIX = 'SPOILER_'

export function isSpoilerFilename(filename: string | null | undefined): boolean {
  return Boolean(filename?.startsWith(SPOILER_PREFIX))
}

export function stripSpoilerFilename(filename: string): string {
  return isSpoilerFilename(filename)
    ? filename.slice(SPOILER_PREFIX.length)
    : filename
}

/** File to upload — renames with SPOILER_ when marked. */
export function fileForUpload(pending: PendingComposerFile): File {
  if (!pending.spoiler) return pending.file
  const name = pending.file.name
  if (isSpoilerFilename(name)) return pending.file
  return new File([pending.file], `${SPOILER_PREFIX}${name}`, {
    type: pending.file.type,
    lastModified: pending.file.lastModified,
  })
}

export function createPendingFiles(fileList: FileList | File[]): PendingComposerFile[] {
  const files = Array.from(fileList)
  const next: PendingComposerFile[] = []

  for (const file of files) {
    if (!file.size) continue
    const spoiler = isSpoilerFilename(file.name)
    const entry: PendingComposerFile = {
      id: crypto.randomUUID(),
      file,
      status: 'pending',
      spoiler: spoiler || undefined,
    }
    if (file.type.startsWith('image/')) {
      entry.previewUrl = URL.createObjectURL(file)
    }
    next.push(entry)
  }

  return next
}

export function revokePendingFiles(files: PendingComposerFile[]) {
  for (const pending of files) {
    if (pending.previewUrl) {
      URL.revokeObjectURL(pending.previewUrl)
    }
  }
}
