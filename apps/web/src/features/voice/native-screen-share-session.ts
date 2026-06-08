import type { DesktopDisplayMediaSelection } from '@syrnike13/platform'

type NativePickerResolver = {
  resolve: (selection: DesktopDisplayMediaSelection) => void
  reject: (error: Error) => void
}

let pendingPicker: NativePickerResolver | null = null

export function waitForNativePickerSelection() {
  return new Promise<DesktopDisplayMediaSelection>((resolve, reject) => {
    pendingPicker = { resolve, reject }
  })
}

export function resolveNativePickerSelection(
  selection: DesktopDisplayMediaSelection,
) {
  pendingPicker?.resolve(selection)
  pendingPicker = null
}

export function rejectNativePickerSelection(error: Error) {
  pendingPicker?.reject(error)
  pendingPicker = null
}

export function clearNativePickerSelection() {
  pendingPicker = null
}
