export type PendingComposerFile = {
  id: string
  file: File
  previewUrl?: string
}

export function createPendingFiles(fileList: FileList | File[]): PendingComposerFile[] {
  const files = Array.from(fileList)
  const next: PendingComposerFile[] = []

  for (const file of files) {
    if (!file.size) continue
    const entry: PendingComposerFile = {
      id: crypto.randomUUID(),
      file,
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
