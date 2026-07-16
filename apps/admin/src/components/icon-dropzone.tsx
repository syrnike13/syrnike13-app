import { useCallback, useState } from 'react'

import { FolderPlusIcon } from '#/components/icons'
import { cn } from '#/lib/utils'

export function IconDropzone({
  file,
  previewUrl,
  onFileChange,
  disabled,
}: {
  file: File | null
  previewUrl?: string | null
  onFileChange: (file: File | null) => void
  disabled?: boolean
}) {
  const [dragging, setDragging] = useState(false)

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const next = files?.[0]
      if (!next) return
      if (!['image/png', 'image/webp'].includes(next.type)) return
      onFileChange(next)
    },
    [onFileChange],
  )

  return (
    <label
      className={cn(
        'group relative flex min-h-40 cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/80 bg-muted/20 px-4 py-6 text-center transition-colors',
        'hover:border-primary/35 hover:bg-muted/35',
        dragging && 'admin-dropzone-active border-primary/45 bg-primary/5',
        disabled && 'pointer-events-none opacity-50',
      )}
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        handleFiles(event.dataTransfer.files)
      }}
    >
      {previewUrl ? (
        <img src={previewUrl} alt="" className="size-16 object-contain" />
      ) : (
        <span className="flex size-12 items-center justify-center rounded-lg border border-border/70 bg-card text-muted-foreground">
          <FolderPlusIcon className="size-5" aria-hidden />
        </span>
      )}
      <span className="max-w-[16rem] text-xs leading-relaxed text-muted-foreground">
        {file ? file.name : 'PNG или WebP · перетащите или нажмите'}
      </span>
      <input
        type="file"
        accept="image/png,image/webp"
        className="sr-only"
        disabled={disabled}
        onChange={(event) => handleFiles(event.target.files)}
      />
    </label>
  )
}
