import type { EventSubscription } from 'expo'

// Browsers have no foreground service or system picture-in-picture for the app.
export const CallService = {
  start(_title: string, _text: string) {},
  stop() {},
  setPictureInPicture(_enabled: boolean, _width: number, _height: number) {},
  isInPictureInPicture: () => false,
  addListener(_event: 'onPictureInPictureModeChanged', _listener: (event: { active: boolean }) => void): EventSubscription {
    return { remove() {} }
  },
}
