import type { DesktopDisplayMediaSelection } from '@syrnike13/platform'

type NativePickerResolver = {
  resolve: (selection: DesktopDisplayMediaSelection) => void
  reject: (error: Error) => void
}

let pendingPickers: NativePickerResolver[] = []

export function waitForNativePickerSelection() {
  return new Promise<DesktopDisplayMediaSelection>((resolve, reject) => {
    pendingPickers.push({ resolve, reject })
  })
}

export function resolveNativePickerSelection(
  selection: DesktopDisplayMediaSelection,
) {
  const pickers = pendingPickers
  pendingPickers = []
  for (const picker of pickers) {
    picker.resolve(selection)
  }
}

export function rejectNativePickerSelection(error: Error) {
  const pickers = pendingPickers
  pendingPickers = []
  for (const picker of pickers) {
    picker.reject(error)
  }
}

export function clearNativePickerSelection() {
  rejectNativePickerSelection(new Error('Screen share picker cleared'))
}
