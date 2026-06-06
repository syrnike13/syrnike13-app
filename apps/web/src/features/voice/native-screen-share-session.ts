type NativePickerResolver = {
  resolve: (sourceId: string) => void
  reject: (error: Error) => void
}

let pendingPicker: NativePickerResolver | null = null

export function waitForNativePickerSelection() {
  return new Promise<string>((resolve, reject) => {
    pendingPicker = { resolve, reject }
  })
}

export function resolveNativePickerSelection(sourceId: string) {
  pendingPicker?.resolve(sourceId)
  pendingPicker = null
}

export function rejectNativePickerSelection(error: Error) {
  pendingPicker?.reject(error)
  pendingPicker = null
}

export function clearNativePickerSelection() {
  pendingPicker = null
}
