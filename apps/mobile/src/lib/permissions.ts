import { PermissionsAndroid } from 'react-native'

/** Microphone (and the call notification) before joining voice. */
export async function requestCallPermissions() {
  const results = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
  ])
  return results[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === 'granted'
}

export async function requestCameraPermission() {
  return (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA)) === 'granted'
}
